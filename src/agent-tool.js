/**
 * 造书工作台 · 对话侧工具（agent 预设行）
 *
 * 让"造书模式"的主笔 AI 真正执行流水线：
 *  - workbench_status：只读，查看当前进度/交办任务/关卡/材料/抽查意见/章节状态
 *  - workbench_act：
 *       · stage-brief   —— 领取机器派给主 AI 的阶段任务（说明 + 方法论 + 产物要求）
 *       · stage-submit  —— 交工（机器逐项验货，合格才放行）
 *       · progress      —— 上报进度（工作台状态卡实时显示）
 *       · 其余为用户代操作（改名/改目标/建书/拍板/回退/重试/删除），
 *         人设要求"用户明确同意后才调用"。
 *
 * 通过本地 webServer 的 /textbook/* 接口与宿主交互（与前端同一通道）。
 * 不 import @deepseek-ai/dsh-tools：agent 上下文可能解析不到，这里自带
 * 参数简写 → JSON Schema 的转换（与 defineTool 等价的最小实现）。
 */
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { CHAPTER_PROGRESS_STAGES, convertedState } from './domain-rules.js'
import { resolveAgentAction, listAgentActionInputs } from './contract-actions.js'
import { artifactDataForGate } from './workflow/artifact-fields.js'

// ── `action` 取值的**枚举骨架从契约面动作目录派生**（票 `deep-module-scan/14`）───────────────
//
// 病：一个工具里并存两份动作清单。顶层 `description` 是提到 28 项的**散文**，而 `action`
// 参数那一格（**模型选值时真正读的那一格**）曾是一份**手写的 16 项**枚举——目录有 28 个
// `agentInput`，两份清单之间**零闭包检查**，目录加一个动作它不会自己长出来。
//
// 「**派生骨架 + 手写散文注解**」两段，注解**留在原处、不在这里重抄**：
//   · 骨架 = 下面这个 join（今天 31 项，逐字来自 `agentCallable` 全集）；
//   · 注解 = 工具顶层 `description` 里的两类用法与各动作语义 ＋ 下面各字段自己的说明。
// ⚠️ **不要把它改成别的东西**：派生让「漏抄」不可能，但那**不替代**闸门——
//   `test-agent-tool.mjs` 读**注册后的 def**（不是源码文本）断 31 项闭包，
//   有人把手写的换回去、或目录加了动作，那道闸当场红。派生与闸门**两道都要**。
// ⚠️ 走查票 09（2026-10-06）另补了**反方向**那一道：描述里**点名的**动作，要么在闭包里、
//   要么在同一处明写「需用户操作，AI 不可调用」——「gold 定稿类」那种含糊点名就是漏过
//   它的形状（同一份判据也在 `test-agent-tool.mjs`）。
const AGENT_ACTION_NAMES = Object.freeze([...listAgentActionInputs()])

/**
 * `stage-brief`/`stage-submit` 的阶段名 —— **本文件内一处**（票 `deep-module-scan/14`）。
 *
 * ⚠️ 它此前在本文件里**逐字写了两遍**：`:275` 的参数描述与 `:394` 的早退文案各一份。
 * 改一处忘另一处，模型看到的两句话就会对不上。
 *
 * ⚠️ **它还不是权威源**：交办的 7 个阶段名在 `domain-rules.js` 里**没有**一份可共享的
 *   声明——`engine.js` 的 `STAGE_LABELS` 只有 6 个（`gate` 被 `stageLabel()` 特判走另一条
 *   路），而 `CHAPTER_PROGRESS_STAGES` 是**章节流水线那 5 个**、不是这一套。所以本票
 *   只做**纯去重**（票面评它「本票里最零风险的一条」），**不假装**这里就是权威。
 *   要把它提到 `domain-rules.js`，得先定「`gate` 在不在交办阶段表里」这个问题——
 *   那是一次**归属决定**，不是一次去重。
 */
const ACT_STAGES = Object.freeze(['explore', 'gate', 'outline', 'gold', 'chapters', 'merge', 'final'])
const ACT_STAGE_ENUM = ACT_STAGES.join('|')

export const name = 'textbook-agent-tool'
export const inject = ['tools']

/** 诊断日志：设置 TEXTBOOK_TOOL_DEBUG=1 时写入 $DSH_HOME/tool-debug.log。 */
function debugLog(payload) {
  try {
    if (typeof process === 'undefined' || process.env === undefined || process.env.TEXTBOOK_TOOL_DEBUG !== '1') return
    const home = process.env.DSH_HOME
    if (typeof home !== 'string' || home === '') return
    appendFileSync(join(home, 'tool-debug.log'), `${new Date().toISOString()} ${JSON.stringify(payload)}\n`)
  } catch { /* 诊断失败不影响功能 */ }
}

/** 参数简写（{ key: {type, required?, description?, enum?, items?} }）→ JSON Schema。 */
function shorthandToJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, def] of Object.entries(spec ?? {})) {
    const prop = { type: def.type }
    if (def.description !== undefined) prop.description = def.description
    if (def.enum !== undefined) prop.enum = def.enum
    if (def.items !== undefined) prop.items = def.items
    properties[key] = prop
    if (def.required === true) required.push(key)
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  }
}

/** 与 defineTool 等价的最小注册形态。 */
function defineToolLocal(options) {
  const userExecute = options.execute
  const userRender = options.output.render
  return {
    name: options.name,
    description: options.description,
    parameters: shorthandToJsonSchema(options.parameters),
    output: {
      schema: options.output.schema,
      render(args, value) { return userRender(args, value) },
    },
    async execute(args, exec) { return userExecute(args, exec) },
  }
}
function resolveBaseUrl(config) {
  if (typeof process !== 'undefined' && process.env !== undefined) {
    const env = process.env.DSH_WEB_URL
    if (typeof env === 'string' && env.trim() !== '') {
      const clean = env.trim().replace(/\/+$/, '')
      if (/^https?:\/\//.test(clean)) return clean
    }
  }
  if (config !== undefined && typeof config.baseUrl === 'string' && config.baseUrl.trim() !== '') {
    return config.baseUrl.trim().replace(/\/+$/, '')
  }
  return 'http://127.0.0.1:3080'
}

/**
 * 协作动作的本地预校验：不联网即可拦下明显错参（也便于测试；错误信息要能指导 AI 下一步怎么引导用户）。
 * 这是协作动作参数的**单一校验落点**：execute switch 只负责组 body、不再重复校验——改参数规则只改这一处。
 */
function preValidate(actionName, args) {
  const need = (cond, msg) => { if (!cond) throw new Error(msg) }
  switch (actionName) {
    case 'style-note':
      need(typeof args.text === 'string' && args.text.trim() !== '', 'style-note 需要 text（风格意见内容）')
      break
    case 'intervene':
      need(typeof args.text === 'string' && args.text.trim() !== '', 'intervene 需要 text（留言内容）')
      break
    case 'waive':
      need(typeof args.item === 'string' && args.item !== '', 'waive 需要 item（豁免项）')
      need(typeof args.userNote === 'string' && args.userNote.trim() !== '',
        '豁免必须由用户手输原因（userNote）才能放行；请用户在对话里直接说明，你转交后再调用')
      break
    case 'style-note-revoke':
    case 'waive-revoke':
    case 'intervene-done':
    case 'gold-opinion-revoke':
      need(typeof args.id === 'string' && args.id !== '', `${actionName} 需要 id`)
      break
    case 'gold-opinion':
      need(['dislike', 'drop', 'change'].includes(args.kind), 'gold-opinion 需要 kind（dislike|drop|change）')
      need(typeof args.wish === 'string' && args.wish.trim() !== '', 'gold-opinion 需要 wish（一句话说明）')
      break
    case 'gold-chapter-set':
      need(Number.isSafeInteger(Number(args.chapter)) && Number(args.chapter) >= 1, 'gold-chapter-set 需要 chapter（目标样例章章号，1 基）')
      break
    case 'outline-confirm':
      need(typeof args.approved === 'boolean', 'outline-confirm 需要 approved（true/false）')
      break
    case 'explore-confirm':
      // 走查票 09：探查结果确认（true=进设计；false=归档重做、可带一句哪里不满意）。
      // ⚠️ 这一格**必须**有：服务端 `gates.js` 那一支是 `body.approved === true`，
      // 缺参**静默按「驳回重做」**走——本地先拦，免得 AI 漏参把用户的探查结果归档掉。
      // ⚠️ code-review 规格轴 C1（2026-10-06）：这里**只断 `approved`**，`note` 是**可选**的
      // ——工作台那条路故意允许不填（`src/ui/confirm-cards.js` 逐字写着「不填也能重做」，
      // `client-entry.js` 也照旧发 `note: ""`）。所以**文案必须与这条实现等强**：
      // 原先那句「必带一句哪里不满意」是**声称比实现强**（code-review 对票 `walkthrough-2026-10/09` 的 C1）。
      // ⛔ 没有把它改成「真拦」：那要服务端也把 note 断成非空，等于**收掉一条界面已承诺的通路**。
      need(typeof args.approved === 'boolean', 'explore-confirm 需要 approved（true=满意继续，false=让 AI 重做；note 是可选的一句哪里不满意，不填也能重做）')
      break
    case 'gold-approve':
      // 走查票 09：范例章定稿确认（true=继续写全书；false=推翻重写）。
      need(typeof args.approved === 'boolean', 'gold-approve 需要 approved（true=定稿继续，false=推翻重写）')
      break
    case 'chapters-review-confirm':
      need(typeof args.approved === 'boolean', 'chapters-review-confirm 需要 approved（true=都过了，开始合并）')
      break
    case 'final-approve':
      need(typeof args.approved === 'boolean', 'final-approve 需要 approved（true=认可最后检查结果，交付；false=驳回，需 note）')
      if (args.approved === false) need(typeof args.note === 'string' && args.note.trim() !== '', 'final-approve approved=false 需要 note（对整本书的改进意见）')
      break
    case 'deep-modify':
      need(typeof args.segment === 'string' && args.segment !== '', 'deep-modify 需要 segment（历史段 key，如 outline/chapter-2）')
      need(typeof args.note === 'string' && args.note.trim() !== '', 'deep-modify 需要 note（这次要改什么）')
      break
    case 'audit-submit':
      // 不带 auditJson 就验书里那份 工作区/audit-NN.md；带了必须是 JSON 字符串（服务端按字符串判真假）。
      need(args.auditJson === undefined || typeof args.auditJson === 'string',
        'audit-submit 的 auditJson 必须是 JSON 字符串（或省略——机器直接验书里的 工作区/audit-NN.md）')
      break
    case 'chapter-assemble':
      // 票 `walkthrough-2026-10/02`：机器拼章正文。缺 chapter 本地就拦（一个请求都不发）。
      need(Number.isSafeInteger(Number(args.chapter)) && Number(args.chapter) >= 1,
        'chapter-assemble 需要 chapter（让机器拼第几章的正文，1 基）')
      break
    default:
      break
  }
}

async function fetchJson(fetchImpl, url, options) {
  debugLog({ stage: 'fetch', url })
  let res
  try {
    res = await fetchImpl(url, options ?? { headers: { Accept: 'application/json' } })
  } catch (error) {
    debugLog({ stage: 'fetch-error', url, message: String(error?.message ?? error) })
    throw error
  }
  let json = null
  try { json = await res.json() } catch { json = null }
  debugLog({ stage: 'fetch-done', url, status: res.status, json })
  if (!res.ok) throw new Error((json !== null && typeof json.error === 'string' ? json.error : '') || `HTTP ${res.status}`)
  return json
}

function sessionIdOf(exec) {
  const id = exec?.agent?.session?.id
  if (typeof id !== 'string' || id === '') throw new Error('拿不到当前会话，请确认在造书模式会话里使用')
  return id
}

function renderText(args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 1) }]
}

// ── `workbench_status` 按工序切片（票 `context-budget/09` · spec 实现决策 15）──────────────
//
// 病：这一份返回把整本书的快照每次都整份回给主笔 AI。15 次调用的回包**正文**合计 70,178 字符，
// 而单次最大那一回里「整份关卡方案」与「整份自查报告」两件**一旦定下就不再变**的东西占了
// 65.6%–66.5%。数字与三档口径（正文／整条消息／字段级 pretty+compact）见
// `.scratch/context-budget/evidence/workbench-status-session-98d830e6.json`。
//
// 下面三件事各改一刀：**大件改指针**（`gateDetailPointer`）、**按工序投影**（`STATUS_SLICE`）、
// **顺手按条目状态过滤**（`liveItems`）。其余 19 个键常驻。
//
// ⚠️ **判定用阶段号，不用 `pendingStage`**：后者只是「机器此刻派了哪一步活」，等用户拍板／
//   等机器跑的时候它是 null，而切片要答的是「这本书现在走到哪一段」——阶段号在那一刻照样在
//   （六阶段的权威表是 `domain-rules.PHASES`，状态返回里已有 `project.phase`）。
const STATUS_SLICE = Object.freeze([
  { key: 'sources', phases: [1, 2], why: '材料清单只在材料准备／读材料挑重点这两段要用来派精读；后面几段的交办说明自己带 `materials`' },
  { key: 'pendingReviews', phases: [5], why: '要销号的工序是章交工（写完整本），机器也只在这一步按 status 为 pending 的那批拦' },
  { key: 'styleNotes', phases: [6], why: '要交代去向的工序是最后检查，机器也只在这一步按 status 为 active 的那批拦' },
])

/** 当前阶段用不用某个切片键。表里没有登记的键一律当常驻键（漏登记＝照旧给，不是照旧不给）。 */
function sliceIncludes(key, phase) {
  const row = STATUS_SLICE.find((entry) => entry.key === key)
  return row !== undefined && row.phases.includes(phase)
}

/**
 * 按条目 `status` 取「还活着的那一批」。
 *
 * ⚠️ **过滤只能按条目状态，不能按「读过没读过」**：`ADR-0010` 明写状态面永远不会有
 * 「用户看没看过」字段，全仓也没有读取游标 ⇒ 引入「已读」语义就是凭空造一个不存在的事实。
 */
function liveItems(list, status) {
  return (Array.isArray(list) ? list : []).filter((item) => item?.status === status)
}

/**
 * 关卡方案改**指针**：路径 ＋ 字符数，不再把整份 Markdown 内联回主笔 AI 的上下文。
 *
 * 路径**不在本文件手写**——它从 `artifactDataForGate`（账本事件产物字段的单一出处）派生，
 * 再拼到读通道随包给的那个真实书夹目录上，所以主笔 AI 可以直接拿它去 `read` 全文。
 * ⚠️ 拿不到书夹目录、或提案号／版次不成形状（老书／坏数据）时给 `null`：
 *   返回一个自己并不存在的地址，比不给更坏（那正是「指针指向不存在的文件」这个病的形状）。
 */
function gateDetailPointer(gate, bookDir) {
  const text = typeof gate.detail === 'string' ? gate.detail : ''
  if (text === '') return null
  if (typeof bookDir !== 'string' || bookDir === '') return null
  const { path: rel } = artifactDataForGate(gate.gate, gate.version)
  if (rel === undefined) return null
  return { path: join(bookDir, rel).replace(/\\/g, '/'), chars: text.length }
}

/**
 * 最后检查的自查报告改**指针** ＋ 摘要（票 `context-budget/12` · 承接票 `09` 让出的那一步）。
 *
 * ⚠️ **顺序不能反**（票 09 的原话）：这份指针指向的是**机器拼出来的那份条目并集**，
 * 落盘发生在 `stage-submit final`／`stage-brief` 两个面（`final-audit-summary.js`）——
 * 票 09 若先改，它会指向一个还不存在的文件。
 *
 * 三档形状，**逐档说清**（判据逐条点名，不合并成一句「形状不对」）：
 * · `null` —— 还没到最后检查这一步（`meta.finalReport` 是空的）。
 * · 指针 —— `{ path, chars, summary }`。`path` 是**书夹相对路径**（逐字取自
 *   `domain-rules.finalAuditSummaryRel`，本文件不手写文件名）；`chars` 是那份文件的字符数；
 *   `summary` 是人话摘要（**不含全文**）。
 * · 老书那一档 —— 票 12 之前 `meta.finalReport` 是**整份全文字符串**。那一份全文仍在账本事件
 *   `textbook/ai-report` 里（那本来就是展示面的来源），所以这里给一个 `path: null` 的指针 ＋ 一句
 *   「全文在账本事件里」的摘要，**不把老书那份全文又内联回上下文**——那正是这一刀要砍掉的东西。
 *
 * @param unknown stored `meta.finalReport`
 * @returns {{path: string|null, chars: number|null, summary: string}|null}
 */
function finalReportPointer(stored) {
  if (stored === null || stored === undefined) return null
  if (typeof stored === 'object' && !Array.isArray(stored)) {
    const path = typeof stored.path === 'string' && stored.path !== '' ? stored.path : null
    const chars = Number.isSafeInteger(stored.chars) ? stored.chars : null
    const summary = typeof stored.summary === 'string' ? stored.summary : ''
    return { path, chars, summary }
  }
  return {
    path: null,
    chars: null,
    summary: '最后检查自查报告（这本书交工时还没有拼装条目并集那份；全文在账本事件里）',
  }
}

/** 从 events 接口取项目详情（含交办/章节/探查摘要等）。 */
async function fetchProjectDetail(fetchImpl, base, sessionId, projectId) {
  return fetchJson(
    fetchImpl,
    `${base}/textbook/events?session=${encodeURIComponent(sessionId)}&project=${encodeURIComponent(projectId)}`)
}

/**
 * 注册本插件的工具行。
 *
 * @param ctx 宿主 ctx（只读 `ctx.tools`）。
 * @param config 宿主给的配置；`baseUrl` 是**回落链的一环**，不是唯一出处。
 * @param deps **internal seam**（票 `deep-module-scan/17`）：`deps.fetchImpl` 让测试把自己那张
 *   传输递进来，而不是替换 `globalThis.fetch`。**不进任何 caller 要知道的 interface**——
 *   照 `src/ui/artifact-read.js:35-36` 的既有口径（`createArtifactReader({ fetchImpl })`）。
 *
 *   ⚠️ **`resolveBaseUrl` 的优先级链原样保留**（`DSH_WEB_URL` > `config.baseUrl` > 回落
 *   `http://127.0.0.1:3080`）：那是既有行为，本票只是**多一条可注入的传输**，不碰地址怎么来。
 *
 *   ⚠️ **每次调用时才解析 transport**，不是在 `apply` 里抓一次：那才是今天的行为
 *   （`fetch(...)` 读的是**调用那一刻**的全局）。若在这里抓一次引用，`apply` 之后才替换
 *   `globalThis.fetch` 的那批测试会全部失灵——而那正是本仓最常见的那种替换。
 */
function apply(ctx, config, deps) {
  const base = resolveBaseUrl(config)
  const transport = (url, options) => (deps?.fetchImpl ?? globalThis.fetch)(url, options)

  ctx.tools.register(defineToolLocal({
    name: 'workbench_status',
    description: '查看造书工作台当前的真实状态：有没有书、进行到第几步、机器在等谁、当前交给你 AI 的任务（pendingStage）、是否在等你拍板、抽查意见、各章进度、书文件夹在哪。回答用户关于"现在进行到哪一步/面板上是什么"的问题前必查（尤其交工前查一遍有没有新抽查意见），不要凭记忆猜。⚠️ 返回按**当前工序**切片：sources 只在材料准备／读材料挑重点给，pendingReviews 只在写完整本给，styleNotes 只在最后检查给——某个键缺席说明这一段用不到它，不是读取失败，也不要为了找它反复调本工具。gate.detail 是指针（{path, chars}），要方案全文自己 read 那个 path。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: renderText,
    },
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      debugLog({ stage: 'status-start', base, sessionId, agent: exec?.agent?.id ?? exec?.agent?.session?.id })
      const list = await fetchJson(transport, `${base}/textbook/projects?session=${encodeURIComponent(sessionId)}`)
      const projects = list.projects ?? []
      debugLog({ stage: 'status-projects', count: projects.length })
      if (projects.length === 0) {
        const out = { hasBook: false, sessionId, message: '这个会话还没有书，工作台已打开建档向导（书名 + 学习目标必填），引导用户在向导里建书或先建演示书。' }
        debugLog({ stage: 'status-return', out })
        return out
      }
      const meta = projects[0]
      const detail = await fetchProjectDetail(transport, base, sessionId, meta.id)
      const events = detail.events ?? []
      const last = events.length > 0 ? events[events.length - 1] : null
      const gate = detail.gate ?? null
      const bookDir = detail.dir ?? null
      const phase = Number.isSafeInteger(meta.phase) ? meta.phase : 1
      return {
        hasBook: true,
        sessionId,
        project: {
          id: meta.id,
          name: meta.name,
          goal: meta.goal ?? '',
          phase,
          status: meta.status ?? 'active',
          route: meta.route ?? 'blueprint',
          science: meta.science === true,
          folder: meta.folder ?? null,
          dir: bookDir,
        },
        // 切片 ①：材料清单只在材料准备／读材料挑重点（理由见 STATUS_SLICE）。
        ...(sliceIncludes('sources', phase) ? {
          sources: (meta.sources ?? []).map((source) => ({
            file: source.file,
            role: source.role ?? '',
            // 三值枚举投影（票 `mineru-formats/02`）：主笔 AI 看得见「转失败了」这件事，
            // 不再像从前那样只拿到一个「转没转成」的真假。老书布尔由 convertedState 只读归一。
            converted: convertedState(source),
          })),
        } : {}),
        // 机器在等谁：pendingStage != null → 等你 AI 动手；awaiting-explore/awaiting-gold/awaiting-chapters-review/awaiting-final-approval → 等用户；关卡 awaiting → 等用户拍板。
        pendingStage: detail.pendingStage ?? null,
        pendingGate: detail.pendingGate ?? null,
        stageLabel: detail.pendingStage ?? null,
        awaitingUser: ['awaiting-explore', 'awaiting-gold', 'awaiting-chapters-review', 'awaiting-final-approval'].includes(meta.status)
          || (gate !== null && gate.status === 'awaiting'),
        gate: gate === null ? null : {
          gate: gate.gate,
          version: gate.version,
          status: gate.status,
          title: gate.title ?? '',
          // 摘要原样保留：它就是给「要不要读全文」这一句判断用的（票 09 决策 15「大件改摘要＋路径」）。
          summary: gate.summary ?? '',
          // 方案全文改指针 `{ path, chars }`（票 09）：要全文自己 `read` 那个路径。
          detail: gateDetailPointer(gate, bookDir),
          awaiting: gate.status === 'awaiting',
          rejected: gate.status === 'rejected',
          reasons: gate.decision?.reasons ?? [],
          note: gate.decision?.note ?? '',
        },
        // 切片 ②：抽查意见只在写完整本（要销号的那一步），且只给**待处置**那批。
        ...(sliceIncludes('pendingReviews', phase) ? {
          pendingReviews: liveItems(detail.pendingReviews, 'pending'),
        } : {}),
        chapterStatus: Array.isArray(detail.chapterStatus) ? detail.chapterStatus : [],
        exploreSummary: detail.exploreSummary ?? null,
        // ⚠️ `finalReport` **已指针化**（票 `context-budget/12` 承接票 `09` 让出的那一步）：
        // 回包只给「路径 ＋ 字符数 ＋ 摘要」，要全文自己去 `read` 那个路径。
        // 指向的是**机器拼的那份条目并集**（五份分查的点名条目，去重不丢不重），
        // 不是自查报告本身——自查报告全文随交工上送、逐字进账本事件 `textbook/ai-report`，
        // 而给用户看的那份仍然是五份的汇总（`CONTEXT.md`「终检结果认可」，用户故事 36）。
        finalReport: finalReportPointer(detail.finalReport ?? null),
        lastEvent: last === null ? null : { type: last.type, text: last.data?.text ?? last.data?.label ?? last.data?.title ?? '' },
        paused: detail.meta?.pause != null ? { ...detail.meta.pause } : null,
        // 票 dsh-contract-drift/01 的载体：**按下暂停时还有几条子会话在跑**这个事实（暂停那一刻记下的）。
        // 只有那个数，不含名字/编号——要看是哪几个，你自己有 list_agents。
        // ⚠️ 票 `chapter-audit-orchestration/04` 查实的口径：这个数**比「小助手」宽**——它**含编排脚本
        // 的成员**（脚本成员在宿主的 `listDescendants` 眼里与小助手同形：同 `parentSession`、
        // 同 `origin: 'subagent'`、活的时候同 `activity: 'running'`），而 `interrupt_agent` 对脚本成员
        // 是**静默空操作**。票 04 起暂停自己会 kill 掉那些脚本（连带 abort 成员），所以对着这个数去
        // `list_agents` 时看到脚本成员**不必**去收（口径见 `CONTEXT.md`「暂停」词条）。它记的是
        // kill **之前**那一刻的数（「先数、再 kill」是口径的一部分）。
        // 取值只有两种：**0**＝数出来了、确实一条都没在跑；**null**＝没暂停过，或**当时数不出来**
        // （宿主小助手服务缺席 / 调用抛错，见 `workflow/actions/collab-signals.js` 的 `countRunningSubagents`）。
        // 拿不准就查一遍 `list_agents`，别把「没显示」当「没有」。
        // ⚠️ 它**常驻**：暂停时该不该收回小助手是判据，票 09 的切片不许碰它（handoff §5.4 第 ③ 条）。
        pausedSubagentsRunning: detail.meta?.pause?.subagentsRunning ?? null,
        // 切片 ③：风格线只在最后检查（要逐条交代去向的那一步），且只给**生效中**那批——
        // 机器的终检验货也是按 `status === 'active'` 点名要交代的那几条（`chapters.js` 的 final 分支），
        // 两边同口径，AI 照这一份点名就够。`superseded`（用户收回）与已翻转的 `adopted`／`conflict` 挡掉。
        ...(sliceIncludes('styleNotes', phase) ? {
          styleNotes: liveItems(detail.meta?.styleNotes, 'active')
            .map((n) => ({ id: n.id, text: n.text, status: n.status, note: n.note ?? null })),
        } : {}),
        waivers: detail.meta?.waivers ?? [],
        // ⚠️ 留言**常驻**：它是「许愿级的协作信号」，交办说明（brief.hints）在铺章与最后检查两段
        // 都要靠它提醒「先处理再继续」（`engine.js` 的两处 hint），而那是状态返回之外的载体。
        // 读通道那一侧已经按 `status === 'pending'` 过滤过（`workflow.js` 的 `/textbook/events`），
        // 本工具原样透传，不自己再写一份口径。
        pendingInterventions: detail.pendingInterventions ?? [],
        outline: { awaiting: detail.meta?.status === 'awaiting-outline', redoNote: detail.meta?.outlineRedoNote ?? null },
        gold: {
          awaiting: detail.meta?.status === 'awaiting-gold',
          opinions: (detail.meta?.goldOpinions ?? []).filter((o) => o.status !== 'revoked'),
          sealed: detail.meta?.goldSealed ?? null,
        },
        // 全章过目闸门（F18）：全章写完后等用户过目；chaptersReviewed 旧书无字段按 false 兜底。
        chapters: {
          awaitingReview: detail.meta?.status === 'awaiting-chapters-review',
          reviewed: (detail.meta?.chaptersReviewed ?? false) === true,
        },
      }
    },
  }))

  ctx.tools.register(defineToolLocal({
    name: 'workbench_act',
    description: '与造书工作台交互。两类用法：① 流水线内务（机器派给你的活）：stage-brief 领任务说明、progress 上报进度、audit-submit 把范例章审计结论交给机器即时验形状、chapter-assemble 让机器把这一章的分片拼成正文（写作小助手只落分片，章正文由机器拼；**派审计小助手之前**先叫这一步，审计读的就是拼出来的那一份）、stage-submit 交工——这几类直接调用，不需要征求用户同意；② 代用户操作（改书名/改目标/建书/拍板/探查确认/范例章定稿/回退/重试/删除/最后检查认可）——仅在用户明确同意后调用。action 取值：stage-brief、stage-submit、progress、chapter-assemble、audit-submit（真实模式下，范例章审计结论落盘后先交这里：机器当场验 5 个必读文件各一行 {file, quote} 与 quote 逐字、passed 判定，不合格当场把机器看到的行键/样例/缺口说清；可带 auditJson 正文由机器落盘，不带就验书里那份 工作区/audit-NN.md）、create（建书，需 name/goal，可选 route/science）、rename（改书名，需 name）、set_goal（改学习目标，需 goal）、gate（拍板，需 gate/version/approved，可选 note）、rollback（回退，需 snapshot 序号）、resume（重试/继续）、delete（删除这本书）。协作动作：style-note（记风格线）、intervene（留言）、pause（暂停）、nudge（催办：把用户一句话以 notice 唤醒主 AI，不中断不 cancel）为内务可直接调用；waive（豁免，必须先引导用户在界面手输原因）、explore-confirm（探查结果确认：用户在探查结果卡点「满意，继续设计」时用，需 approved=true；approved=false 是让 AI 重做，**可带**一句哪里不满意（note，可选——用户在工作台里就是「勾个理由或写一句，不填也能重做」））、outline-confirm、chapters-review-confirm（全章过目确认：全章写完后替用户点「都过了」时用，需 approved=true）、final-approve（最后检查结果认可：最后检查全过后用户在最后检查结果卡点「认可/不满意」时用，需 approved=true/false；approved=false 必须带 note 改进意见）、gold-opinion/gold-revise/gold-chapter-set/gold-approve（范例章定稿确认：用户在谈判桌点「确认，定稿」时用，需 approved=true/false；approved=false 是推翻重写）必须用户明确同意后调用。以下动作需用户操作，AI 不可调用：review、review-revoke、gold-target-words-set（抽查／撤销抽查／定每章目标字数）——它们只在工作台界面由用户自己点。定点修改（改历史）：deep-modify（用户在界面上点定点修改时走这条，需 segment/note）、deep-undo（撤销最近一次深改）；对话里用户说改历史也必须引导走工作台的定点修改流程，不要自己改账本或产物。',
    parameters: {
      action: {
        type: 'string', required: true,
        // 31 项**逐字从契约面动作目录派生**（见文件头那节）。两个用法分两类、每个动作要带哪些
        // 参数，见工具顶层说明与下面各字段自己的说明——**枚举那一格不重抄一遍**。
        description: `${AGENT_ACTION_NAMES.join(' | ')} —— 共 ${AGENT_ACTION_NAMES.length} 项，逐字取自契约面动作目录（contract-actions.js 里 agentCallable 的全集）；每个动作该带哪些参数见下面各字段说明。`,
      },
      stage: { type: 'string', description: `stage-brief/stage-submit 用的阶段名：${ACT_STAGE_ENUM}；progress 时（写完整本阶段可选）：本章流水线阶段 ${CHAPTER_PROGRESS_STAGES.join('|')}` },
      segment: { type: 'string', description: 'deep-modify 时：要定点修改的历史段 key（explore|gate-1|gate-2|gate-3|outline|gold|chapter-N|merge|final）' },
      // —— stage-submit 各阶段的交付内容 ——
      title: { type: 'string', description: '交工 gate 时：一句话标题' },
      summary: { type: 'string', description: '交工 gate 时：给用户看的人话摘要（约 300 汉字以内；软目标，机器不验字数）' },
      detail: { type: 'string', description: '按动作取义：交工 gate（stage-submit）时必填——完整方案 Markdown（detail 内联全文，禁止写「见文件/proposal-*.md」指针，用户只在页面上看方案）；progress 时可选——更细的一句话说明' },
      // —— stage-submit explore 的交付内容（票 `context-budget/17`：合并件改机器拼装，主笔只交书级两件）——
      teachingFocus: {
        type: 'array',
        items: { type: 'string' },
        description: '交工 explore 时：书级的教学重点/难点，一条一句纯字符串（如「重点：分数运算」「难点：应用题建模」）。机器把它叠进 工作区/knowledge-map.json——合并件由机器按各分片拼装，你不用交它；这一件只有你能产出。',
      },
      chapterSuggestion: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            source: { type: 'string' },
            points: { type: 'array', items: { type: 'string' } },
          },
          required: ['title'],
          additionalProperties: false,
        },
        description: '交工 explore 时：书级的章节建议 [{title, source, points}]（4-10 章；points 是知识点 id）。机器把它叠进 工作区/knowledge-map.json；这一件只有你能产出。',
      },
      chaptersJson: { type: 'string', description: '交工 outline 时：JSON 数组字符串 [{"title":"…","outline":"…","source":"资料N：…","targetWords":6000,"points":["知识点…"],"volumeReason":"体量依据"}]' },
      goldChapter: { type: 'number', description: '交工 outline 时：建议的样例章章号（1 基，默认 1）；outline-confirm 时：用户改选的样例章章号' },
      goldChapterReason: { type: 'string', description: '交工 outline 时：一句理由（哪章最能代表全书风格/结构最完整/材料最充分）' },
      chapter: { type: 'number', description: '交工 chapters 时：第几章；chapter-assemble 时：让机器拼第几章的正文（分片落齐之后、派审计小助手之前叫它）；gold-chapter-set 时：目标样例章章号（1 基）；progress 时：正在汇报的是第几章（1 基，与 stage 一起进章节流水线账本，工作台章节卡显示流水灯）；交工 chapters 时机器验该章 audit-NN.md 的 passed===true、无未处置抽查意见、无脚手架残留才放行' },
      handledReviews: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'string' }, how: { type: 'string' } },
          required: ['id', 'how'],
          additionalProperties: false,
        },
        description: '交工 chapters 时：本回合处置过的本章抽查意见，逐条点名 [{id: 意见 id（见 workbench_status 的 pendingReviews / brief.pendingReviews）, how: 一句人话说明这条你怎么处置的}]。机器只给点名的置为已处置，没点名的继续拦；该章意见未处置机器会拒收这章交工。',
      },
      preface: { type: 'string', description: '交工 merge 时：书的前言/使用说明（约 300 汉字，通俗；软目标，机器不验字数）。注意：交工 merge 前必须先有一个上下文干净的跨章审计小助手读完全部章做完跨章审计，把报告落盘 工作区/audit-cross.md（按 resources/references/subagent-prompts/cross-audit-prompt.md 派，那份模板里的四项核对每项都要有交代）——机器逐项验货才放行合并，缺项会 400 拒收并点名缺哪一项' },
      auditJson: { type: 'string', description: 'audit-submit 时：范例章审计 JSON 的正文（可省——省了就验书里已有的 工作区/audit-NN.md）。带了必须是一整份严格 JSON，机器验形状合格后由机器落盘；不合格当场 400，报错里带机器解析到的行键与样例、契约行形状与 5 个必读文件、以及差在哪一项' },
      report: { type: 'string', description: '交工 final 时：你的最后检查报告（人话）' },
      styleCheck: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            status: { type: 'string', enum: ['adopted', 'conflict', 'superseded'] },
            note: { type: 'string' },
            chapter: { type: 'string' },
          },
          required: ['id', 'status'],
          additionalProperties: false,
        },
        description: '交工 final 时：对每条生效中的风格线逐条交代去向 [{id: 风格线 id（见 workbench_status 的 styleNotes 里 status 为 active 的）, status: adopted（已落实）/ conflict（与某章冲突）/ superseded（已不再适用）, note: conflict 必写一句冲突理由, chapter: 落实在哪章（可选）}]。漏一条机器会 400 拒收；一条风格线都没有时可以不传。',
      },
      // —— progress ——
      label: { type: 'string', description: 'progress 时：正在做什么（如「写第3章」）' },
      // —— 代用户操作 ——
      name: { type: 'string', description: 'create/rename 时的书名' },
      goal: { type: 'string', description: 'create/set_goal 时的学习目标' },
      route: { type: 'string', description: 'create 时：blueprint=给 AI 老师上课用（推荐），human=给人直接读的教材' },
      science: { type: 'boolean', description: 'create 时：理科内容（公式较多）为 true' },
      gate: { type: 'string', description: 'gate 时的拍板序号' },
      version: { type: 'number', description: 'gate 时的版本号' },
      approved: { type: 'boolean', description: 'gate 时：true=通过，false=驳回；explore-confirm 时：true=满意继续，false=让 AI 重做；chapters-review-confirm 时：true=全章都过了，开始合并；gold-approve 时：true=范例章定稿继续，false=推翻重写' },
      snapshot: { type: 'number', description: 'rollback 时回退到的快照序号' },
      // -- 协作动作 --
      text: { type: 'string', description: 'style-note/intervene 时：意见或留言内容；nudge 时：催办语（一句话，可省）' },
      source: { type: 'string', description: 'style-note 时：wizard|ui|chat（对话里识别的用 chat）' },
      id: { type: 'string', description: 'style-note-revoke/intervene-done/gold-opinion-revoke/waive-revoke 时：条目 id' },
      item: { type: 'string', description: 'waive 时：豁免项枚举（gate-skip 跳过「请你拍板」的设计环节 / outline-skip 跳过「章节安排」确认 / gold-skip 跳过「最佳范例章」确认 / audit-skip 不要求每章都有独立审查 / scaffold-keep 保留 AI 的笔记不删 / progress-skip 跳过「进度账本」检查 / other 其他）' },
      userNote: { type: 'string', description: 'waive 时：用户在界面手输的原因（放行必要条件）' },
      reason: { type: 'string', description: 'pause 时：中断原因（给账本与恢复上下文）' },
      target: { type: 'string', description: 'intervene 时：留言指向（如「第4章」）' },
      kind: { type: 'string', description: 'gold-opinion 时：dislike|drop|change' },
      wish: { type: 'string', description: 'gold-opinion 时：一句话说明' },
      para: { type: 'number', description: 'gold-opinion 时：段落序号（可省）' },
      hint: { type: 'string', description: 'gold-opinion 时：段落描述（如「开头那段」）' },
      note: { type: 'string', description: '按动作取义：gate 驳回时——驳回说明或备注；explore-confirm 驳回时——一句哪里不满意（可选；填了重做时 AI 会读到）；outline-confirm 驳回 / gold-revise 时——给 AI 的改进方向；deep-modify 时——这次要改什么（必填）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: renderText,
    },
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      const inputName = String(args.action ?? '')
      // 契约面动作目录（票 contract-actions/02）：主笔 AI 认哪 31 个输入名、哪 5 个是
      // 别名，全部由目录说了算，这里只做一次单向解析。别名只在主笔 AI 这一侧解析——
      // 目录里存在 canonical name 不会让工具多收一个输入名，HTTP 也不因此接受别名。
      const action = resolveAgentAction(inputName)
      if (action !== null) preValidate(action.name, args)
      const projects = await fetchJson(transport, `${base}/textbook/projects?session=${encodeURIComponent(sessionId)}`)
      const meta = (projects.projects ?? [])[0]
      // 建书是主笔 AI 能调的动作里唯一不需要已有书的那一个（目录的 projectScope 事实）。
      const createsBook = action?.projectScope === 'no-book'
      if (!createsBook && meta === undefined) {
        throw new Error('这个会话还没有书：要么先让用户在工作台建书，要么用 create 直接建')
      }
      const project = createsBook ? undefined : meta.id
      let body
      // 分支标签一律是规范动作名：主笔 AI 写下的输入名（create / rename / set_goal / gate /
      // delete 等 5 个别名）在上面已经单向解析过来，解析不出这个动作就进不了任何分支。
      switch (action?.name) {
        // ── 流水线内务（不需要征求用户同意） ─────────────────────────────
        case 'stage-brief':
          body = {
            action: 'stage-brief',
            ...(typeof args.stage === 'string' && args.stage !== '' ? { stage: args.stage } : {}),
          }
          break
        case 'progress':
          // 契约面审计（2026-08-26）：补转发 chapter/stage。之前只转 label/detail，
          // 后端 meta.chapterPipeline 永远收不到结构化数据（休眠），前端章节卡只能靠事件兜底推导。
          body = {
            action: 'progress',
            label: typeof args.label === 'string' ? args.label : '',
            detail: typeof args.detail === 'string' ? args.detail : '',
            ...(Number.isSafeInteger(Number(args.chapter)) && Number(args.chapter) >= 1
              ? { chapter: Number(args.chapter) }
              : {}),
            ...(CHAPTER_PROGRESS_STAGES.includes(args.stage)
              ? { stage: args.stage }
              : {}),
          }
          break
        case 'audit-submit':
          // 写入侧校验（票 audit-matrix-contract/01 (b)）：范例章审计结论先交这里让机器即时验形状。
          // 不带 auditJson 就验书里那份 工作区/audit-NN.md；带了原样转发进 HTTP 体，由服务端验并落盘。
          body = {
            action: 'audit-submit',
            ...(typeof args.auditJson === 'string' && args.auditJson.trim() !== '' ? { auditJson: args.auditJson } : {}),
          }
          break
        case 'chapter-assemble':
          // 票 `walkthrough-2026-10/02`：写作小助手只落分片，**章正文由机器拼**。
          // 主笔在「分片落齐之后、派审计小助手之前」叫这一步；chapter 必填（本地先拦一次，
          // 省一轮往返——服务端同样会拒一个不合法/不存在的章号）。
          if (!Number.isSafeInteger(Number(args.chapter)) || Number(args.chapter) < 1) {
            throw new Error('chapter-assemble 需要 chapter（让机器拼第几章的正文）')
          }
          body = { action: 'chapter-assemble', chapter: Number(args.chapter) }
          break
        case 'stage-submit': {
          const stage = String(args.stage ?? '')
          if (stage === '') throw new Error(`stage-submit 需要 stage（${ACT_STAGE_ENUM}）`)
          body = { action: 'stage-submit', stage }
          if (stage === 'explore') {
            // 票 `context-budget/17`：主笔只交**书级两件**（合并件由机器按各分片拼装，它不是交工输入）。
            // 两件都要非空：本地先拦一次，省一轮往返，并把「该交什么」当场说清（服务端同样 400）。
            if (!Array.isArray(args.teachingFocus) || args.teachingFocus.length === 0) {
              throw new Error('交工 explore 需要 teachingFocus（书级教学重点/难点，纯字符串一条一句）')
            }
            if (!Array.isArray(args.chapterSuggestion) || args.chapterSuggestion.length === 0) {
              throw new Error('交工 explore 需要 chapterSuggestion（书级章节建议 [{title, source, points}]，4-10 章）')
            }
            body.teachingFocus = args.teachingFocus
            body.chapterSuggestion = args.chapterSuggestion
          } else if (stage === 'gate') {
            if (typeof args.title !== 'string' || args.title.trim() === '' || typeof args.summary !== 'string'
              || args.summary.trim() === '' || typeof args.detail !== 'string' || args.detail.trim() === '') {
              throw new Error('交工 gate 需要 title/summary/detail 三段')
            }
            body.title = args.title.trim()
            body.summary = args.summary.trim()
            body.detail = args.detail.trim()
          } else if (stage === 'outline') {
            if (typeof args.chaptersJson !== 'string' || args.chaptersJson.trim() === '') {
              throw new Error('交工 outline 需要 chaptersJson（JSON 数组字符串）')
            }
            body.chaptersJson = args.chaptersJson.trim()
            // 服务端收 JSON 字符串；样例章建议与理由一并带上
            if (Number.isSafeInteger(Number(args.goldChapter))) body.goldChapter = Number(args.goldChapter)
            if (typeof args.goldChapterReason === 'string' && args.goldChapterReason.trim() !== '') body.goldChapterReason = args.goldChapterReason.trim()
          } else if (stage === 'chapters') {
            if (!Number.isSafeInteger(Number(args.chapter))) throw new Error('交工 chapters 需要 chapter（第几章）')
            body.chapter = Number(args.chapter)
            // 票 09：交工点名销号——把 handledReviews 原样透传给服务端（机器只给点名的置为已处置）。
            // 必须是真数组：服务端按 Array.isArray 判真假，字符串会被当成「一条都没点名」。
            if (args.handledReviews !== undefined) {
              if (!Array.isArray(args.handledReviews)) {
                throw new Error('handledReviews 需要数组 [{id, how}]（每条点名一条抽查意见）')
              }
              body.handledReviews = args.handledReviews
            }
          } else if (stage === 'merge') {
            if (typeof args.preface !== 'string' || args.preface.trim() === '') throw new Error('交工 merge 需要 preface（前言文本）')
            body.preface = args.preface.trim()
          } else if (stage === 'final') {
            if (typeof args.report !== 'string' || args.report.trim() === '') throw new Error('交工 final 需要 report（自查报告）')
            body.report = args.report.trim()
            // 票 08：终检交工转发 styleCheck——这是这条契约的产品侧唯一发送点（此前只有测试会写它）。
            // 判据一个字不放宽：漏一条 active 风格线照样由服务端 400 打回。
            if (args.styleCheck !== undefined) {
              if (!Array.isArray(args.styleCheck)) {
                throw new Error('styleCheck 需要数组 [{id, status, note?, chapter?}]（每条生效中的风格线一条去向）')
              }
              body.styleCheck = args.styleCheck
            }
          }
          break
        }
        // ── 代用户操作（必须先得到用户明确同意） ────────────────────────
        // 分支标签是规范动作名：主笔 AI 那边写的输入名（create / rename / set_goal / gate /
        // delete）由目录单向解析过来，解析不出这个动作就进不了这里。
        case 'book-create':
          if (typeof args.name !== 'string' || args.name.trim() === '') throw new Error('建书需要书名 name')
          if (typeof args.goal !== 'string' || args.goal.trim() === '') throw new Error('建书需要学习目标 goal')
          body = {
            action: 'book-create',
            name: args.name.trim(),
            goal: args.goal.trim(),
            route: args.route === 'human' ? 'human' : 'blueprint',
            science: args.science === true,
          }
          break
        case 'book-rename':
          if (typeof args.name !== 'string' || args.name.trim() === '') throw new Error('改名需要新书名 name')
          body = { action: 'book-rename', name: args.name.trim() }
          break
        case 'book-set-goal':
          if (typeof args.goal !== 'string' || args.goal.trim() === '') throw new Error('改目标需要 goal')
          body = { action: 'book-set-goal', goal: args.goal.trim() }
          break
        case 'gate-decide':
          if (args.gate === undefined || args.gate === null || args.gate === '') throw new Error('拍板需要 gate 拍板序号')
          if (typeof args.version !== 'number') throw new Error('拍板需要 version 版本号')
          if (typeof args.approved !== 'boolean') throw new Error('拍板需要 approved（true=通过/false=驳回）')
          body = {
            action: 'gate-decide',
            gate: String(args.gate),
            version: args.version,
            approved: args.approved,
            note: typeof args.note === 'string' ? args.note : '',
          }
          break
        case 'rollback':
          if (!Number.isSafeInteger(Number(args.snapshot))) throw new Error('回退需要 snapshot 序号')
          body = { action: 'rollback', snapshot: Number(args.snapshot) }
          break
        // ── 协作动作 ──────────────────────────────────────────────────────
        case 'style-note':
          body = { action: 'style-note', text: args.text.trim(), source: typeof args.source === 'string' ? args.source : 'chat' }
          break
        case 'style-note-revoke':
          body = { action: 'style-note-revoke', id: args.id }
          break
        case 'waive':
          body = { action: 'waive', item: args.item, userNote: args.userNote.trim(), source: 'chat' }
          break
        case 'waive-revoke':
          body = { action: 'waive-revoke', id: args.id }
          break
        case 'pause':
          body = { action: 'pause', reason: typeof args.reason === 'string' ? args.reason : '主 AI 侧发起的中断' }
          break
        case 'intervene':
          body = { action: 'intervene', text: args.text.trim(), ...(typeof args.target === 'string' ? { target: args.target } : {}) }
          break
        case 'intervene-done':
          body = { action: 'intervene-done', id: args.id }
          break
        case 'outline-confirm':
          body = {
            action: 'outline-confirm', approved: args.approved,
            ...(typeof args.note === 'string' ? { note: args.note } : {}),
            ...(Number.isSafeInteger(Number(args.goldChapter)) ? { goldChapter: Number(args.goldChapter) } : {}),
          }
          break
        case 'explore-confirm':
          // 走查票 09（裁决①：漏登记，补进 AI 闭包）：用户在探查结果卡点「满意，继续设计」
          // 时由 AI 代点。approved=false 就是「让 AI 重做」，服务端把产物归档后重新交办。
          body = {
            action: 'explore-confirm', approved: args.approved,
            ...(typeof args.note === 'string' ? { note: args.note } : {}),
          }
          break
        case 'gold-approve':
          // 走查票 09（裁决①：漏登记，补进 AI 闭包）：范例章定稿的唯一放行键——此前它
          // 只能在工作台谈判桌上点，界面一旦不可用，AI 又没这条通路，整条流水线停住。
          // ⚠️ 只转 approved，**不替产品代码编字段**：`targetWords`（旧单值兜底）在工作台上
          // 由谈判桌那一格发；AI 这条路的目标字数走交工 outline 的 `chaptersJson[].targetWords`
          // （ADR-0026 决策 5），这里不另开第二个入口。
          body = { action: 'gold-approve', approved: args.approved }
          break
        case 'chapters-review-confirm':
          body = { action: 'chapters-review-confirm', approved: args.approved }
          break
        case 'final-approve':
          // 终检结果认可：用户在终检结果卡点「认可/不满意」时由 AI 代点（须用户明确同意）。
          // approved=false 必带 note 由 preValidate 拦（单一校验落点）。
          body = {
            action: 'final-approve', approved: args.approved,
            ...(typeof args.note === 'string' ? { note: args.note.trim() } : {}),
          }
          break
        case 'deep-modify':
          // 定点修改（改历史）：用户在界面上点定点修改时走这条；对话里说改历史也必须
          // 引导用户去工作台点定点修改，不要自己动账本/产物。需用户明确同意后才调用。
          body = { action: 'deep-modify', segment: args.segment, note: args.note.trim() }
          break
        case 'deep-undo':
          body = { action: 'deep-undo' }
          break
        case 'gold-opinion':
          body = {
            action: 'gold-opinion', kind: args.kind, wish: args.wish.trim(),
            ...(Number.isSafeInteger(args.para) ? { para: args.para } : {}),
            ...(typeof args.hint === 'string' ? { hint: args.hint } : {}),
          }
          break
        case 'gold-opinion-revoke':
          body = { action: 'gold-opinion-revoke', id: args.id }
          break
        case 'gold-revise':
          body = { action: 'gold-revise', ...(typeof args.note === 'string' ? { note: args.note } : {}) }
          break
        case 'gold-chapter-set':
          body = { action: 'gold-chapter-set', chapter: Number(args.chapter), ...(typeof args.reason === 'string' ? { reason: args.reason } : {}) }
          break
        case 'resume':
          body = { action: 'resume' }
          break
        case 'nudge':
          // 催办：把用户的一句话以 notice 唤醒主 AI（不中断、不 cancel）；留空则用默认催办语。
          body = { action: 'nudge', ...(typeof args.text === 'string' && args.text.trim() !== '' ? { text: args.text.trim().slice(0, 200) } : {}) }
          break
        case 'book-delete':
          body = { action: 'book-delete', confirm: true }
          break
        default:
          // 解析不出来的输入名（拼错的、AI 没暴露的动作名、canonical name 本身）
          // 都在这里被拒——报错说的是主笔 AI 写下的那个输入名。
          throw new Error(`未知操作: ${inputName}`)
      }
      const json = await fetchJson(transport, `${base}/textbook/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ session: sessionId, ...(project !== undefined ? { project } : {}), ...body }),
      })
      return json
    },
  }))
}

export { apply }
