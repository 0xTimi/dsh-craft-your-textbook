/**
 * 造书工作台 · 后端流程插件（宿主侧）——Web 壳
 *
 * 本文件保留：插件元数据（name/inject）、HTTP handlers、启动恢复链、
 * apply（路由注册 + 时机）、动作族 dispatch 表（HANDLER_OF_FAMILY + 由目录构造的
 * ACTION_FAMILY_OF，票 contract-actions/04）。
 * 领域引擎（六阶段状态机核心 + 共享工具）在 ./workflow/engine.js；
 * 9 个动作族在 ./workflow/actions/*.js；动作身份与动作族 metadata 在 ./contract-actions.js。
 */
import {
  GATE_LABELS,
  PROJECT_ID_RE,
  appendEvent,
  assertSessionOwned,
  bindAnnounce,
  bindContextOccupancy,
  chapterArtifacts,
  chapterDone,
  noteStyleSpecChange,
  deepAffected,
  dshHome,
  foldGate,
  flushMeta,
  gateApproved,
  goldN,
  handoff,
  kick,
  listProjects,
  logEntryText,
  moveAcrossDevices,
  processLogPath,
  projectDir,
  projectsRoot,
  proposalFilesOnDisk,
  readEvents,
  readMeta,
  readRegistry,
  isRunning,
  snapshotsDir,
  sourcesDir,
  trashProject,
  waived,
  bookRelOnDisk,
  legacyDirConflicts,
  workDir,
  workFile,
  updateMeta,
} from './workflow/engine.js'
import { actBooks } from './workflow/actions/books.js'
import { actWizard } from './workflow/actions/wizard.js'
import { actConvert } from './workflow/actions/convert.js'
import { actGates } from './workflow/actions/gates.js'
import { actGold, canEditTargetWords } from './workflow/actions/gold.js'
import { actDeepModify } from './workflow/actions/deep-modify.js'
import { actCollabSignals } from './workflow/actions/collab-signals.js'
import { actChapters, readChapterAuditSummary } from './workflow/actions/chapters.js'
import { actPatternsOps } from './workflow/actions/patterns-ops.js'
import { buildActionFamilyTable } from './workflow/registration.js'
import { runAction } from './workflow/action-runner.js'
import { bookShapeReport, refreshArtifactRegistry } from './workflow/book-shape.js'
import { readFileSync, readdirSync, writeFileSync, existsSync, statSync, mkdirSync, renameSync, rmSync, realpathSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { isWithin } from './path-guard.js'
import { readSettings, autoSplitAvailable } from './mineru-lib.js'
import { MAX_UPLOAD_BYTES, uploadTooLargeMessage, productOpenMode, artifactKind, SEGMENT_PHASE, countHanzi, contextOccupancyPercent, convertedState, ROLES, guessRoleFromName, isAcceptedMaterialFormat, unsupportedMaterialFormatMessage, chapterRel, chapterName } from './domain-rules.js'


export const name = 'textbook-workflow'

// 回答：`sessionProjections`（宿主 `contextPressure` 会话投影的读数口，票 walkthrough-fixes/28）。
// 没有它，领任务说明里那一句「上下文已用 N%」就永远不出现（读数口未绑定 ⇒ null ⇒ 整句不追加，
// 读不到就不显示，不显示 0%）——而不是写一个假数。
// 票 `chapter-audit-orchestration/04` 再加 `jobs`：暂停要停掉这本书 owner 名下**在跑的编排脚本**
// （消费点 `ctx.jobs.list` / `ctx.jobs.kill` 在 `src/workflow/actions/collab-signals.js`）。
// 它是宿主组合里的**常驻服务**（`@deepseek-ai/dsh-base` 的 `cordis.patch.yml` 在宿主组合里加载
// `dsh-jobs-local`，`ctx.jobs` 由那一份的实现声明合并进来）⇒ 走直接成员访问，不进动态读取登记表。
// 按 AGENTS.md「用谁就声明谁」：声明在 `dev/host-contract-gate/catalog/web-chat.js` 的
// `contracts.session.source.hostServiceInjection.required` 里，拿掉这一枚会判红 `undeclared-host-service`。
export const inject = ['webServer', 'agents', 'subagents', 'sessions', 'sessionProjections', 'jobs']

const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/


/**
 * 写一次 JSON 响应 —— **HTTP adapter**（字节与 header 归它，状态落盘不归它）。
 *
 * ⚠️ 票 `deep-module-scan/11`：这个函数原先住在 `src/workflow/engine.js`，于是**一条领域不变量
 * （状态必须在工作单元结束时落盘）的 owner 是住在领域 module 里的 HTTP adapter**。
 * 后果是每一条**不经 HTTP 的路径**都得自己记得调 `flushMeta()`——今天有 9 处测试在替生产代码记这件事
 * （`test-material-gap-stance.mjs` 七处、`test-ledger-seq-integrity.mjs` 两处）。
 *
 * ⇒ 本次是**纯搬运**：43 个调用点**全部**在本文件里，engine 里一处都不用，所以搬完是一处不漏的机械移动。
 * **搬动的机械条件正是那 43 个调用点都在这里**——若哪天某个动作族开始直接用它，得先想清楚那是
 * 「不经 HTTP 的领域路径」（该自己 flush，不该用这个）还是「又多了一个 HTTP adapter」。
 */
function sendJson(res, status, value) {
  // 元数据批量落盘边界：任何 HTTP 响应前把待写 project.json 同步写盘，
  // 外部读者（工作台/测试直读）始终看到最新状态（与旧同步写语义一致）。
  // ⚠️ **顺序不许调**：flushMeta 在 writeHead 之前。换了顺序，`test-startup-recovery.mjs:297-303`
  // 那种「返回瞬间文件可能还是旧值、轮询等 flush」的假设要重新验。
  flushMeta()
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(body)
}


/**
 * 读 session 参数：缺失/非法返回 null，由调用方回 400（票 04）。
 * ⚠️ 曾经缺省回退 `'default'`——所有权检查于是只剩「会话 id 给对了」那么强：
 * 带着非法 session 的请求会被当成 default 会话，凡是 meta.session === 'default'
 * 的老书都能被任何人读写。宁可拒绝，也不替调用方猜一个身份。
 */
function sessionOf(value) {
  if (typeof value === 'string' && SESSION_ID_RE.test(value)) return value
  return null
}


/** 校验会话参数：缺失/非法直接回 400 并返回 null（调用方据此提前 return）。 */
function requireSession(value, res) {
  const sessionId = sessionOf(value)
  if (sessionId === null) {
    sendJson(res, 400, { ok: false, error: '缺少或非法的 session 参数' })
    return null
  }
  return sessionId
}


function listSnapshots(projectId) {
  const dir = snapshotsDir(projectId)
  const list = []
  for (const name of readdirSync(dir)) {
    const match = /^(\d+)\.json$/.exec(name)
    if (match === null) continue
    try {
      const raw = readFileSync(join(dir, name), 'utf8')
      const snapshot = JSON.parse(raw)
      list.push({ seq: Number(match[1]), time: snapshot.time, reason: snapshot.reason })
    } catch { /* 损坏快照跳过 */ }
  }
  list.sort((a, b) => b.seq - a.seq)
  return list
}


/** 章节流水线阶段（F35）：从 meta.chapterPipeline 读，旧账本/未上报返回 null。 */
function pipelineStage(meta, index) {
  const pipeline = Array.isArray(meta?.chapterPipeline) ? meta.chapterPipeline : []
  const entry = pipeline[index]
  return entry !== null && typeof entry === 'object' ? (entry.stage ?? null) : null
}


// ── HTTP 层 ────────────────────────────────────────────────────────────────

/** 请求体超限标记：调用方据此回可读的 413（不能掐断连接——掐断时浏览器
 *  只看到 Failed to fetch，看不到真实原因；实测 129MB 上传即触发）。 */
const BODY_TOO_LARGE = 'BODY_TOO_LARGE'

function bodyTooLargeError(limitLabel) {
  const err = new Error(`body too large (> ${limitLabel})`)
  err.code = BODY_TOO_LARGE
  return err
}


function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let over = false
    req.on('data', (chunk) => {
      if (over) return // 超限后不再累积，等请求自然结束，让调用方先回 413
      size += chunk.length
      if (size > 64 * 1024 * 1024) {
        over = true
        reject(bodyTooLargeError('64MB'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (over) return
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw === '' ? {} : JSON.parse(raw))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}


// MAX_UPLOAD_BYTES / uploadTooLargeMessage 来自 domain-rules.js（前后端共享单一事实源）。


function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let over = false
    req.on('data', (chunk) => {
      if (over) return // 超限后不再累积，等请求自然结束，让调用方先回 413
      size += chunk.length
      if (size > MAX_UPLOAD_BYTES) {
        over = true
        reject(bodyTooLargeError('500MB'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (over) return
      resolve(Buffer.concat(chunks))
    })
    req.on('error', reject)
  })
}


/** POST /textbook/upload?session=&project=&name=&role= （raw body = 原件字节；后缀闸门见下） */
async function handleUpload(ctx, req, res) {
  const url = new URL(req.url, 'http://localhost')
  const sessionId = requireSession(url.searchParams.get('session'), res)
  if (sessionId === null) return
  const project = url.searchParams.get('project')
  const name = url.searchParams.get('name')
  // 缺参数不是越界：缺省走文件名规则的那个兜底角色（guessRoleFromName 对任何名字都回它，
  // 必在 ROLES 内）。**不另写一个 '学生用书' 字面量**——接口处不维护第二份角色值。
  const role = url.searchParams.get('role') ?? guessRoleFromName('')
  if (project === null || !PROJECT_ID_RE.test(project)) {
    sendJson(res, 400, { ok: false, error: '缺少或非法的 project 参数' })
    return
  }
  // ⚠️ 票 07：受理闸门与 400 文案**都从 `MATERIAL_FORMATS` 派生**（`src/domain-rules.js`），
  // 浏览器那个 `<input accept>` 由**同一份**常量派生——两侧不许各写一份（照 `ROLES` /
  // `MAX_UPLOAD_BYTES` 的先例）。原来这里是 `!/\.pdf$/i.test(name)` 一行手抄的后缀，
  // 改名单时它会**静默**留在原地（前端放行、后端拒收，或反过来）。
  // 名单里的多数格式（图片 / Office）上游只有散文声明、零成功记录 ⇒ 那一格在界面上标「未标定」。
  if (name === null || name.trim() === '' || !isAcceptedMaterialFormat(name)) {
    sendJson(res, 400, { ok: false, error: unsupportedMaterialFormatMessage() })
    return
  }
  // 素材角色是**封闭五分类**（CONTEXT.md「素材角色」/ ADR-0023 决策 1）。原先这一格是裸取查询串：
  // 同函数里 project 与 name 都有闸门，唯独角色没有——越界值原样落进材料清单，并原样流进阶段
  // 任务说明里给 AI 的材料表，「分类法只有五个值」只由界面与一处事后过滤器保证，直连即可绕过。
  // 白名单取 `ROLES`（唯一取值来源）而不写死五个字符串：规范集合日后变更，这道闸门自动跟随。
  if (!ROLES.includes(role)) {
    sendJson(res, 400, { ok: false, error: `非法的 role 参数（素材角色只认：${ROLES.join(' / ')}）` })
    return
  }
  try {
    assertSessionOwned(project, sessionId)
  } catch (error) {
    sendJson(res, 403, { ok: false, error: String(error instanceof Error ? error.message : error) })
    return
  }
  const meta = readMeta(project)
  if (meta === null) {
    sendJson(res, 404, { ok: false, error: '项目不存在' })
    return
  }
  const safeName = basename(name)
  try {
    const bytes = await readRawBody(req)
    if (bytes.length === 0) {
      sendJson(res, 400, { ok: false, error: '文件内容为空' })
      return
    }
    writeFileSync(join(sourcesDir(project), safeName), bytes)
    // ⚠️ 状态改在 updateMeta 的改法里（当场新读）：上面 `await readRawBody` 期间可能已经有一笔
    // 记进了账本——原先拿着函数开头那份旧状态整份写回，会把账高打回读请求体之前的旧值，
    // 于是同一拍的下一次上传重号（真账本头六笔 source-added 序号全是 1，票 02）。
    let added = false
    let resent = false
    updateMeta(project, (state) => {
      const sources = state.sources ?? []
      // 幂等：同一文件名重复上传只更新角色，不再追加条目/事件。
      // 背景：客户端瞬时网络失败（Failed to fetch）时服务端已落盘，前端重传同一批文件；
      // 无幂等 → meta.sources 与 timeline 逐次重复（实测 4 文件 × 3 轮 = 12 条）。
      const existing = sources.find((source) => source.file === safeName)
      if (existing !== undefined) {
        existing.role = role
        // 票 `mineru-formats/03`（ADR-0028 决策 3）的**「补传」那一半**：同一个名字再传一次，
        // 而那一格正是一个缺口（`failed`）⇒ 这是用户对这一份表过态「我补一份」，把它放回
        // `'pending'`，下一轮状态机真的会重转它（`failed` 自己不会被挑中重传，票 02）。
        // ⚠️ 只对 `failed` 放行：转成过的那份（`ok`）重传**不动**它的结局——那是另一个问题
        // （原件换了、转换稿还是旧的），不在本票射程里，票面 Comments 记着。
        // 顺手清掉旧的转换稿路径：那一格要重新转，旧的 `md` 留着就是一处会指向过期文件的指针。
        if (convertedState(existing) === 'failed') {
          existing.converted = 'pending'
          delete existing.md
          resent = true
        }
      } else {
        sources.push({ file: safeName, role, converted: 'pending' })
        added = true
      }
      state.sources = sources
      state.status = 'active'
      // 补传的那一格是「待转」，不是「已转」——状态得让状态机能接上去（见下面那次 kick）。
      if (resent) state.status = 'running'
    })
    if (added) appendEvent(project, 'textbook/source-added', { file: safeName, role })
    if (resent) appendEvent(project, 'textbook/hint', { text: `已补传《${safeName}》，正在重新转换这一份` })
    // 补传要**当场**接上状态机：用户点的是「补传这一份」，点完就该看着它重转，
    // 而不是还得再点一次「开始转换」才动（那就不是一个动作，是两步）。
    // ⚠️ 已经有一个状态机在跑时**不**再起第二个：那一轮每轮都重读 meta，下一次循环自己
    // 就把这一格 pending 挑去转了；两个 runLoop 并跑会把同一批待转源重复提交给 MinerU
    // （烧额度）。「有没有在跑」经 `isRunning` 取（票 `deep-module-scan/10`：原先两处各读一次
    //  `runners.has`、含义只活在各自的注释里；`runners` 本身仍导出，因为删书要清理它）。
    if (resent && ctx !== undefined && isRunning(project) === false) void kick(ctx, project)
    sendJson(res, 200, { ok: true, project, file: safeName, role, resent })
  } catch (error) {
    const tooLarge = error?.code === BODY_TOO_LARGE
    sendJson(res, tooLarge ? 413 : 500, {
      ok: false,
      error: tooLarge
        ? uploadTooLargeMessage()
        : String(error instanceof Error ? error.message : error),
    })
  }
}


/**
 * GET /textbook/file?session=&project=&path= （文本读回：**只给有正文的产物**）
 *
 * 票 04 收窄：判据换成 domain-rules 的显式产物清单（productOpenMode === 'preview'，
 * 章节 / 探查报告 / 设计关卡方案 / 自查报告 / 成品 / 材料转换出的 Markdown），
 * **不是**扩展名、也不是「在项目目录里」——旧判据是后两者，于是机器产物
 * （knowledge-map.json / project.json / timeline.jsonl）与源 PDF 一道可读。
 *
 * 这条路由保留（历史章节回看、金标准逐段对比仍在调它，见 gold-table.js 的 fetchText），
 * 但只放行人会读的正文；越界/非白名单一律拒绝并给出可读原因，不静默。
 */
function handleFile(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const sessionId = requireSession(url.searchParams.get('session'), res)
  if (sessionId === null) return
  const project = url.searchParams.get('project')
  const rel = url.searchParams.get('path')
  if (project === null || rel === null) {
    sendJson(res, 400, { ok: false, error: '缺少参数' })
    return
  }
  if (productOpenMode(rel) !== 'preview') {
    sendJson(res, 403, { ok: false, error: '这份是机器产物，不提供文本读回' })
    return
  }
  try {
    assertSessionOwned(project, sessionId)
    const root = resolve(projectDir(project))
    // ⚠️ **老书读侧兜底**：传上来的是**规范形状**（`工作区/chapter-01.md`），而老书盘上是老名那一份
    // ——`bookRelOnDisk` 负责这一步「新名 → 盘上真落点」。
    // ⚠️ **越界判定不许因此放松**：它返回的那一条照样过下面两道 `isWithin`（符号链接那道也在），
    // 兜底只许在**书夹之内**的老名段上生效，不许变成一条绕过越界判定的旁路。
    const target = bookRelOnDisk(project, rel)
    if (!isWithin(root, target)) {
      sendJson(res, 403, { ok: false, error: '路径越界' })
      return
    }
    if (!existsSync(target) || statSync(target).isDirectory()) {
      sendJson(res, 404, { ok: false, error: '文件不存在' })
      return
    }
    // 白名单判的是名字，符号链接可以挂到项目外：再按真实路径确认一次落点还在项目里。
    if (!isWithin(realpathSync(root), realpathSync(target))) {
      sendJson(res, 403, { ok: false, error: '路径越界' })
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(readFileSync(target, 'utf8'))
  } catch (error) {
    sendJson(res, 500, { ok: false, error: String(error instanceof Error ? error.message : error) })
  }
}


/** GET /textbook/work?session=&project= （列出已完成步骤的结果文件） */
function handleWork(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const sessionId = requireSession(url.searchParams.get('session'), res)
  if (sessionId === null) return
  const project = url.searchParams.get('project')
  if (project === null) {
    sendJson(res, 400, { ok: false, error: '缺少 project 参数' })
    return
  }
  try {
    assertSessionOwned(project, sessionId)
    const dir = workDir(project)
    const files = []
    // 过程记录放最前，人最常看。
    const logPath = processLogPath(project)
    if (existsSync(logPath)) files.push({ path: '过程记录.md', label: '过程记录（全部流水账）' })
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.md')) continue
        let label = null
        if (name === 'explore.md') label = '读材料挑重点的结果'
        else if (name === 'outline.md') label = '教学设计·章节安排'
        else if (name === 'style-spec.md') label = '写作规范'
        else if (name === 'book.md') label = '成书 BOOK.md'
        else {
          const chapter = /^chapter-(\d+)\.md$/.exec(name)
          const audit = /^audit-(\d+)\.md$/.exec(name)
          if (chapter !== null) label = `第 ${Number(chapter[1])} 章`
          else if (audit !== null) label = `第 ${Number(audit[1])} 章·机器自查`
        }
        if (label !== null) files.push({ path: `工作区/${name}`, label })
      }
    }
    files.sort((a, b) => a.path.localeCompare(b.path))
    sendJson(res, 200, { ok: true, files })
  } catch (error) {
    sendJson(res, 500, { ok: false, error: String(error instanceof Error ? error.message : error) })
  }
}


/** GET /textbook/download?session=&project=&path= （附件下载） */
function handleDownload(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const sessionId = requireSession(url.searchParams.get('session'), res)
  if (sessionId === null) return
  const project = url.searchParams.get('project')
  const rel = url.searchParams.get('path')
  if (project === null || rel === null) {
    sendJson(res, 400, { ok: false, error: '缺少参数' })
    return
  }
  try {
    assertSessionOwned(project, sessionId)
    const target = resolve(projectDir(project), rel)
    const root = resolve(projectDir(project))
    if (!isWithin(root, target)) {
      sendJson(res, 403, { ok: false, error: '路径越界' })
      return
    }
    if (!existsSync(target) || statSync(target).isDirectory()) {
      sendJson(res, 404, { ok: false, error: '文件不存在' })
      return
    }
    // 下载文件名用「人定的书名」（如《初中数学·有理数》.md），保留用户敲定的命名。
    const dlMeta = readMeta(project)
    const bookName = (typeof dlMeta?.name === 'string' && dlMeta.name.trim() !== '' ? dlMeta.name.trim() : basename(rel))
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim().replace(/[. ]+$/g, '') || 'BOOK'
    const fileName = encodeURIComponent(`${bookName}.md`)
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${fileName}`,
      'Cache-Control': 'no-store',
    })
    res.end(readFileSync(target))
  } catch (error) {
    sendJson(res, 500, { ok: false, error: String(error instanceof Error ? error.message : error) })
  }
}


/**
 * 提问卡的一次作答 → 一条书账本事件（票 06 ②）。
 *
 * 真相（票面 §先说清楚）：提问卡是**宿主**的 UI——`dsh-client-ui-user-questions` 接管聊天编辑器，
 * 渲染的是 `dsh-tool-ask-user`（工具名 `ask_user_question`）的 schema。答案**本来留痕了**，
 * 只留在宿主会话档案里；书账本里查不到，那才是这一票要补的通路。
 *
 * **为什么是新端点而不是新动作**：契约面动作目录（`src/contract-actions.js`）的 45 个规范动作里
 * 没有任何一个的语义是「记下用户答了什么」——硬套 `intervene`（留言）会让账本说「稍后处理」，
 * 而用户答完那一刻 AI 正在等这个答案，说法就是假的。动作身份归目录，目录不归本票改。
 *
 * **为什么复用 `textbook/hint` 这个事件类型**：新增事件类型要同时动 `EVENT_TYPES`、
 * `EVENT_META` 与 `logEntryText` 三处，后两处在 `src/domain-rules.js` 与 `src/workflow/engine.js`
 * 上，不在本票可改面内；而 `hint` 正是仓里登记的「碎语」通道（docs/协作模型.md §2.8 表 B 多处复用），
 * 语义就是「随手记一句、不产出文件」。结构化的 `question` / `answers` 一并写进 data，
 * 机器产物 `timeline.jsonl` 里查得到——**不靠人读文本还原那次选择**。
 *
 * ⚠️ 发生时刻由 `appendEvent` 打在事件上（服务端时间）：浏览器不另带一个自己的时刻来，
 * 与「新鲜度是服务端事实」同一条纪律。
 *
 * POST /textbook/question?session=&project= （body: { key, questions, answers }）
 */
async function handleQuestion(req, res) {
  let body
  try {
    body = await readBody(req)
  } catch (error) {
    sendJson(res, 400, {
      ok: false,
      error: error?.code === BODY_TOO_LARGE ? '请求体超过 64MB 上限' : '请求体不是合法 JSON',
    })
    return
  }
  const sessionId = requireSession(body.session, res)
  if (sessionId === null) return
  const project = body.project
  if (typeof project !== 'string' || !PROJECT_ID_RE.test(project)) {
    sendJson(res, 400, { ok: false, error: '缺少或非法的 project 参数' })
    return
  }
  const questions = Array.isArray(body.questions) ? body.questions : []
  const answers = Array.isArray(body.answers) ? body.answers : []
  if (questions.length === 0 && answers.length === 0) {
    sendJson(res, 400, { ok: false, error: '没有可记的提问内容' })
    return
  }
  try {
    assertSessionOwned(project, sessionId)
  } catch (error) {
    // 归属不成立是**请求本身不成立**，与「机器出错」分开回（与 upload/file 同一口径）。
    sendJson(res, 403, { ok: false, error: String(error instanceof Error ? error.message : error) })
    return
  }
  try {
    if (readMeta(project) === null) {
      sendJson(res, 404, { ok: false, error: '项目不存在' })
      return
    }
    const asked = questions
      .map((item) => (typeof item?.header === 'string' && item.header.trim() !== '' ? item.header.trim() : item?.question))
      .filter((text) => typeof text === 'string' && text.trim() !== '')
    const picked = answers.flatMap((answer) => [
      ...(Array.isArray(answer?.selected) ? answer.selected : []),
      ...(typeof answer?.custom === 'string' && answer.custom.trim() !== '' ? [answer.custom] : []),
    ])
    const text = `用户在提问卡上答了「${clip(asked.join('；'), 60)}」：${clip(picked.join('、'), 120) || '（没有勾选）'}`
    appendEvent(project, 'textbook/hint', { text, question: asked, answers, source: 'ask_user_question' })
    sendJson(res, 200, { ok: true, project })
  } catch (error) {
    sendJson(res, 500, { ok: false, error: String(error instanceof Error ? error.message : error) })
  }
}


/** 提问/答案都是模型或用户写的字：截断后再落账，一条事件不许无限长。 */
function clip(value, max) {
  return value.length > max ? `${value.slice(0, max)}…` : value
}


/**
 * 动作族 → handler 的真实注册（Node implementation 只留在这里，票 contract-actions/04）。
 * 一族一实现，族 id 与 module 文件名同源：`./workflow/actions/<族>.js`。
 */
const HANDLER_OF_FAMILY = new Map([
  ['books', actBooks],
  ['wizard', actWizard],
  ['convert', actConvert],
  ['gates', actGates],
  ['gold', actGold],
  ['deep-modify', actDeepModify],
  ['collab-signals', actCollabSignals],
  ['chapters', actChapters],
  ['patterns-ops', actPatternsOps],
])


/**
 * 动作 → 动作族 handler 的分发表：**规范动作名与动作族 metadata 只从契约面动作目录来**
 * （`./contract-actions.js`，ADR-0017 决策 6/9）。本文件不再手写第二份动作清单——
 * 新增动作就是往目录里加一行，它自动落进本表。
 *
 * 目录是零依赖 metadata module、不认识本文件的 handler；本文件也不把 payload、授权、
 * 用户确认、账本或错误语义搬进目录：那些仍归各自动作族实现与 engine。
 *
 * 装配与两边的闭包在 `./workflow/registration.js`（纯函数，好数据坏数据都由测试直接验）。
 */
const ACTION_FAMILY_OF = buildActionFamilyTable(HANDLER_OF_FAMILY)


/** POST /textbook/action 动作分发 —— **HTTP adapter**（读流、限体、写响应）。
 *  判据全在下面那个 `dispatchAction` 里，这里只负责传输那一层。 */
async function handleAction(ctx, req, res) {
  let body
  try {
    body = await readBody(req)
  } catch (error) {
    sendJson(res, error?.code === BODY_TOO_LARGE ? 413 : 400, {
      ok: false,
      error: error?.code === BODY_TOO_LARGE ? '请求体超过 64MB 上限' : '请求体不是合法 JSON',
    })
    return
  }
  // ⚠️ I2 · 回包 ≠ 落盘：`dispatchAction` 不调 flushMeta，落盘边界就在下面这次 sendJson 里
  // （`test-material-gap-stance.mjs` 直接 import flushMeta 7 处，那条路径不经 HTTP）。
  // ⚠️ `reply === undefined`＝这个族没有这个动作的 case：照旧什么都不写
  // （今天 handler 掉出 switch、socket 挂着；改成回 400 是行为变化）。
  const reply = await dispatchAction(ctx, body)
  // 「实际有什么」那一份：**机器每次动作扫盘写回**登记（票 `context-budget/10`）。
  // ⚠️ 写在动作漏斗这一层而不是读通道：工作台 2 秒轮询一次 `/textbook/process`，
  // 放读通道等于每两秒写一次盘。⚠️ 只在有书且动作真落过盘时才扫；被拒的请求（400/409）
  // 不扫——盘上什么都没变，重扫一遍只是白写。
  if (reply !== undefined && reply.status < 400 && typeof body?.project === 'string' && PROJECT_ID_RE.test(body.project)) {
    try { refreshArtifactRegistry(body.project) } catch { /* 登记是派生件，写不进去不许拖垮动作 */ }
  }
  if (reply !== undefined) {
    sendJson(res, reply.status, reply.json)
  }
}


/**
 * **动作层 interface**：打一个规范动作，拿一个应答。传输不在这个 interface 上——
 * 它不碰 `req`/`res`，只认「一次动作请求」与「一次应答」这一对形状。
 *
 * 与 `handleAction` 的关系：`handleAction` 是它上面的 **HTTP adapter**（读流、限 64MB、
 * 写状态码与 header、触发 `flushMeta` 落盘边界）；本函数是 seam 本身。
 *
 * ⚠️ **本函数不导出，ADR-0003 决策 4 原样保持**：「动作族 handler 不对测试单独导出——
 * 现有 mkReq/mkRes fakes 是唯一的第二 adapter」。票 03 第 4 步曾把它导成测试面
 * （`test-session-title.mjs` 不再造假件），code-review 双轴后**已撤回**（票 03 · 裁决）：
 * 那条路要额外付一个定时器隐患 + 一个与票面不符的入口位置，换来的只有 0.4 秒。
 * ⇒ 测试要调动作层，**仍然自己造 mkReq/mkRes**。
 *
 * ⚠️ **返回 `{status, json}`，不写任何响应**——所以**盘面还没落盘**
 * （落盘边界在 `sendJson` 里，见 I2）。
 *
 * @param {object} ctx 宿主上下文（与 `apply(ctx)` 收的是同一个形状）。
 * @param {{action:string, session?:string, project?:string}} request 解析后的请求体本体。
 * @returns {Promise<{status:number, json:object}|undefined>}
 */
async function dispatchAction(ctx, request) {
  const body = request ?? {}
  const { action, project } = body
  const sessionId = sessionOf(body.session)
  if (sessionId === null) {
    return { status: 400, json: { ok: false, error: '缺少或非法的 session 参数' } }
  }
  if (typeof action !== 'string' || action === '') {
    return { status: 400, json: { ok: false, error: '缺少 action' } }
  }
  const family = ACTION_FAMILY_OF.get(action)
  if (family === undefined) {
    return { status: 400, json: { ok: false, error: `未知动作: ${action}` } }
  }
  try {
    const reply = await runAction(family, { ctx, action, sessionId, project, body })
    // 与 handleAction 同一句：没有这个 case 就照旧什么都不写（这里返回 undefined）。
    return reply
  } catch (error) {
    ctx.logger.warn(`textbook: action ${action} failed: ${String(error)}`)
    return { status: 500, json: { ok: false, error: String(error instanceof Error ? error.message : error) } }
  }
}


function handleEvents(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const sessionId = requireSession(url.searchParams.get('session'), res)
  if (sessionId === null) return
  const project = url.searchParams.get('project')
  if (project === null || !PROJECT_ID_RE.test(project)) {
    sendJson(res, 400, { ok: false, error: '缺少或非法的 project 参数' })
    return
  }
  const afterRaw = url.searchParams.get('after')
  const after = afterRaw === null || afterRaw === '' ? undefined : Number(afterRaw)
  if (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) {
    sendJson(res, 400, { ok: false, error: '非法的 after 参数' })
    return
  }
  try {
    assertSessionOwned(project, sessionId)
    const meta = readMeta(project)
    if (meta === null) {
      sendJson(res, 404, { ok: false, error: '项目不存在' })
      return
    }
    // 票 12 · ①：AI 改写作规范这件事**机器替它记账**。检测点选在这里的理由与代价写在
    // `engine.noteStyleSpecChange` 的注释里（稳态只读不写；终检交工那一次还会补检）。
    // ⚠️ 必须排在 `readEvents` **之前**：这一笔落进账本后，本轮响应要能把它带回去，
    // 否则用户得再等一个轮询周期才看见（实测轮询间隔 2 秒——不差，但顺序摆在这里更符合因果）。
    try { noteStyleSpecChange(project) } catch { /* 记账失败不许拖垮这一轮读取 */ }
    const events = readEvents(project, after)
    // 定稿区展示用的实测值是**响应派生**，不落 project.json：服务端当场读盘上当前范例章，
    // 用 domain-rules 的唯一汉字计数口径算好后随 meta 视图下发，浏览器不另读正文。
    const goldMeasuredChapter = goldN(meta)
    let goldMeasuredHanzi = null
    try {
      // ⚠️ 这里要的是**基名**：`workFile` 自己拼 `工作区/`，给它相对路径会变成 `工作区/工作区/chapter-NN.md`。
      const goldPath = workFile(project, chapterName(goldMeasuredChapter))
      if (existsSync(goldPath)) goldMeasuredHanzi = countHanzi(readFileSync(goldPath, 'utf8'))
    } catch { /* 还没产出正文时留 null，不编数字 */ }
    const metaView = {
      ...meta,
      goldMeasuredChapter,
      goldMeasuredHanzi,
      canEditTargetWords: canEditTargetWords(meta),
    }
    // 章节状态：每章写好/自查好的徽章（UI 与 AI 都用）。
    // 票 14（界面数字同源）：`done` 直接问**闸门那一份判据**（engine 的 chapterDone：两份产物在
    // ＋ 机器记下的交工通过 ＋ 没有未处置的抽查意见）——界面的「已完成 X/Y 章」与过目闸门从此同源，
    // 两个数字不打架。**不许在这里写第二份判据**（写第二份就是本程要消灭的「两个数字打架」）。
    const chapters = meta.outline?.chapters ?? []
    const chapterStatus = chapters.map((chapter, index) => {
      const n = index + 1
      const { chapterPath, auditPath } = chapterArtifacts(project, n)
      return {
        n, title: chapter.title ?? `第${n}章`,
        source: chapter.source ?? '', targetWords: chapter.targetWords ?? null,
        // written/audited 保留为「产物在不在」的原义（界面用它区分「执笔中 / 写好了审计中 / AI 复核中」）；
        // done 才是闸门口径的「这一章算完成了」（客户端改用 done 后，两个数字必然一致）。
        written: existsSync(chapterPath), audited: existsSync(auditPath),
        done: chapterDone(project, n),
      }
    })
    // 探查摘要（探查确认卡用）：材料份数/知识点数/建议章数。
    let exploreSummary = null
    // 知识地图原文：机器产物，但人读形态是**卡片内联**折叠清单（ADR-0010 决策 2 / 票 05），
    // 故随事件一起下发，不再让前端走 /textbook/file——那条路由按「给人读的产物」收窄后
    // 拒绝机器产物（票 04）。文件不在/读不到时为 null（前端回退成一句可读说明）。
    let knowledgeMap = null
    try {
      const kmText = readFileSync(workFile(project, 'knowledge-map.json'), 'utf8')
      knowledgeMap = kmText
      const km = JSON.parse(kmText)
      const converted = (meta.sources ?? []).filter((source) => convertedState(source) === 'ok').length
      exploreSummary = {
        sources: converted,
        knowledgePoints: Array.isArray(km.knowledgePoints) ? km.knowledgePoints.length : 0,
        chapterSuggestion: Array.isArray(km.chapterSuggestion) ? km.chapterSuggestion.length : 0,
        teachingFocus: Array.isArray(km.teachingFocus) ? km.teachingFocus.slice(0, 5) : [],
      }
    } catch { exploreSummary = null }
    // 章节安排原文（`工作区/outline.md`）：**内容是机器 JSON**，判 `'inline'` 不开右栏
    // （票 pipeline-wiring-gaps/09），人读形态是阶段页第 3 阶段那张就地折叠清单
    // （`machine-product-folds.foldOutline`）。同知识地图：随事件一起下发，文件读不到时为 null。
    let outlineText = null
    try {
      outlineText = readFileSync(workFile(project, 'outline.md'), 'utf8')
    } catch { outlineText = null }
    // 当前范例章的**检查记录原文**（`工作区/audit-NN.md`）：同样是「机器产物但有人读」——
    // 内容是**严格 JSON**，`productOpenMode` 判 `'machine'`（ADR-0010 决策 2），所以
    // `/textbook/file` 对它是**明确 403**（那条路由只放行 `'preview'`）。
    // ⚠️ **病**（票 `gold-finalize-blocked/01`，2026-02-11 真机《抑郁患者自救》）：谈判桌那张卡
    // 就是拿 `/textbook/file` 去读它的，于是**每一次请求都必然 403** ⇒ 卡永远停在「展示期」、
    // 「定稿」「重写」两颗键永远灰、**刷新无效**（那不是缓存问题，是每次都失败），
    // 书卡在第三阶段出不去。从别的入口（AI 工具 `gold-approve`）定稿却能成——两侧口径不一致。
    // ⇒ 与上面两份走**同一条既有路**：随 payload 下发，前端不再经那条路由读它
    // （人读形态由谈判桌的检查徽章 ＋ 那句 fact line 承担）。
    // 读不到（还没落盘／读失败）时为 `null`——正好落进前端三态里的「没有／读不到」那一格。
    // ⚠️ 文件名形状与 `:901`／`:928` 那两处逐字同款（`audit` 族同一个补两位序号契约）。
    let goldAudit = null
    try {
      goldAudit = readFileSync(workFile(project, `audit-${String(goldMeasuredChapter).padStart(2, '0')}.md`), 'utf8')
    } catch { goldAudit = null }
    // 金标准稿版本（谈判桌页签数据）：_旧版产物 里按时间戳升序的旧稿；当前稿号 = 旧稿数 + 1。
    let goldDrafts = []
    try {
      const archiveDir = join(workDir(project), '_旧版产物')
      if (existsSync(archiveDir)) {
        // 归档旧稿的文件名是**基名**加时间戳后缀（`chapter-NN.md.<stamp>`）⇒ 序号取 `chapterName`。
        // ⚠️ **两处形状陷阱**，都踩过（改这一行前先读）：
        //   ① `chapterName` 返回的是**文件名**、不是正则片段——里面那个 `.` 不转义的话，
        //      `chapter-07Xmd.abc` 也会被认成一份旧稿（原来手写模板里的 `\\.` 正是这个转义）；
        //   ② 它**已经含 `.md`**，所以后面只能接 `\\.` + 时间戳，再写一次 `\\.md` 会变成
        //      `chapter-07\.md\.md\.…`，于是**一份旧稿都认不出来**（`_旧版产物` 整族静默失效）。
        // `String.replace` 只换第一处，而 `chapter-NN.md` 里恰好只有一个 `.`——改形状时要重新核这一句。
        const goldRe = new RegExp(`^${chapterName(goldN(meta)).replace('.', '\\.')}\\.([0-9a-z]+)$`)
        goldDrafts = readdirSync(archiveDir)
          .flatMap((name) => { const m = goldRe.exec(name); return m === null ? [] : [{ name, at: parseInt(m[1], 36) }] })
          .sort((a, b) => a.at - b.at)
          .map((d, i) => ({ version: i + 1, path: `工作区/_旧版产物/${d.name}`, at: d.at }))
      }
    } catch { goldDrafts = [] }
    sendJson(res, 200, {
      ok: true, project, after, events, meta: metaView,
      dir: projectDir(project),
      gate: foldGate(project),
      snapshots: listSnapshots(project),
      work: existsSync(workFile(project, 'book.md')) ? '工作区/book.md' : null,
      pendingStage: meta.pendingStage ?? null,
      pendingGate: meta.pendingGate ?? null,
      pendingReviews: Array.isArray(meta.pendingReviews) ? meta.pendingReviews : [],
      pendingInterventions: (meta.pendingInterventions ?? []).filter((i) => i.status === 'pending'),
      finalReport: meta.finalReport ?? null,
      chapterStatus,
      goldDrafts,
      goldDraftVersion: goldDrafts.length + 1,
      exploreSummary,
      knowledgeMap,
      outline: outlineText,
      goldAudit,
    })
  } catch (error) {
    sendJson(res, 500, { ok: false, error: String(error instanceof Error ? error.message : error) })
  }
}


/**
 * 盘上产物事实：与 artifacts 并行下发，stat 失败只省掉这一份事实。
 * kind 统一复用 domain-rules.artifactKind 的共享领域规则映射。
 */
function buildArtifactFacts(projectId, artifacts) {
  const root = projectDir(projectId)
  const facts = []
  const chapters = new Map()
  const audits = new Map()
  for (const rel of artifacts) {
    if (typeof rel !== 'string' || rel === '') continue
    try {
      const stat = statSync(join(root, rel))
      if (!stat.isFile()) continue
      const path = rel.replace(/\\/g, '/')
      const chapter = /^工作区\/chapter-(\d{2})\.md$/.exec(path)
      const audit = /^工作区\/audit-(\d{2})\.md$/.exec(path)
      const fact = {
        path: rel,
        kind: artifactKind(path),
        modifiedAt: stat.mtimeMs,
      }
      facts.push(fact)
      if (chapter !== null) chapters.set(chapter[1], fact)
      if (audit !== null) audits.set(audit[1], fact)
    } catch { /* 读不到 stat 就省略这份事实，不让过程图谱整体失败 */ }
  }
  // 新鲜度是服务端事实；浏览器不再拿自己的时间或另一份数据重算。
  for (const [n, chapter] of chapters) {
    const audit = audits.get(n)
    if (audit === undefined) continue
    chapter.freshness = 'current'
    audit.freshness = audit.modifiedAt < chapter.modifiedAt ? 'stale' : 'current'
  }
  return facts
}


/** 过程图谱：把账本折叠成可点分段（前端地图与定点修改的数据源）。 */
function buildProcessMap(projectId) {
  const meta = readMeta(projectId)
  const chapters = meta?.outline?.chapters ?? []
  const segments = []
  const push = (s) => segments.push(s)
  const phase = meta?.phase ?? 1
  // 「当前正在做的是哪一步」只认 pendingStage/pendingGate/status，**不认「phase 已经走到几」**。
  // 根因（2026-09-20 走查 04 屏）：原式一律 `phase >= N ? 'active' : 'pending'`，于是书一进
  // 第 3 期，第 2/3 次拍板与章节安排统统亮成「▶ 我正在做」——从没碰过的步骤也在"做"。
  const pending = meta?.pendingStage ?? null
  // 产物存在性按「项目目录相对路径」判（artifacts 输出即相对路径；workFile 会再拼 工作区/，不能复用）。
  const existsRel = (rel) => existsSync(join(projectDir(projectId), rel))
  // 探源
  push({
    key: 'explore', label: '源探查', kind: 'explore',
    // 阶段号：阶段片一格＝一个阶段＝若干分段（kind → 阶段号查 domain-rules 的 SEGMENT_PHASE，别手写数字）。
    phase: SEGMENT_PHASE['explore'],
    // 原式认 exploreConfirmed 单一标记：演示书没有这个标记，于是二十几步前就干完的「读材料」
    // 一直亮着「⚡轮到你」（03/04 屏实测）。改认「状态是否正停在等确认」+「是否已推进过去」。
    status: meta?.status === 'awaiting-explore'
      ? 'waiting-user'
      : (meta?.exploreConfirmed === true || phase >= 3 ? 'done' : (pending === 'explore' ? 'active' : 'pending')),
    artifacts: ['工作区/explore.md', '工作区/knowledge-map.json'].filter(existsRel),
    redoNote: meta.exploreRedoNote ?? null,
  })
  for (const gate of ['1', '2', '3']) {
    // 2026-09-21 修：按 gate 号折（原来折"最后一个提案"，只有碰巧是它自己时才拿得到结论）。
    const folded = foldGate(projectId, gate)
    const mine = folded !== null && String(folded.gate) === String(gate) ? folded : null
    const approved = gateApproved(projectId, gate) || waived(projectId, 'gate-skip')
    push({
      key: `gate-${gate}`, label: `关卡${gate}·${GATE_LABELS[gate] ?? ''}`, kind: 'gate',
      phase: SEGMENT_PHASE['gate'],
      status: approved
        ? 'done'
        : (mine !== null && mine.status === 'awaiting'
          ? 'waiting-user'
          : (pending === 'gate' && meta?.pendingGate === gate ? 'active' : 'pending')),
      artifacts: proposalFilesOnDisk(projectId, gate).filter(existsRel),
      // 票 workbench-transitions/23：`version` 取**已决的那条提案**的版次（`decidedVersion`），
      // 不取 `mine.version`（那是最新提案的版次，awaiting 时也照样是新提案）；另把 `status` 带出来，
      // 让界面分得清「还没拍板」与「拍过了但没通过」——两者今天都落在 `approved:false` 上。
      // 票 workbench-transitions/25：`proposalVersion` 补上**最新提案**那一版——用户此刻正要拍的是它，
      // 与「已定下来的那一版」分家（v1 驳回、v2 在等时 `version` 是 1、它才是 2）。
      // ⚠️ 这两个字段名与 `foldGate` 返回值里**同名的那两个意思相反**（那边 `version` 是最新提案、
      // `decidedVersion` 是已定下来的那版），别看着"顺手"对调。
      decision: mine === null ? undefined : {
        status: mine.status,
        version: mine.decidedVersion ?? mine.version,
        proposalVersion: mine.version,
        approved: mine.status === 'approved',
        note: mine.decision?.note ?? '',
      },
    })
  }
  // 「章节安排」是第 3 次拍板定下来的东西——定过了才算做完。原式写 `phase >= 4 ? 'done' : 'active'`，
  // 于是只要章节清单已经存在（第 3 次拍板还没定）就亮「▶ 我正在做」（02 屏实测：那本书 phase=3、
  // 第 1 次拍板正等用户，步清单却把「章节安排」也报成"正在做"）。
  const gate3Ok = gateApproved(projectId, '3') || waived(projectId, 'gate-skip')
  push({
    key: 'outline', label: '章节安排', kind: 'outline',
    phase: SEGMENT_PHASE['outline'],
    status: meta?.status === 'awaiting-outline'
      ? 'waiting-user'
      : (gate3Ok || phase >= 4
        ? 'done'
        : (pending === 'outline' ? 'active' : 'pending')),
    artifacts: existsRel('工作区/outline.md') ? ['工作区/outline.md'] : [],
    redoNote: meta.outlineRedoNote ?? null,
  })
  const goldDone = meta.goldSealed != null || phase >= 5
  const goldNn = goldN(meta)
  push({
    key: 'gold', label: '最佳范例章（风格母版）', kind: 'gold',
    phase: SEGMENT_PHASE['gold'],
    status: goldDone ? 'done' : (meta.status === 'awaiting-gold' ? 'waiting-user' : (phase >= 4 ? 'active' : 'pending')),
    // ⚠️ 产物清单里的路径是**书夹相对路径**（`existsRel` 自己 join 书夹根），所以取 `chapterRel`
    // 而不是 `chapterName`——后者是基名，喂进去 `existsRel` 会去书夹根找 `chapter-NN.md`。
    // `工作区/audit-NN.md` 是 `audit` 族的同款契约（同一个补两位序号），本票只收本章正文那一族。
    artifacts: ['工作区/style-spec.md', chapterRel(goldNn), `工作区/audit-${String(goldNn).padStart(2, '0')}.md`].filter(existsRel),
    decision: meta.goldSealed == null ? undefined : { version: meta.goldSealed.version, approved: true, note: '已定稿为最佳范例章' },
    redoNote: meta.goldRedoNote ?? null,
  })
  // 一章一章写：phase>=5 不等于每一章都在写。**「我正在做」只认机器真知道的那一条**——
  // 主笔 AI 上报了这一章的流水线阶段（`meta.chapterPipeline[n-1].stage`）。
  // ⚠️ 票 24 / P17（2026-09-27）：原来这里还兜底「index === firstUndone」（第一个还没交工的章），
  // 于是那个 `▶` 的真实含义是「第一个还没交工的章」而不是「正在干的活」——从第 1 章正文写完那一刻起
  // 就钉在「第 1 章 · 写」上，直到第 1 章交工为止（交工还要等它的独立检查过，不过就一直钉着）。
  // 同一时刻章节卡说的是另一回事（第 5 章「我正在做 · 检查」），同屏两处对「这一章到哪了」打架。
  // ⇒ AI 没上报（`stageN === null`）就是**机器不知道**，不许拿「第一个还没交工的章」冒充知道。
  // 🚫 不许换成「第一张有产物的章」之类的新猜法：那只是换一个猜法，仍不是「AI 在干这一章」的事实。
  // 这一档落回 pending 之后，界面那句「还没到这一步」混着的两件事由 stage-step-model 拆开说
  // （产物已在盘上、这一章还没走完 → 「还没完成」；真没开始 → 仍说「还没到这一步」）。
  chapters.forEach((chapter, index) => {
    const n = index + 1
    const stageN = pipelineStage(meta, index)
    push({
      key: `chapter-${n}`, label: `第${n}章 ${chapter.title ?? ''}`, kind: 'chapter',
      phase: SEGMENT_PHASE['chapter'],
      status: chapterDone(projectId, n)
        ? 'done'
        : (phase >= 5 && stageN !== null ? 'active' : 'pending'),
      // F35（2026-08-20 走查）：每章流水线阶段（writing/auditing/audited/finalizing/done，未上报为 null）。
      stage: stageN,
      // 票 nav-vs-preview/01：只随过程图谱给人读摘要；原始机器 JSON 仍不开右栏。
      auditSummary: readChapterAuditSummary(projectId, n),
      artifacts: [chapterRel(n), `工作区/audit-${String(n).padStart(2, '0')}.md`].filter(existsRel),
    })
  })
  push({
    key: 'chapters-review', label: '全章过目', kind: 'review',
    phase: SEGMENT_PHASE['review'],
    status: meta?.status === 'awaiting-chapters-review' ? 'waiting-user' : (meta?.chaptersReviewed === true || existsRel('工作区/book.md') ? 'done' : 'pending'),
    artifacts: [],
  })
  push({
    key: 'merge', label: '合并成书', kind: 'merge',
    phase: SEGMENT_PHASE['merge'],
    status: existsRel('工作区/book.md') ? 'done' : (phase >= 6 ? 'active' : 'pending'),
    artifacts: existsRel('工作区/book.md') ? ['工作区/book.md'] : [],
  })
  push({
    key: 'final', label: '最后检查与交付', kind: 'final',
    phase: SEGMENT_PHASE['final'],
    // 批 1 根因修复：原式只认 delivered → done，其余 phase>=6 → active，
    // 于是终检等认可时纵向地图显示「▶ 正在做」，而横向阶段片显示「⚡轮到你」——同屏打架。
    status: meta?.status === 'delivered' ? 'done' : (meta?.status === 'awaiting-final-approval' ? 'waiting-user' : (phase >= 6 ? 'active' : 'pending')),
    artifacts: existsRel('工作区/book.md') ? ['工作区/book.md'] : [],
  })
  // 影响预告数据：每段的深改影响范围（下游段 keys / 会被归档的现存产物 / 是否可深改）。
  // demo 书不开放定点修改（canDeepModify=false，走旧全自动通道）。
  for (const seg of segments) {
    seg.artifactFacts = buildArtifactFacts(projectId, seg.artifacts)
    const affected = deepAffected(projectId, meta, seg.key)
    seg.downstream = affected === null ? [] : affected.downstream
    seg.redoFiles = affected === null ? [] : affected.files.filter((rel) => existsSync(join(projectDir(projectId), rel)))
    seg.canDeepModify = affected !== null && meta?.demo !== true
  }
  return segments
}


/** 分段清单（`/textbook/process`）：历史分段 + 影响预告 + 撤销窗口。
 *
 * ⚠️ 票 stale-detection/01：这里原来还自己列一遍子代理、把 `{running, inactive}` 随响应下发，
 * 前端拿它拼「N 个小助手在跑 / N 个完成待收」。那条路径有两个毛病：① 口径不是宿主的口径
 * （`listDescendants` 的 `activity` 说的是「记录还在不在内存里」，驻留但空闲的也算在跑）；
 * ② 前端每 2 秒轮询、拉取失败还静默保留旧值——一旦它参与抑制就成了永久消音器。
 * 小助手状态现已改读宿主推送的会话摘要（前端那份订阅本来就在），这段计数随之删除；
 * 端点本身留着，它还返回这份分段清单。 */
async function handleProcess(ctx, req, res) {
  const url = new URL(req.url, 'http://localhost')
  const sessionId = requireSession(url.searchParams.get('session'), res)
  if (sessionId === null) return
  const project = url.searchParams.get('project')
  if (project === null || !PROJECT_ID_RE.test(project)) {
    sendJson(res, 400, { ok: false, error: '缺少或非法的 project 参数' })
    return
  }
  try {
    assertSessionOwned(project, sessionId)
    // 票 12 · ①：与 `handleEvents` 同一个检测点，理由见 `engine.noteStyleSpecChange` 的注释。
    // 工作台这两条路都是 2 秒一轮，且**同时**在跑；去重（`styleSpecSeen`）保证同一次变更只记一条。
    try { noteStyleSpecChange(project) } catch { /* 记账失败不许拖垮这一轮读取 */ }
    // 书夹形状那两份表的对账事实（票 `context-budget/10`）：缺件/多件**各自点名**。
    // ⚠️ 老书没有清单 ⇒ `shape: null`，**不拦也不显示**（用户故事 12：老书照常打开、能交付）。
    let shape = null
    try { shape = bookShapeReport(project) } catch { /* 派生件读不出就当没有，不拖垮这一轮读取 */ }
    // ⚠️ **老名／新名两套同时存在的段逐条点名**（老书读侧兜底）：解析层按「新名优先」取其一，
    // 于是老的那一份会被**遮住**——不报出来，用户看到的是「我明明有产物，怎么少了一半」，
    // 而兼容层把「少东西」藏起来比不兼容更坏。空数组是常态（不是新书一律老书），恒定在场。
    let legacyDirs = []
    try { legacyDirs = legacyDirConflicts(project) } catch { /* 派生事实读不出就当没有 */ }
    sendJson(res, 200, { ok: true, project, segments: buildProcessMap(project), shape, legacyDirs })
  } catch (error) {
    sendJson(res, 500, { ok: false, error: String(error instanceof Error ? error.message : error) })
  }
}


function handleProjects(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const sessionId = requireSession(url.searchParams.get('session'), res)
  if (sessionId === null) return
  try {
    sendJson(res, 200, { ok: true, session: sessionId, projects: listProjects(sessionId) })
  } catch (error) {
    sendJson(res, 500, { ok: false, error: String(error instanceof Error ? error.message : error) })
  }
}


/**
 * GET /textbook/settings —— 全局设置快照（客户端只用它渲染 Token 卡与**上传前那道预检**）。
 *
 * 票 10：`autoSplitAvailable` 是**本机的事实**（有没有 Python + PyMuPDF），由 `mineru-lib` 的
 * 探针真探一次给出；**探针是惰性缓存的**，所以第一次要付一次子进程的开销（最坏 15 秒超时），
 * 之后这次调用都是瞬时的。⚠️ 它**故意不进**书投影的四条通道：那是「当前书的事实」，
 * 装没装 PyMuPDF 是**这台机器**的事实，两者混在一起会让切会话时多发无谓请求。
 */
async function handleSettings(_req, res) {
  try {
    const settings = readSettings()
    sendJson(res, 200, {
      ok: true,
      settings: {
        mineruTokenSet: typeof settings.mineruToken === 'string' && settings.mineruToken !== '',
        autoSplitAvailable: await autoSplitAvailable(),
      },
    })
  } catch (error) {
    sendJson(res, 500, { ok: false, error: String(error instanceof Error ? error.message : error) })
  }
}


/** 全部项目 id（注册表 + 默认目录遗留，wizard 暂存跳过）。 */
function allProjectIds() {
  const ids = new Set()
  for (const id of Object.keys(readRegistry())) {
    if (PROJECT_ID_RE.test(id)) ids.add(id)
  }
  for (const name of readdirSync(projectsRoot())) {
    if (PROJECT_ID_RE.test(name) && !name.startsWith('wizard-')) ids.add(name)
  }
  return [...ids]
}


/** 启动恢复链（术语见 CONTEXT.md）：回填老书过程记录 → 处理重做标记 → 续跑进行中的书。
 *  三步顺序属于领域知识；apply 只保留延迟时机策略（setTimeout），测试可直接调用本函数直测。 */
export function startupRecovery(ctx) {
  backfillProcessLogs()
  processRedoMarks()
  resumeRunning(ctx)
}


/** 启动续跑：把状态为 running 的书重新推进（转换中断/宿主重启后自动继续）。
 *  机器在等主 AI（pendingStage）时重新唤醒（AI 回合随宿主重启而中断，需重派）。 */
function resumeRunning(ctx) {
  // 只处理 status === 'running'；awaiting-outline / awaiting-chapters-review / 暂停等情况自然跳过（awaiting 用户确认，不自动续跑）。
  for (const id of allProjectIds()) {
    try {
      const meta = readMeta(id)
      if (meta === null || meta.demo === true) continue
      if (meta.status === 'running') {
        if (meta.pause !== null && meta.pause !== undefined) {
          ctx.logger.info('[textbook-workflow] 项目处于用户暂停，重启后保持暂停不自动续跑')
          continue
        }
        ctx.logger.info(`[textbook-workflow] 续跑项目 ${id}`)
        if (meta.pendingStage !== null && meta.pendingStage !== undefined) {
          // 恢复此前交办：重新记账 + 再唤醒主 AI（本方法幂等）。
          // ⚠️ 票 walkthrough-fixes/01（走查 P41）：原来这里**不接返回值**，于是唤醒静默失败
          // 也是一个「三层都在报成功」的结局（交办照记 → 用户看到「新一章开工了」→ AI 其实一动没动，
          // 10:07–10:12 对话页无「停止生成」按钮、账本零变化，10:13 用户手打一句「继续」才活过来）。
          // 现在接住它：`false` 时往账本里落一条 hint，用户 10 分钟内就知道要自己说一句话。
          const woke = handoff(ctx, id, meta.pendingStage, meta.pendingGate ?? null)
          if (woke === false) {
            appendEvent(id, 'textbook/hint', {
              text: '⚠️ 重启后没能把 AI 叫醒，请发一句话让它继续',
            })
          }
        } else {
          void kick(ctx, id)
        }
      }
      // awaiting-explore / awaiting-gold / awaiting-final-approval / delivered / error：停在用户确认点或终点，不自动推进。
    } catch { /* 单个项目损坏不影响启动 */ }
  }
}


/** 老书回填：过程记录.md 不存在时，把 timeline 全部事件补写成可读文档。 */
function backfillProcessLogs() {
  for (const id of allProjectIds()) {
    try {
      const meta = readMeta(id)
      if (meta === null || meta.demo === true) continue
      const logPath = processLogPath(id)
      if (existsSync(logPath)) continue
      const events = readEvents(id)
      if (events.length === 0) continue
      const lines = []
      for (const event of events) {
        const entry = logEntryText(event)
        if (entry === null) continue
        const time = new Date(event.time).toLocaleString('zh-CN', { hour12: false })
        lines.push(`### ${time}\n${entry}\n`)
      }
      if (lines.length > 0) {
        writeFileSync(logPath, lines.join('\n') + '\n')
        console.log(`[textbook-workflow] 已回填过程记录：${id}`)
      }
    } catch { /* 单本书失败不影响启动 */ }
  }
}


/** 重做标记：书夹里存在 .redo 时，重启后先重置（清产物 → 回源探查）再续跑。 */
function processRedoMarks() {
  // trash 目录真实部署里由首次删书（trashProject）创建；全新安装从未删书时不存在，
  // 不先建目录则 moveAcrossDevices 的 renameSync 对缺失父目录抛 ENOENT（非 EXDEV 不降级），
  // 被外层 catch 静默吞掉 → .redo 滞留书夹，下次重启再触发一次全量重置（workflow-seams/02）。
  // 建目录失败（如 $DSH_HOME 不可写）不阻断启动：标记滞留由下方 move 的 catch 兜底（旧行为）。
  const trash = join(dshHome(), 'textbook', 'trash')
  try { mkdirSync(trash, { recursive: true }) } catch { /* 兜底：move 侧 catch 接管 */ }
  for (const id of allProjectIds()) {
    try {
      const dir = projectDir(id)
      const mark = join(dir, '.redo')
      if (!existsSync(mark)) continue
      const workDirPath = workDir(id)
      if (existsSync(workDirPath)) {
        const archive = join(workDirPath, '_旧版产物')
        mkdirSync(archive, { recursive: true })
        const stamp = Date.now().toString(36)
        for (const name of readdirSync(workDirPath)) {
          if (name === '_旧版产物') continue
          if (name === 'explore.md' || /^chapter-\d+\.md$/.test(name) || /^audit-\d+\.md$/.test(name)
              || name === 'book.md' || name === 'style-spec.md' || name === 'outline.md') {
            try { renameSync(join(workDirPath, name), join(archive, `${name}.${stamp}`)) } catch { /* 尽力归档 */ }
          }
        }
      }
      const meta = readMeta(id)
      if (meta !== null) {
        // 重置重做的状态改动走 updateMeta（不拿手里那份旧状态整份写回）。
        updateMeta(id, (state) => {
          state.phase = 2
          state.status = 'running'
          state.converting = false
          delete state.outline
          // 票 13（spec 第 7 条 / 不变量 5）：全量重置**清 `pendingReviews`**——重排大纲后旧章号的意见
          // 不许拦到新章号上（意见是挂在章号上的，章号一旦重排，旧意见指向的就是另一章了）。
          // 同时清掉「全章过目已通过」的标记：这一程的全部章节都要重新写、重新过目。
          delete state.pendingReviews
          state.chaptersReviewed = false
        })
        try {
          appendEvent(id, 'textbook/hint', { text: '已执行「重置重做」：从读材料挑重点重新开始（材料保留）' })
        } catch { /* 账本异常忽略 */ }
      }
      // 移除标记（rmSync 在部分盘上失效，用移动代替；跨盘 EXDEV 自动降级复制+删除）。
      try {
        moveAcrossDevices(mark, join(trash, `.redo-${id}-${Date.now().toString(36)}`))
      } catch { /* 标记留着下次再处理 */ }
      console.log(`[textbook-workflow] 已重置重做：${id}`)
    } catch { /* 单本书失败不影响启动 */ }
  }
}


/**
 * 注册工作台后端。`config` 是**可选**第二实参（既有调用约定：宿主契约闸门与探针都按两实参调插件，
 * 见 `dev/host-contract-gate/probe/standing-mount-probe.js` 的 `async apply(ctx, config)`）。
 *
 * 今天它只收一个旋钮 `startupRecoveryDelayMs`（最后那个定时器的延迟，**默认仍是 3000**）：
 * 启动恢复链本身仍是一等公民、时机仍只由 apply 定（ADR-0003 决策 2），本参数只是把那个**值**
 * 变成可注入——链上那 10 次支付（9 份文件 ＋ 一个被两个导入者各 import 一遍的链外夹具）改传 `0`
 * 之后，不再各白等 3.5 秒。生产调用点一个字都不改（不传第二实参 ⇒ 3000）。
 *
 * ⚠️ 参数名只能是 `config`／`opts`：宿主契约闸门的「动态读取」只扫 `props`／`ctx` 对象面，
 * 叫 `props` 会当场踩闸（票 `test-chain-latency/03` 的决定台账第 2 条）。
 */
export function apply(ctx, config = {}) {
  bindAnnounce(ctx)

  // 票 walkthrough-fixes/28：主 AI 上下文占用的读数口（同 `bindAnnounce` 的显式契约：只在 apply 绑一次）。
  // 数据源：宿主 `ctx.sessionProjections` 的 `contextPressure` 会话投影——与宿主输入区角标
  // 「上下文已用 51%」同一份数据；折算口径是 `domain-rules.contextOccupancyPercent`（双端共用的那一份）。
  // 快照与来源路径：`docs/reference/dsh-context-occupancy-contracts.md`。
  // ⚠️ 会话不在存里 / 投影未注册 / 投影值不完整 → null（读不到），
  // 领任务说明那一句就整句不出现。
  bindContextOccupancy((sessionId) => {
    const session = ctx.sessions.get(sessionId)
    if (session === undefined || session === null) return null
    // ⚠️ 一定读 `snapshot()`（wire 视图），**不读 `stateOf()`**：后者给的是投影
    // 单位的**内部折叠态**（`surfaceTokens` / `sampledSurfaceTokens`），而 `projectedTokens` 是在 `wire.view`
    // 里现算的。读内部态会静默回退到 `pressureTokens`，给出一个与宿主输入区角标
    // **不同口径**的数字（角标走 `projectedTokens`）——那正是本仓在治的病：同一件事两套数。
    const cut = ctx.sessionProjections.snapshot(session, ['contextPressure'])
    return contextOccupancyPercent(cut.values.contextPressure)
  })
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/textbook/projects', handler: handleProjects }), 'textbook: projects route')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/textbook/events', handler: handleEvents }), 'textbook: events route')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/textbook/process', handler: (req, res) => handleProcess(ctx, req, res) }), 'textbook: process route')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/textbook/action', handler: (req, res) => handleAction(ctx, req, res) }), 'textbook: action route')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/textbook/upload', handler: (req, res) => handleUpload(ctx, req, res) }), 'textbook: upload route')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/textbook/work', handler: handleWork }), 'textbook: work route')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/textbook/file', handler: handleFile }), 'textbook: file route')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/textbook/download', handler: handleDownload }), 'textbook: download route')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/textbook/settings', handler: handleSettings }), 'textbook: settings route')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/textbook/question', handler: handleQuestion }), 'textbook: question route')
  ctx.logger.info('[textbook-workflow] 造书工作台后端已加载（步骤5：六阶段状态机）')
  // 宿主重启后延迟走启动恢复链（三步顺序见 startupRecovery；这里只定时机）。
  // 延迟值是**可注入的**（`config.startupRecoveryDelayMs`，默认 3000ms＝生产行为逐字不变）：
  // 测试传 `0` 把这次「游离的恢复」在场景开跑前烧完，不用再各等 3.5 秒。
  // ⚠️ `??` 而不是 `||`：传 `0` 是**有意义的一格**（立刻走），不能被当成缺省。
  const startupRecoveryDelayMs = config.startupRecoveryDelayMs ?? 3000
  setTimeout(() => {
    startupRecovery(ctx)
  }, startupRecoveryDelayMs)
}
