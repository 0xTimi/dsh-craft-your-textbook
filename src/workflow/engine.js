/**
 * 造书工作台 · 领域引擎（六阶段状态机核心 + 共享工具）
 *
 * 从原 src/workflow.js 整体迁出（架构评审候选 3，2026-09-01 拆分）：
 * 状态机（runPhase1..6 / runLoop / kick / handoff 等）+ 账本/事件/fs/工作产物
 * 等共享 helper 的全部传递闭包。本模块自洽（只 import 外部库），
 * 供 ./workflow.js（Web 壳）与 ./workflow/actions/*.js（动作族）共同使用。
 *
 * 六阶段：Phase 1 材料准备 / Phase 2 源探查 / Phase 3 教学设计 /
 *   Phase 4 最佳范例章 / Phase 5 全章写作 / Phase 6 终检与交付。
 * 交办机制：meta.pendingStage 记账 + ctx.agents.get(sessionId).followup() 唤醒。
 * demo 模式（演示书）与真实并轨同一套 runPhaseX 路由器（无独立 auto 通道），
 * 唯一 seam = 内容来源：真实由主 AI 完成 / demo 由内置回放（generateContent）完成；
 * demo 与真实共用全部 6 个确认闸门（源探查/关卡/骨架/范例章/全章过目/终检认可）。
 *
 * ── 内部子模块（票 `depth-review-2026-10/10`，**拆分进行中**） ──────────────────
 * 本文件正按责任簇落成 `src/workflow/engine/*.js`，自己逐步瘦成只做再导出的 facade；
 * 消费者 import 一行不改（10 个生产消费者 163 个具名绑定全部是 `import { … } from` 具名导入，
 * 纯再导出对它们零影响）。已搬走的叶子都在依赖图最底层、导出面窄：
 *   · `engine/labels.js` 领域标签 / 豁免声明表 / 状态条提示文案（零内部依赖）
 *   · `engine/paths.js`  DSH home、项目根、注册表、每本书的账本与状态与过程记录路径
 *   · `engine/store.js`  状态缓存与落盘 ＋ ADR-0016 决策 2 那四个写入口
 * 后面还有 13 簇待搬（进程日志 / 播报 / 事件账本 / 快照 / 质量门 / 六阶段状态机 / 交办说明 …）。
 * 依赖图无环，按叶子先行逐簇切；**每一步只搬不撤**——撤那 16 个零生产引用导出是另一步、另开票。
 */

// 合并自双方（票 `context-budget/02` 第 1 层带进 manifestRowsFor/SPEC_ROW_BY_PATH/DISCLOSE_MODES/
// BOOK_PRODUCT_FAMILIES，票 `context-budget/12` 带进 finalAuditSummaryRel）——**并集**，两边都不删。
import { EVENT_META, EVENT_TYPES, guessRoleFromName, gateHuman, stageLabelHuman, segmentHuman, CHAPTER_PROGRESS_REQUIREMENT, convertedState, chapterRel, chapterName, chapterShardRel, okMaterialShards, okMaterialNumbers, readingRel, readingName, DETAIL_DIR_REL, knowledgeShardRel, knowledgeShardName, FINAL_AUDIT_SCOPES, finalAuditReportRel, finalAuditSummaryRel, auditCoversProduct, stageStateOf, pairedAuditRels, manifestRowsFor, SPEC_ROW_BY_PATH, DISCLOSE_MODES, BOOK_PRODUCT_FAMILIES, PROPOSAL_DIR_REL, exploreDepthTier, CHAPTER_SUGGESTION_MIN, CHAPTER_SUGGESTION_MAX, ROLES } from '../domain-rules.js'
import { join, resolve, dirname, basename } from 'node:path'
import { mkdirSync, readFileSync, existsSync, writeFileSync, statSync, appendFileSync, readdirSync, copyFileSync, rmSync, unlinkSync, rmdirSync, renameSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { isWithin } from '../path-guard.js'
import { convertPdfBatch, readSettings, writeSettings, stripKnownExtension } from '../mineru-lib.js'
import { generateContent, resourceText, RESOURCES_DIR } from '../content-lib.js'
import { CROSS_AUDIT_TEMPLATE_REL, CROSS_AUDIT_CONSTRAINTS, CROSS_AUDIT_REPORT_REL } from './cross-audit.js'
import { refreshFinalAuditSummary } from './final-audit-summary.js'
// 票 `walkthrough-2026-10/02`：章正文由机器从分片拼——深改归档名单要认得**这一章盘上真有的分片**
// （只归档正文、把分片留在原地，重做那一路写的若是另一片，旧内容会被机器拼回正文里）。
import { chapterShardRelsOnDisk } from './chapter-assembly.js'
// 票 `premature-announce/01`：源探查那一套「盘上产物齐没齐」的判定只有一份，本文件是它的家
// （置态、放行、交工验货三处共用；模块只 import domain-rules，不成环）。
import { shardShapeProblems } from './knowledge-map-assembly.js'
import { artifactDataForStage, artifactDataForLabel, artifactDataForChapter } from './artifact-fields.js'
import { createHash } from 'node:crypto'

// ── 内部子模块：三簇叶子从本文件搬出去，而下面的 export 块把它们的导出名原样再导出 ──
// ⇒ 10 个生产消费者的 163 个 import 绑定与全仓 11 处源码锚都照旧成立，一处都不用改。
import { PROJECT_ID_RE, goldN, paragraphReviewText, WAIVER_ITEMS, PHASE_LABELS, GATE_LABELS, STAGE_LABELS, stageLabel, EXPLORE_DONE_HINT, FINAL_CHECK_DONE_HINT, REPORT_WORDING_RULE } from './engine/labels.js'
import { dshHome, projectsRoot, registryPath, readRegistry, writeRegistry, registerProject, sessionWorkspace, sanitizeFolderName, freeBookDir, projectDir, timelinePath, metaPath, processLogPath, workDir, detailDir, reportDir, proposalDir, processDir, archiveDir, materialDir, convertedDir, bookRelOnDisk, legacyDirConflicts } from './engine/paths.js'
// ⚠️ `writeMeta` **只进不出**：store.js 导出它（appendEvent 至今仍住在本文件，是账高与「最后动静
//   时刻」的唯一写入者，必须够得着它），但下面那个 export 块**不列**它——ADR-0016 决策 2 的两半。
//   防回潮断言（`key in engine`）见 test-ledger-seq-integrity.mjs。
import { assertSessionOwned, readMeta, flushMeta, updateMeta, createMeta, rollbackLedger, writeMeta } from './engine/store.js'


/** 阶段事件的人读阶段名：`data.label` 是 PHASES 的 canonical 全称（**机器身份词**，账本里就这么
 *  存着，不改），出口处过一遍界面词翻译；旧账本没带 label 时按 phase 号回落到 canonical 全称再译。
 *  译不出来原样显示（宁可露出机器词，也不猜）。 */
function phaseEventHuman(data) {
  const raw = data.label ?? PHASE_LABELS[data.phase] ?? data.phase ?? ''
  return stageLabelHuman(raw)
}


/** 暂停那一笔的附注：这次暂停**停掉了几条编排脚本**（票 `chapter-audit-orchestration/04`）。
 *
 *  措辞纪律：说词表登记的「编排脚本」，一个字都不许出现机器词「job」——「job」不在
 *  `test-wording-fixtures.mjs` 的 `BANNED_WORDS` 里（**机器抓不到**），靠人守；
 *  「子代理 / subagent」同样不许（`CONTEXT.md`「小助手」的 `_Avoid_`，机器也抓不到）。
 *
 *  为什么只有 `jobsStopped > 0` 才开口：`0` 与 `null` 各有各的实话（「确实没有在跑的」与
 *  「这一个数读不出来」），把它们翻成一句「停了 0 条」既没用、又会把「读不出来」洗成「没有」——
 *  与 `countRunningSubagents` 不肯把缺席折成 0 是同一条纪律。
 *
 *  取值域：`jobsStopped` 是正整数或 `null`（`stopRunningWorkflowJobs` 的返回值），
 *  非正整数/非整数一律当作「没有这件事实」不开口。
 */
function stoppedOrchestrationNote(data) {
  const stopped = data?.jobsStopped
  if (!Number.isSafeInteger(stopped) || stopped <= 0) return ''
  return `；这本书正在跑的编排脚本也停了（${stopped} 条）`
}


/** 事件 → 人读的过程记录条目（返回 null 表示不值得记，如转换中间进度）。 */
function logEntryText(event) {
  const data = event.data ?? {}
  switch (event.type) {
    case 'textbook/phase-start': return `🏁 阶段开始：${phaseEventHuman(data)}`
    case 'textbook/phase-end': return `✅ 阶段完成：${phaseEventHuman(data)}`
    case 'textbook/agent-start': return `🤖 AI 开始：${stageLabelHuman(data.label)}`
    case 'textbook/agent-end': return `🤖 AI 完成：${stageLabelHuman(data.label)}`
    case 'textbook/gate-proposal':
      // ⚠️ 不印「工作区/方案/关卡N-vX.md」：文件名与产物路径是**机器身份词**（判定线不改，锚定它的正则
      // 见 domain-rules 的提案白名单），印到人读文本里就把「关卡」带出来了。指个真实去处即可。
      return `📋 ${gateHuman(data.gate)} · 方案 v${data.version}：${data.title ?? ''}\n\n${data.summary ?? ''}\n\n（完整方案在书夹的「提案」文件夹里）`
    case 'textbook/gate-decision':
      return data.approved === true
        ? `✅ 第 ${data.gate} 次拍板通过（v${data.version}）${data.note ? `\n\n用户备注：${data.note}` : ''}`
        : `❌ 第 ${data.gate} 次拍板驳回（v${data.version}）${(data.reasons ?? []).length > 0 ? `\n\n驳回理由：${data.reasons.join('、')}` : ''}${data.note ? `\n\n用户意见：${data.note}` : ''}`
    case 'textbook/source-added': return `📎 已上传材料：${data.file ?? ''}（${data.role ?? ''}）`
    case 'textbook/mineru-progress': return null
    case 'textbook/rollback': return `⏪ 回退到快照 ${data.snapshot ?? ''}`
    case 'textbook/hint': return `💡 ${data.text ?? ''}`
    case 'textbook/error': return `⚠️ 出错（${stageLabelHuman(data.task)}）\n\n${data.message ?? ''}`
    case 'textbook/quality': {
      const checks = data.checks ?? []
      const pass = checks.filter((check) => check.ok === true).length
      return `🛡️ 最后检查：${pass}/${checks.length} 项通过`
    }
    case 'textbook/delivery': return '🎉 交付完成'
    case 'textbook/stage-start': return `🎯 交给 AI 动手：${stageLabelHuman(data.label ?? data.stage ?? '')}`
    case 'textbook/progress': return `⏳ ${data.label ?? ''}${data.detail ? `：${data.detail}` : ''}`
    case 'textbook/review': return `👀 抽查意见（第 ${data.chapter ?? '?'} 章《${data.title ?? ''}》）：${data.comment ?? ''}`
    case 'textbook/ai-report': return `🛡️ AI 检查报告：${data.report ?? ''}`
    case 'textbook/style-note': {
      const note = data.styleNote ?? {}
      return `🎨 风格线${data.revoked === true ? '收回' : '新增'}：${note.text ?? ''}${note.status === 'superseded' ? '（已收回）' : ''}`
    }
    case 'textbook/intervention': return `📮 留言稍后处理：${data.text ?? ''}`
    case 'textbook/intervention-done': return `📮 留言已处理：${data.text ?? ''}`
    case 'textbook/waiver': return `赦 ✅ 已获用户豁免「${WAIVER_ITEMS[data.item]?.label ?? data.item}」：${data.userNote ?? ''}`
    case 'textbook/waiver-revoke': return `赦 ↩️ 豁免已收回「${WAIVER_ITEMS[data.item]?.label ?? data.item}」，机器恢复拦截`
    case 'textbook/pause': return `⏸ 已暂停（${data.reason ?? '用户在造书工作台点击暂停'}）${stoppedOrchestrationNote(data)}`
    case 'textbook/resume': return `▶ 已继续`
    case 'textbook/outline-decision':
      return data.approved === true
        ? `✅ 章节安排已通过${data.note ? `\n\n用户备注：${data.note}` : ''}`
        : `↩️ 章节安排已驳回${data.note ? `\n\n用户意见：${data.note}` : ''}`
    case 'textbook/gold-opinion': {
      // 票 09（走查 P26）：撤回那一支**先于**取 opinion 返回——`data.revoked === true` 的事件
      // 没有 `opinion` 字段，硬往下走会渲染成「#undefined（笼统）undefined」那行乱码。
      if (data.revoked === true) {
        return `↩️ 已撤回${Number.isSafeInteger(data.chapter) ? `第 ${data.chapter} 章` : ''}的一条意见：AI 不再照它改，也不再拦这一章交工`
      }
      const o = data.opinion ?? {}
      const verbs = { dislike: '不喜欢', drop: '不需要', change: '要改成' }
      const wish = typeof o.wish === 'string' && o.wish !== '' ? `：${o.wish}` : ''
      // 票 07（P25）：这一行原本读 `o.seq`（＝`data.opinion.seq`），而**意见的编号不在那里**——
      // 落账时它在事件 `data` 的顶层（`workflow/actions/gold.js` 写的是 `{ seq, opinion:{ id, at, target, kind, wish, status } }`），
      // 条目自身的 id 则嵌在 `data.opinion.id`。两处路径都取不到值，于是《过程记录.md》与右栏
      // 那个「过程记录」面板**同一处**印出 `✍️ 最佳范例章意见#undefined`（一处字段写错、两个出口一起错
      // ——它们共用本函数）。改成按「顶层编号 → 条目 id」的次序取，取不到就不印编号（不拿 undefined 上屏）。
      const no = data.seq ?? o.id
      return `✍️ 最佳范例章意见${no === undefined || no === null || no === '' ? '' : `#${no}`}（${o.target ?? '笼统'}）${verbs[o.kind] ?? o.kind}${wish}`
    }
    case 'textbook/gold-seal': return `🏆 最佳范例章已定稿（v${data.version ?? '?'}），意见沉淀入风格线（${data.count ?? 0} 条）`
    case 'textbook/gold-chapter':
      return `👑 最佳范例章：第 ${data.chapter ?? '?'} 章${data.reason ? `\n\n选择理由：${data.reason}` : ''}`
    case 'textbook/chapters-review':
      return `🔍 章节过目确认（${data.approved === true ? '通过' : '驳回'}）`
    case 'textbook/final-approve':
      return data.approved === true
        ? `✅ 最后检查通过，交付完成`
        : `↩️ 最后检查未获认可，交办修订${data.note ? `\n\n改进意见：${data.note}` : ''}`
    case 'textbook/deep-modify':
      // `data.segment` 是**机器身份词**（`gate-1` / `explore` / `chapter-03` 这类 seg.key，账本里就这么存的，
      // 不改）；但这一行是写进《过程记录.md》给人读的（判定线②），所以过一遍界面词翻译
      // （2026-09-20 复审 a-4：原先直接把 seg.key 印到人读流水账里）。译不出来原样显示。
      return `✏️ 定点修改「${segmentHuman(data.segment)}」并重做下游${data.note ? `\n\n用户说明：${data.note}` : ''}`
    case 'textbook/deep-undo':
      return `↩️ 撤销定点修改「${segmentHuman(data.segment)}」`
    case 'textbook/pattern-added':
      return `📇 已加自定义模式：${data.name ?? ''}`
    // 交工/提审被拒（票 01 (d)）：写进《过程记录.md》的那一行——`stage` 与原因都在事件 data 里，
    // 人读文本说「交工被拒：<原因>」。
    //
    // ⚠️ **`logEntryText` 这一个出口不印阶段**（票 `audit-matrix-contract/06`，2026-09-29 用户拍板
    // 选 ②；这条注释就是票面要求的「四个出口逐个点名、各有理由」里 engine 侧那一处的落笔）。
    // **不印的理由**：这一行是**已经发生的事**的流水记录，阶段从「事件属于哪一步」已经能由上一条
    // `textbook/stage-start` 读出来；在这里再印一次等于同一屏/同一份文件里把同一件事说两遍。
    // 而**尚未解决的**那一条（用户此刻要知道「我这次交工卡在合并还是最后检查」）由界面事件行的
    // **展开详情**那一格承担（`src/ui/event-cards.js` 的 `replayRowDetail`，印人话词）。
    // 与上面 `announceText` 是两处**同理由、不同对象**（一份是文件流水、一份是对话播报）。
    case 'textbook/submit-rejected': return `🚫 交工被拒：${data.reason ?? ''}`
    // 票 12 · ①：《过程记录.md》那一行（事后翻账的人看的）。措辞与对话播报**共用**下面那一份
    // `styleSpecChangeWhen`——两处各写一遍就是「一处改、另一处漏」。
    case 'textbook/style-spec-change':
      return `📝 写作规范在范例章定稿后被改过：${styleSpecChangeWhen(data)}`
    default: return null
  }
}


/**
 * 「写作规范变更」那一笔要说清的两件事（**两个出口共用这一份**，不各写一遍）：
 * **哪一版变了**（指纹）与**此刻已经写了多少章**（不一致的波及面）。
 * 读不出指纹就说「读不到」——**读不出不是「没变」**（那会让真被改过的人以为自己没问题）。
 */
function styleSpecChangeWhen(data) {
  const from = typeof data?.from === 'string' && data.from !== '' ? data.from : '读不到'
  const to = typeof data?.to === 'string' && data.to !== '' ? data.to : '读不到（文件已不在）'
  const n = Number.isSafeInteger(data?.chapters) ? data.chapters : null
  const written = n === null ? '' : `，此刻已写 ${n} 章`
  return `改动前 ${from} → 改动后 ${to}${written}`
}


/**
 * 一条「工作台提示」消息（`CONTEXT.md` 词条：机器以 plugin+notice 注入对话流，**不冒充用户说话**）。
 *
 * **纯函数：只造出消息，不发。** 三个出口（`agent.followup` / `agent.inject` / `session.append`）
 * 各自有**正交的活锁规则**（见 `announceToSession` 上方那段：`status === 'running'` 走 inject、
 * 只有 idle 才 append、读不到就 warn 并放弃），合并不划算 ⇒ **策略留在调用方，只抽形状**。
 *
 * ⚠️ 票 `deep-module-scan/09`：这 4 条路径原先**各自手搓一遍**逐字相同的形状
 * （`announceToSession` / `wakeMainAI` / `nudge` / `resume`），而写错的代价**不是一次报错**——
 * `announceToSession` 上方那段注释记着 2026-09-23 的真机事故：**畸形历史一旦落盘，之后每个请求都 400，
 * 压缩也救不回来**。⇒ 同一份知识有四条传播路径，一处写错要改四处。
 *
 * ⚠️ **`source.kind` 必须是 v4 的 producer-owned 形状** `{kind: 'plugin:<名字>', form, summary}`——
 * `{ kind: 'plugin', plugin: '…' }` 那个 v3 包装已被宿主 0.1.7 的会话准入门**明确退役**
 * （`dsh-session-format-v3-to-v4 source()`：`kind === 'plugin'` 直接抛
 * `format v4 message requires a producer-owned source kind`，整轮判失败）。完整口径见
 * `announceToSession` 上方注释（那里讲得更细，**别删那段**，它记的是那次事故与宿主改写口径）。
 *
 * ⚠️ **文案一个字都不在这里**：`text` 与 `summary` 由调用方给。唤醒文案的措辞有逐字断言
 * （`test-startup-recovery.mjs:286-292`），改文案是另一件事。
 *
 * @param {{ idPrefix: string, text: string, summary: string }} parts
 * @returns {{ id: string, role: 'user', content: Array<{type: 'text', text: string}>, source: object }}
 */
function noticeMessage({ idPrefix, text, summary }) {
  return {
    // id 要唯一：同一毫秒里可能发两条（前缀不同），所以后缀带随机尾巴。
    // ⚠️ `nudge` / `resume` 原先**只有 base36 时间戳、没有随机尾巴**——统一后多了这一段，
    //   那只让它更不会撞（id 撞了宿主会当重复消息），不改变任何可观察行为。
    id: `${idPrefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    // content 恰好一个 text 块（第二个块会被宿主格式准入门拒）。
    content: [{ type: 'text', text }],
    source: { kind: 'plugin:dsh-craft-your-textbook', form: 'notice', summary },
  }
}


/** 该豁免项当前是否有效（真实模式 + userNote 非空才算数）。 */
function waived(projectId, item) {
  const meta = readMeta(projectId)
  if (meta === null || meta.demo === true) return false
  return (meta.waivers ?? []).some((w) => w.item === item && typeof w.userNote === 'string' && w.userNote.trim() !== '')
}


/** 事件 → 主对话播报文本（null 表示不值得播报，只进项目时间线）。
 *  频率收紧：主 AI 现场讲话已覆盖的过程性事件（子代理起止/交办/进度/抽查/AI 报告）
 *  一律不播；用户新增的风格意见是自己刚点的，也不播（机器收回才值得告知）。 */
function announceText(event) {
  // 沉默策略收进 EVENT_META（announce: false = 该型机器不开口；见 CONTEXT.md 工作台提示/验货频率收紧）：
  // 主 AI 现场已讲的过程性事件、用户自己刚做的动作、纯机器内部事件一律不重复播报。
  if (EVENT_META[event.type]?.announce === false) return null
  const data = event.data ?? {}
  switch (event.type) {
    case 'textbook/phase-start': return `🏁 阶段开始：${phaseEventHuman(data)}`
    case 'textbook/phase-end': return `✅ 阶段完成：${phaseEventHuman(data)}`
    case 'textbook/gate-proposal':
      return `📋 ${gateHuman(data.gate)} · 方案 v${data.version}：${data.title ?? ''}（工作台里可看完整方案）`
    case 'textbook/gate-decision':
      return data.approved === true
        ? `✅ 第 ${data.gate} 次拍板通过（v${data.version}）`
        : `↩️ 第 ${data.gate} 次拍板被驳回（v${data.version}），AI 正在修订`
    case 'textbook/rollback': return `⏪ 已回退到快照 ${data.snapshot ?? ''}`
    case 'textbook/error': return `⚠️ 出错（${stageLabelHuman(data.task)}）：${String(data.message ?? '').slice(0, 200)}`
    case 'textbook/quality': {
      const checks = data.checks ?? []
      const pass = checks.filter((check) => check.ok === true).length
      return `🛡️ 最后检查：${pass}/${checks.length} 项通过`
    }
    case 'textbook/delivery': return '🎉 书做好了！工作台里可以预览和下载。'
    case 'textbook/hint': {
      // ⚠️ **纯机器内部的一步不播报**（票 `walkthrough-2026-10/02` 的 `chapter-assemble` 留痕）：
      // 那是主笔自己刚叫过的一步（`workbench_act(action=chapter-assemble)`），机器再在对话里
      // 回一句就是「重复播报主 AI 现场已讲的过程性事件」——那条红线写在 `EVENT_META.announce`
      // 那段注释里。它照旧进项目时间线与《过程记录.md》（`logEntryText` 不认这一枚标记）。
      if (data.machine === 'chapter-assemble') return null
      return typeof data.text === 'string' && data.text !== '' ? `💡 ${data.text}` : null
    }
    case 'textbook/style-note':
      // 收回才值得告知；新增的意见是用户自己刚点的，不播。
      if (data.revoked !== true) return null
      return `🎨 风格线收回了一条意见（${String(data.styleNote?.text ?? '').slice(0, 40)}）`
    case 'textbook/intervention': return `📮 已留言：${String(data.text ?? '').slice(0, 60)}（不打断 AI 手里的活，下个停靠点处理）`
    case 'textbook/waiver': return `✅ 已按你的特殊要求放行：${WAIVER_ITEMS[data.item]?.label ?? data.item}`
    case 'textbook/pause': return `⏸ 已暂停（${data.reason ?? '用户在造书工作台点击暂停'}）${stoppedOrchestrationNote(data)}`
    case 'textbook/resume': return `▶ 已继续`
    case 'textbook/outline-decision':
      return data.approved === true
        ? `✅ 章节安排已确认`
        : `↩️ 章节安排已被驳回，AI 正在重新安排`
    case 'textbook/gold-seal': return `🏆 最佳范例章已定稿（v${data.version ?? '?'}），意见沉淀入风格线（${data.count ?? 0} 条）`
    // 交工/提审被拒（票 01 (d)）：用户看得见机器挡下了什么——这正是被「机器报错、AI 说没事」坑过的那个用户。
    //
    // ⚠️ **这里也不印阶段**（票 `audit-matrix-contract/06`，2026-09-29 用户拍板选 ②）。
    // **不印的理由**：这句是**发给主笔 AI、由它转述给用户**的对话流播报（判定线③），不是给人直接看的
    // 界面行——它整句被 `.slice(0, 200)` 截断，再塞一个阶段前缀就是拿配额换一句用户已经能从横幅
    // 看到的话；而 `reason` 本身已经是**机器拟的可行动报错**，主笔 AI 拿到它就知道该回哪一步。
    // 界面上用户要读的那一格是事件行的**展开详情**（`src/ui/event-cards.js` 的 `replayRowDetail`），
    // 那里才印人话阶段词。**这不是漏了，是四个出口里逐个点名后的第三处「不印」。**
    case 'textbook/submit-rejected': return `🚫 交工被拒：${String(data.reason ?? '').slice(0, 200)}`
    // 票 12 · ①：机器替 AI 记「它改了机器契约」这一笔。**两个出口都开口**——
    // 《过程记录.md》是事后翻账的人看的，对话播报是**当下**就该让用户与主笔 AI 知道的那一条
    // （此刻已写的那些章是照改动前那一版写的，这是不一致的唯一一处可核证据）。
    case 'textbook/style-spec-change':
      return `📝 写作规范在范例章定稿后被改过（${styleSpecChangeWhen(data)}）`
    default: return null
  }
}


/** 把一条机器播报追加到主会话（对话流里能看到机器在干什么）。
 *  形态：plugin 来源的 user/message「notice 注入行」——客户端把它归类为上下文行
 *  （折叠一行摘要 + 可展开全文），节点身份用消息 id，与回合体系完全解耦。
 *  旧实现伪造完整 turn 信封（turn/start→turn/end，号码取日志最大值+1），与真实
 *  主 AI 自己的回合计数冲突：客户端把重复的 assistant-step:${turn}:${step} 当致命
 *  错误抛出，且异常发生在推送管道里——之后到达的一切事件都进不了聊天视图（对话
 *  冻结、刷新重放也复崩）。已废弃该形态；历史遗留的存量信封组已由一次性修复脚本
 *  （fix-announce.mjs，已删）清理完毕，不再需要手动清理。
 *  安全闸（2026-09-24 重做）：AI 回合进行中绝不 `session.append`。notice 虽不占回合号，
 *  但落在「assistant 工具调用」与「tool 结果」之间仍会破坏下轮请求的消息相邻性——
 *  下轮请求会带上**同一 tool_call_id 的两条结果**（宿主现造的占位 + 迟到真结果），
 *  模型接口以 400 拒绝（`{"model":"…"}` 畸形体），且该畸形历史一旦落盘，之后每个请求
 *  都 400、压缩也救不回来（2026-09-23 真机事故：整本《抑郁自救…》会话就此卡死）。
 *  旧实现扫 `session.events` 的 turn/start↔turn/end 判「回合是否进行中」——真机上没拦住
 *  （快照滞后），故改用宿主公开的 `agent.status`：
 *    - `running` → 走 `agent.inject`（inbox / next-step / 不唤醒），由宿主在步边界安全插入；
 *    - `idle`（或没有活的主 AI）→ 直接 append，此刻没有在飞的 tool 调用，安全；
 *    - 拿不到 status → 保守放弃这次播报（工作台时间线里仍可见，绝不冒险污染会话）。 */
function announceToSession(ctx, sessionId, text) {
  try {
    const firstLine = (text.split('\n', 1)[0] ?? text).trim()
    // user/message 的 data 就是消息本身（不是 assistant/message 的 {message:...} 包裹）。
    // 写错形状会让宿主模型请求构建时读 data.source.kind 崩（.kind undefined），已修。
    // ⚠️ source 必须是 **v4 的 producer-owned 形状**：`{ kind: 'plugin', plugin: '…' }` 那个
    // v3 包装已被宿主 0.1.7 的会话格式准入门**明确退役**（dsh-session-format-v3-to-v4
    // `source()`：`kind === 'plugin'` 直接抛 `format v4 message requires a producer-owned
    // source kind`，整轮判失败）。宿主自己的改写口径见同文件 `producerKind()`：
    // kind 变成 `plugin:<名字>`，且 **`plugin` 键被丢掉**，form/summary 原样保留。
    const message = noticeMessage({
      idPrefix: 'tb-note',
      text,
      summary: `工作台：${firstLine.slice(0, 60)}`,
    })
    const agent = ctx.get('agents')?.get?.(sessionId)
    if (agent !== undefined) {
      const status = typeof agent.status === 'string' ? agent.status : undefined
      if (status === 'running') {
        // ⚠️ 双轴 review（2026-09-29，票 announce-adjacency/02）修的两处：
        // 「保守放弃」在本函数里**只有一种报法**——放弃必须 warn。
        // 原来这里是静默 `return`，而同一条路径上「拿不到 status」是 warn 的：
        // 同一个动作、两种报法，用户排查时会以为「没有放弃」，实际是被丢掉了。
        if (typeof agent.inject !== 'function') {
          ctx.logger.warn('textbook: 播报跳过——agent.inject 不可用（宿主 facade 与本仓用的不是同一枚）')
          return
        }
        agent.inject(message)
        return
      }
      // ⚠️ 同上第二处：这条 warn 原文写「拿不到 agent.status」，但它**也**在
      // 「拿到了、且不是 idle」时触发（上游新增任何一个状态值都会落这里）。
      // 文案与覆盖范围不符 ⇒ 排查会被引向「facade 改名了」这个错方向。
      // 两个读数都点出来：**读到的值**与**它为什么不能当成收口**。
      if (status !== 'idle') {
        const read = status === undefined ? '读不到' : `读到 ${JSON.stringify(status)}`
        ctx.logger.warn(`textbook: 播报跳过——${read} agent.status，无法确认回合已收口（只有 idle 才落会话）`)
        return
      }
    }
    const session = ctx.get('sessions')?.get?.(sessionId)
    if (session === undefined) return
    session.append('user/message', message, { surfaceOp: 'append' })
  } catch (error) {
    ctx.logger.warn(`textbook: 主对话播报失败: ${String(error instanceof Error ? error.message : error)}`)
  }
}


/** 播报入口：低价值事件只进项目时间线；相邻事件合并成一条注入行
 *  （如「✅ 阶段完成：源探查 → 🏁 阶段开始：教学设计」）。
 *  暂存按 project 记（进程内即可；跨重启最多丢一次合并机会，无实质影响）。 */
const pendingPhaseEnd = new Map()


/** 拒收去重记忆：project → 上一次**已开口**的 `(stage, 逐字 reason)` 键（票 `audit-matrix-contract/04`，
 *  裁决**乙**：同 project 的**连续同文**拒收不再原样 inject 第二遍）。
 *
 *  ⚠️ 消的是「返工循环里同文反复堆叠」，**不是**「单次事件里 400 与 notice 各一份」——单次那两份
 *  来自**两个不同的面**（工具结果 400 / 对话流 notice），工具结果那一份本票不该动。
 *
 *  合并键：**三者全同**才合并（project 天然按 key 分桶，故比的是 `stage` + 逐字 `reason`）。
 *  两者是 `===` 逐字比，**刻意不用 `includes`／归一化**——票 02 铺满的 20 处 reason 逐字未改，
 *  「异文」是真实情形；宽松判据会把两次不同的拒收并成一条看不出所以然的记录。
 *  **至少保留第一次开口**：只有「上一次开口就是同一篇」时才吞掉这一次。
 *  任何**别的**播报插在中间即清空记忆——「连续」按对话流里真正相邻判，不是「同 project 历史上出现过」。
 *  进程内暂存即可（跨重启最多多播一次，与 `pendingPhaseEnd` 同一取舍）。 */
const lastRejectAnnounce = new Map()

/** 拒收的合并键：`stage` + NUL + **逐字** `reason`。分隔符取 NUL，任何 stage/reason 组合都不会撞键。 */
function rejectDedupKey(data) {
  const stage = String(data?.stage ?? '')
  return `${stage}\u0000${String(data?.reason ?? '')}`
}

function announceEventToSession(ctx, projectId, meta, event) {
  const sessionId = meta.session
  if (typeof sessionId !== 'string' || sessionId === '') return
  if (event.type === 'textbook/phase-end') {
    // 它迟早会占掉对话流里的一行 ⇒ 同样打断「连续」，一并清空拒收去重记忆。
    lastRejectAnnounce.delete(projectId)
    pendingPhaseEnd.set(projectId, { text: announceText(event), time: event.time })
    return
  }
  const text = announceText(event)
  if (text === null) return
  // 拒收去重（票 `audit-matrix-contract/04` · 乙）：只在「上一次开口就是同一篇」时吞掉这一次，
  // 所以第一次照旧开口（机器确实挡了的那条线索不许消失）。判据逐字，比键不含任何宽松匹配。
  if (event.type === 'textbook/submit-rejected') {
    const key = rejectDedupKey(event.data)
    if (lastRejectAnnounce.get(projectId) === key) return
    lastRejectAnnounce.set(projectId, key)
  } else {
    // 别的播报插在中间 ⇒ 不再「连续」：下一次同文拒收必须重新开口。
    lastRejectAnnounce.delete(projectId)
  }
  const held = pendingPhaseEnd.get(projectId)
  pendingPhaseEnd.delete(projectId)
  if (held !== undefined && held.text !== null) {
    if (event.type === 'textbook/phase-start' && event.time - held.time < 60_000) {
      announceToSession(ctx, sessionId, `${held.text} → ${text}`)
      return
    }
    announceToSession(ctx, sessionId, held.text)
  }
  announceToSession(ctx, sessionId, text)
}


/** 账本里已有的**最大序号**（空账本 -1）。给已坏的老账本补基线用：下一笔的序号必须**大于它**——
 *  否则既和账本里已有的一笔撞号，又小于前端已收到的最大序号（页面继续不更新，「只增且唯一」在这本书上
 *  永远不成立）。**刻意不缓存**：账本会被回退快照 / 深改截断（文件变小），缓存一份「曾经的最大值」
 *  正是新一类旧值 bug。账本不大，这段 O(行数) 的读只在「记一笔」时发生。 */
function ledgerMaxSeq(projectId) {
  let max = -1
  for (const event of readEvents(projectId)) {
    if (Number.isSafeInteger(event?.seq) && event.seq > max) max = event.seq
  }
  return max
}


/** 「记一笔」：账本与「账高 / 最后动静时刻」的**唯一**写入者（ADR-0016 决策 1）。
 *  序号取「账高」，但已坏的老账本（账高小于账本最大序号）只补基线——**不重写旧行、不重排序号**。 */
function appendEvent(projectId, type, data, duration) {
  if (!EVENT_TYPES.has(type)) throw new Error(`textbook: unknown event type ${JSON.stringify(type)}`)
  const meta = readMeta(projectId)
  if (meta === null) throw new Error(`textbook: unknown project ${JSON.stringify(projectId)}`)
  const path = timelinePath(projectId)
  const seq = Math.max(meta.eventCount ?? 0, ledgerMaxSeq(projectId) + 1)
  const event = { seq, time: Date.now(), type, data }
  // duration（毫秒）：P2-9 性能基线用——调用方把紧邻操作的耗时带进来（如 agent-start→agent-end）；
  // cassette 回放不比对该字段，只比对事件类型序列/产物指纹/终态。
  if (Number.isFinite(duration) && duration >= 0) event.duration = Math.round(duration)
  appendFileSync(path, JSON.stringify(event) + '\n')
  meta.eventCount = seq + 1
  meta.updatedAt = event.time
  writeMeta(meta)
  // 人读的过程记录镜像（过程以文档形式留在文件夹里）。
  try {
    const entry = logEntryText(event)
    if (entry !== null) {
      const time = new Date(event.time).toLocaleString('zh-CN', { hour12: false })
      appendFileSync(processLogPath(projectId), `### ${time}\n${entry}\n\n`)
    }
  } catch { /* 过程记录失败不影响主流程 */ }
  // 主对话播报：让用户在对话流里看到机器在干什么（notice 注入行，不再伪造回合）。
  try {
    if (announceCtx !== null) announceEventToSession(announceCtx, projectId, meta, event)
  } catch { /* 播报失败不影响主流程 */ }
  return event
}


function readEvents(projectId, after) {
  const path = timelinePath(projectId)
  if (!existsSync(path)) return []
  const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '')
  // 单行损坏不炸全局：跳过并告警（账本尾行被截断等场景；比抛错后整本不可用好）。
  const events = []
  for (const line of lines) {
    try { events.push(JSON.parse(line)) } catch { console.error(`[textbook-workflow] 账本行损坏已跳过：${path}`) }
  }
  return after === undefined ? events : events.filter((event) => event.seq > after)
}


/** 项目列表（按更新时间倒序；严格会话隔离：只列本会话的项目，一个会话至多一本）。 */
function listProjects(sessionId) {
  const projects = []
  const seen = new Set()
  // 1) 注册表里的项目（工作区书夹）
  for (const id of Object.keys(readRegistry())) {
    if (!PROJECT_ID_RE.test(id)) continue
    seen.add(id)
    const meta = readMeta(id)
    if (meta === null) continue
    if (meta.session !== sessionId) continue
    projects.push(meta)
  }
  // 2) 默认目录里未登记的遗留项目（旧书 / wizard 暂存目录跳过）
  for (const name of readdirSync(projectsRoot())) {
    if (seen.has(name) || !PROJECT_ID_RE.test(name) || name.startsWith('wizard-')) continue
    const meta = readMeta(name)
    if (meta === null) continue
    if (meta.session !== sessionId) continue
    projects.push(meta)
  }
  projects.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  return projects
}


/**
 * 递归复制目录/文件（手动实现：mkdir + readdir + copyFileSync）。
 * 刻意不用 fs.cpSync：实测 cpSync 对某些真实书文件夹（含特定 PDF 的目录）会触发
 * Node 原生崩溃（0xC0000409 STATUS_STACK_BUFFER_OVERRUN，独立进程可复现，
 * 2026-08-20 实书走查 F27 发现）——逐文件复制实测安全。
 */
function copyTreeSync(src, target) {
  const st = statSync(src)
  if (st.isDirectory()) {
    mkdirSync(target, { recursive: true })
    for (const name of readdirSync(src)) {
      copyTreeSync(join(src, name), join(target, name))
    }
  } else {
    copyFileSync(src, target)
  }
}


/**
 * 删除目录/文件（尽力而为，绝不抛错拖垮删除主流程）。
 *
 * ⚠️ 2026-08-21 实测复现修复（取消书 → dsh 整体崩掉）：
 * `fs.rmSync(path, { recursive: true })` 在 Windows 上对**含中文的路径**会触发
 * Node **原生崩溃**（0xC0000409 STATUS_STACK_BUFFER_OVERRUN，直接崩掉整个宿主
 * 进程，JS try/catch 拦不住）。F27 走查只记录过它"静默失效"，没料到还会硬崩。
 * 因此**真实默认路径不再调用 fs.rmSync 递归删除**，改用手动逐文件删除
 * （readdirSync + unlinkSync/rmdirSync，实测安全）；删不干净时**按平台兜底**——
 * Windows 走 `cmd /c rmdir /s /q`（这条路上 fs.rmSync 不能用，中文路径会原生崩溃），
 * POSIX 走 fs.rmSync 递归（那条原生崩溃是 Windows 独有的，POSIX 上没有理由不用）——
 * 再失败则保留待下次清理。
 *
 * 两个分支都得在：兜底被 `process.platform === 'win32'` 整段门住的话，非 Windows
 * 上「删不干净」就等于「永远不删」（书夹留在原处），而这类差异只有换台机器才看得见。
 * `rm` 参数保留可注入（测试用：模拟 rmSync 静默失效的旧行为）。
 */
function removeTree(src, rm) {
  if (rm === rmSync) {
    // 真实 rmSync：跳过（中文路径会原生崩溃），直接手动逐文件删除。
    try { removeTreeManual(src) } catch { /* 已尽力；继续兜底 */ }
  } else {
    // 注入的 rm（测试模拟）：保留调用形态，删除结果由手动/兜底保证。
    try { rm(src, { recursive: true, force: true }) } catch { /* 已尽力 */ }
  }
  if (existsSync(src)) {
    if (process.platform === 'win32') {
      try { execFileSync('cmd', ['/c', 'rmdir', '/s', '/q', src], { stdio: 'ignore' }) } catch { /* 保留待下次清理 */ }
    } else {
      try { rmSync(src, { recursive: true, force: true }) } catch { /* 保留待下次清理 */ }
    }
  }
}


/** 手动递归删除（readdir + unlink/rmdir；刻意不用 fs.rmSync 递归，避开原生崩溃）。 */
function removeTreeManual(node) {
  const st = statSync(node)
  if (st.isDirectory()) {
    for (const name of readdirSync(node)) {
      try { removeTreeManual(join(node, name)) } catch { /* 单个条目失败不阻断 */ }
    }
    try { rmdirSync(node) } catch { /* 已尽力 */ }
  } else {
    try { unlinkSync(node) } catch { /* 已尽力 */ }
  }
}


/**
 * 移动文件/目录到目标：同盘走 rename（快）；跨盘（EXDEV，如书文件夹在 D:\ 而 $DSH_HOME 在 C:\）
 * 降级为复制到目标 + 删除原路径（行为等价，只是多一次 IO）。
 * rename/rm 可注入（测试用）；非 EXDEV 错误原样抛出，不吞。
 */
export function moveAcrossDevices(src, target, rename = renameSync, rm = rmSync) {
  try {
    rename(src, target)
    return true
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
    copyTreeSync(src, target)
    removeTree(src, rm)
    return true
  }
}


/** 把项目移入回收站目录（数据不删，只是移走；注册表条目由调用方决定去留）。 */
function trashProject(projectId) {
  const trash = join(dshHome(), 'textbook', 'trash')
  mkdirSync(trash, { recursive: true })
  const target = join(trash, `${projectId}-${Date.now().toString(36)}`)
  moveAcrossDevices(projectDir(projectId), target)
  return target
}


// ── 快照与回退 ──────────────────────────────────────────────────────────────

/**
 * 存档目录（`过程/存档/`）——票 `13` 从书夹根下平级的一层搬进 `过程/`。
 *
 * ⚠️ **旧名那段无斜杠**（spec 实现决策 25 点名的那个坑）：定义点原先是
 * `join(projectDir(id), <段名>)`、段名后面**不带斜杠**，按「带斜杠」去数命中会**漏掉定义点本身**。
 * 现在它经 `paths.archiveDir()` 拼，段名住在 `domain-rules.js` 的 `ARCHIVE_DIR_NAME`——
 * **本文件一个字都不许再写死目录名**。
 */
function snapshotsDir(projectId) {
  return archiveDir(projectId)
}


/** 截断/回退时把用户的声音（风格线/豁免/未处理留言/**抽查意见**）合并回恢复后的 meta：现在优先，按 id 去重。 */
function mergeUserVoice(currentMeta, restoredMeta) {
  const mergeList = (restored, current, keyOf) => {
    const byId = new Map((restored ?? []).map((item) => [keyOf(item), item]))
    for (const item of current ?? []) byId.set(keyOf(item), item) // 现在优先
    return [...byId.values()]
  }
  restoredMeta.styleNotes = mergeList(restoredMeta.styleNotes, currentMeta?.styleNotes, (n) => n.id)
  restoredMeta.waivers = mergeList(restoredMeta.waivers, currentMeta?.waivers, (w) => w.id)
  const pendingNow = (currentMeta?.pendingInterventions ?? []).filter((i) => i.status === 'pending')
  restoredMeta.pendingInterventions = mergeList(restoredMeta.pendingInterventions, pendingNow, (i) => i.id)
  // 票 13（spec 第 7 条 / 不变量 5「账本与 meta 同源」）：抽查意见也是「用户的声音」，回退的合并口
  // 原先只并 styleNotes/waivers/interventions，于是回退会把**快照之后新提的意见整批丢掉**（用户提了
  // 意见却再也看不到），也会把快照里已 applied/revoked 的旧状态盖回现在已翻案的那条上。两处一起并。
  // 老账本的意见可能没有 id（票 09 之前的入账）→ 退化成「章号 + 意见原文」当键，仍能去重、仍不丢。
  const reviewKey = (r) => (typeof r?.id === 'string' && r.id !== '' ? r.id : `#${r?.chapter ?? '?'}:${String(r?.comment ?? '')}`)
  restoredMeta.pendingReviews = mergeList(restoredMeta.pendingReviews, currentMeta?.pendingReviews, reviewKey)
  return restoredMeta
}


/** 目录里现有的最大快照号（没有 / 读不到时 0）——「快照文件名序号永不复用」的判据来源。
 *  注意这是**快照文件名序号**，与账本序号 / 账高（ADR-0016）是两套编号，别混。 */
function maxSnapshotSeqOnDisk(projectId) {
  let max = 0
  try {
    for (const name of readdirSync(snapshotsDir(projectId))) {
      const hit = /^(\d+)\.json$/.exec(name)
      if (hit !== null) max = Math.max(max, Number(hit[1]))
    }
  } catch { /* 目录读不到：退化为只用 meta.snapshotSeq */ }
  return max
}


function writeSnapshot(projectId, reason) {
  const events = readEvents(projectId)
  // 快照序号只增：读→改→写收在 updateMeta 里（这里也刻意不再写 updatedAt——「最后动静时刻」
  // 只归「记一笔」所有；调用方随后都会落一条事件，时刻由那条事件定）。
  // 票 workbench-transitions/19：`restoreSnapshot` 用 `{ ...snapshot.meta }` 把旧 `snapshotSeq` 一并写回，
  // 只按「旧号 + 1」就会落到一个**已经存在**的 `<seq>.json` 上、把旧存档整份覆盖掉（回退＝丢版本）。
  // 所以号取「目录现有最大号」与 `meta.snapshotSeq` 的较大者再 +1——文件名序号**永不复用**。
  const meta = updateMeta(projectId, (state) => {
    state.snapshotSeq = Math.max(maxSnapshotSeqOnDisk(projectId), state.snapshotSeq ?? 0) + 1
  })
  const snapshot = { seq: meta.snapshotSeq, eventCount: meta.eventCount ?? events.length, time: Date.now(), reason, meta, events }
  writeFileSync(join(snapshotsDir(projectId), `${meta.snapshotSeq}.json`), JSON.stringify(snapshot, null, 2) + '\n')
  return { seq: snapshot.seq, time: snapshot.time, reason }
}


function restoreSnapshot(projectId, snapshotSeq) {
  const file = join(snapshotsDir(projectId), `${snapshotSeq}.json`)
  if (!existsSync(file)) throw new Error(`textbook: snapshot ${snapshotSeq} 不存在`)
  const raw = readFileSync(file, 'utf8')
  let snapshot = null
  try { snapshot = JSON.parse(raw) } catch (error) {
    throw new Error(`textbook: 快照 ${snapshotSeq} 损坏无法恢复（${error instanceof Error ? error.message : error}）`)
  }
  const events = snapshot.events
  const meta = { ...snapshot.meta }
  // 截断/回退保留用户声音：把截断前的风格线/豁免/未处理留言并回恢复后的 meta（现在优先）。
  mergeUserVoice(readMeta(projectId), meta)
  // 合法回退：账本截短、账高随之变小（ADR-0016 决策 3）——走 rollbackLedger 这条明文例外。
  // （原先这里还自己写了一次 updatedAt；「最后动静时刻」只归「记一笔」，由下面那条 rollback 事件定。）
  rollbackLedger(projectId, events, meta)
  return appendEvent(projectId, 'textbook/rollback', { snapshot: snapshotSeq, reason: snapshot.reason })
}


// ── 关卡折叠 ────────────────────────────────────────────────────────────────

function foldGate(projectId, wanted = null) {
  const events = readEvents(projectId)
  let proposal = null
  let decision = null
  // 最近一次**决策事件**裁的是哪一版（票 workbench-transitions/23）。它与 `decision` 分家：
  // 新提案会把 `decision` 重置为 null（"v3 还没拍板"），但"v2 已经拍过了"是历史事实、不能跟着清。
  let decidedVersion = null
  for (const event of events) {
    // ⚠️ 2026-09-21 修：原来只看「最后一个提案」，于是按 gate 号折叠时全靠运气——
    // 第 1/2 次拍板返回的折叠结果挂着第 3 次拍板的 gate 号，调用方 `folded.gate === gate`
    // 判不等就整条丢掉，decision 一起丢；于是阶段页上「第 1、2 次拍板」永远不显示拍板结论，
    // 只有碰巧是最后一次的那个才显示（用户实测：三张卡只有第三张有「拍板：✅ 通过」）。
    // 现在给了 wanted 就**按 gate 号**折，每张卡各拿自己那一次的提案与结论。
    if (wanted !== null && String(event.data?.gate ?? '') !== String(wanted)) continue
    if (event.type === 'textbook/gate-proposal') {
      proposal = event
      decision = null
    } else if (event.type === 'textbook/gate-decision' && proposal !== null) {
      decision = event
      if (typeof event.data.version === 'number') decidedVersion = event.data.version
    }
  }
  if (proposal === null) return null
  let prevProposal = null
  for (const event of events) {
    if (event.type === 'textbook/gate-proposal'
      && event.data?.gate === proposal.data?.gate
      && event.seq < proposal.seq) prevProposal = event
  }
  const status = decision === null ? 'awaiting' : (decision.data.approved === true ? 'approved' : 'rejected')
  return {
    gate: proposal.data.gate,
    version: proposal.data.version,
    title: proposal.data.title ?? '',
    summary: proposal.data.summary ?? '',
    detail: proposal.data.detail ?? '',
    status,
    proposalSeq: proposal.seq,
    // 票 workbench-transitions/23：`version` 是**最新提案**的版次（awaiting 时也照样是新提案），
    // 「定下来的那一版」是最近一次决策事件当时裁决的那个——决策事件自带 `version`（gates.js 落账形状），
    // 记在 `decidedVersion` 上、**不随新提案重置**（v2 已定、v3 在等，两件事都要说得出来）。
    // 两者分家，阶段页的结论行才不会把「正在等拍板」渲染成「已驳回 · 第 M 版」。
    decidedVersion,
    decision: decision === null ? null : {
      seq: decision.seq,
      approved: decision.data.approved === true,
      mode: decision.data.mode ?? null,
      reasons: decision.data.reasons ?? [],
      note: decision.data.note ?? '',
    },
    prevProposal: prevProposal === null ? null : {
      seq: prevProposal.seq,
      version: prevProposal.data.version,
      title: prevProposal.data.title ?? '',
      summary: prevProposal.data.summary ?? '',
    },
  }
}


// ── 项目文件 ────────────────────────────────────────────────────────────────
//
// ⚠️ `workDir`（工作区目录）**不在这里**：它是书夹形状的位置，已搬进 `./engine/paths.js`
// 与 `projectDir`／`timelinePath`／`processLogPath` 同族（票 `context-budget/10` · ADR-0031 决策 1），
// 由下面 `import { … workDir … } from './engine/paths.js'` 取来再从这里再导出——
// **调用点一行未改**，而新形状（产物清单／登记／细目／报告）与它同源，改目录名只有一处要动。

function workFile(projectId, name) {
  const dir = workDir(projectId)
  const target = resolve(dir, name)
  if (!isWithin(dir, target)) {
    throw new Error(`非法文件路径: ${name}`)
  }
  return target
}


function writeWork(projectId, name, content) {
  const target = workFile(projectId, name)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content, 'utf8')
}


function readWork(projectId, name) {
  return readFileSync(workFile(projectId, name), 'utf8')
}


// ── 本书自定义模式库（2026-08-21 需求）────────────────────────────────────────
// 用户在工作台粘贴一段教学/结构描述 → AI 分析成「模式卡」→ 写进书夹 模式库/自定义/。
// 第 2 关（模式选型）与金标准写作规范的 brief 会把它连同内置模式库一起交给 AI。
// 只按书生效，不碰 resources/references/patterns/ 共享内置库（demo 模式不动）。

/** 本书自定义模式卡目录（无则建）。 */
function customPatternsDir(projectId) {
  const dir = join(projectDir(projectId), '模式库', '自定义')
  mkdirSync(dir, { recursive: true })
  return dir
}


/** 列出本书已有自定义模式卡（不含索引文件）：[{name,file,title,problem}]。 */
function listCustomPatterns(projectId) {
  const dir = customPatternsDir(projectId)
  const out = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md') || name.toLowerCase() === 'readme.md') continue
    let title = name.slice(0, -3)
    let problem = ''
    try {
      const text = readFileSync(join(dir, name), 'utf8')
      const lines = text.split('\n')
      const head = lines.find((l) => /^#\s+/.test(l))
      if (head !== undefined) title = head.replace(/^#\s*/, '').trim()
      const pi = lines.findIndex((l) => l.includes('解决的教学问题'))
      if (pi >= 0 && lines[pi + 1] !== undefined) problem = lines[pi + 1].trim()
    } catch { /* 读不到就用文件名 */ }
    out.push({ name: title, file: name, title, problem })
  }
  return out
}


/** 自定义模式卡交办素材：把本书自定义模式卡全文内联进 brief（有才返回非空字符串）。 */
export function customPatternsBrief(projectId) {
  const patterns = listCustomPatterns(projectId)
  if (patterns.length === 0) return ''
  const lines = ['', '用户自定义模式（与内置模式库同等地位，必须逐张读完，并在「模式选型」里回答每张对应本书哪个教学问题）：']
  for (const p of patterns) {
    const body = (() => { try { return readFileSync(join(customPatternsDir(projectId), p.file), 'utf8').trim() } catch { return '' } })()
    lines.push(`\n--- 自定义模式卡：${p.title} ---\n${body}`)
  }
  return lines.join('\n')
}


/** 把账上的风格线镜像成 AI 必读的 工作区/style-line.md（写章/审计/交工前读）。 */
function updateStyleLineMirror(projectId) {
  const meta = readMeta(projectId)
  const notes = (meta.styleNotes ?? []).filter((n) => n.status === 'active' || n.status === 'adopted')
  const lines = ['# 风格线（用户对写法的要求，写每一章前必读、逐条落实）', '']
  for (const n of notes) {
    lines.push(`- [${n.status === 'adopted' ? '已落实过' : '生效中'}] ${n.text}${n.note ? `（备注：${n.note}）` : ''}`)
  }
  if (notes.length === 0) lines.push('（还没有风格意见；用户随时可能补充，交章前用 workbench_status 查增量。）')
  writeWork(projectId, 'style-line.md', lines.join('\n') + '\n')
}


/**
 * 金标准定稿沉淀（票 15④）：把「最佳范例章」尚未撤销的意见转成风格线（`source:'gold'`），
 * 记下金标准母版版本号，落一条 `textbook/gold-seal` 事件——**只负责沉淀，不负责推进状态机**。
 *
 * 从 `actions/gold.js` 的 `gold-approve` 里抽出，因为现在有第二个调用者：`stage-submit gold` 在
 * `gold-skip` 豁免生效时（用户已同意跳过「最佳范例章确认」这道闸门）自动定稿。两条路径共用这一份
 * 沉淀逻辑，不许各写一份（否则「跳过确认」会连风格线一起跳过，等于偷偷放宽了下游判据）。
 * 返回是否真的沉淀了（无未撤销意见时不写 `goldSealed`——既有语义：零意见通过不写，被「阶段 ≥ 5」兜住）。
 */
function sealGoldStandard(projectId) {
  // 无未撤销意见时不写 `goldSealed`（既有语义：零意见通过不写，被「阶段 ≥ 5」兜住）——先做只读预检，
  // 真正的沉淀在改法里对**当场新读**的状态做：两个调用方原先各自把手里的旧状态当参数递进来，
  // 写回时把 appendEvent 刚推进的账高一起带回了旧值（参数透传变体，见票 02）。
  if ((readMeta(projectId)?.goldOpinions ?? []).filter((o) => o.status !== 'revoked').length === 0) return false
  let seal = null
  updateMeta(projectId, (meta) => {
    const sealOpinions = (meta.goldOpinions ?? []).filter((o) => o.status !== 'revoked')
    if (sealOpinions.length === 0) return // 预检之后被并发撤销光了：一个字都不改
    const sealed = []
    sealOpinions.forEach((o, i) => {
      const kindText = o.kind === 'dislike' ? '不要这种写法' : o.kind === 'drop' ? '不要这类内容' : '要照此修改'
      sealed.push({
        id: `sn-gold-${Date.now().toString(36)}-${i}`,
        text: `${o.target === null ? '' : `${o.target.hint || `第${o.target.para}段`}：`}${kindText}--${o.wish}`,
        at: Date.now(), source: 'gold', status: 'active', note: `来自最佳范例章意见#${i + 1}`,
      })
      o.status = 'applied'
    })
    meta.styleNotes = [...(meta.styleNotes ?? []), ...sealed]
    const goldVersions = readEvents(projectId).filter((e) => e.type === 'textbook/agent-end' && String(e.data?.label ?? '').includes('最佳范例章')).length
    meta.goldSealed = { version: Math.max(1, goldVersions), at: Date.now() }
    seal = { version: meta.goldSealed.version, count: sealed.length }
  })
  if (seal === null) return false
  updateStyleLineMirror(projectId)
  appendEvent(projectId, 'textbook/gold-seal', seal)
  return true
}


// ⚠️ `sources/`（原件）**不在本票射程**：`sources/` → `材料/原件/` 是票 `14` 的书夹形状收口，
// 本票一件都不许做（票 `13` 的边界）。所以这里两个目录看起来「一半新一半旧」，那是**预期的**。
function sourcesDir(projectId) {
  const dir = join(projectDir(projectId), 'sources')
  mkdirSync(dir, { recursive: true })
  return dir
}


/** 转换稿目录（`材料/转换稿/`）——票 `13` 从书夹根下平级的一层搬进 `材料/`，段名由 `paths.convertedDir()` 持有。 */
function sourcesMdDir(projectId) {
  return convertedDir(projectId)
}


/**
 * 纯文件名判据：不含任何路径分隔符、不是 `.`／`..`、不是绝对路径（`C:\x.pdf` 也不认）。
 *
 * **删除目标一律先过它**（`removeSourceFile`）。它与 `projectDir` 里的 `PROJECT_ID_RE` 是同一族
 * 东西：一个把「书」钉死在书夹里，一个把「要删的那一份材料」钉死在这本书的 `sources/` 里。
 * ⚠️ 别拿 `resolve` + `startsWith` 代替——那正是 2026-09-26 事故那一族的写法。
 */
function assertPlainFileName(file) {
  const name = String(file ?? '')
  if (name === '' || name === '.' || name === '..' || basename(name) !== name) {
    throw new Error(`不是合法的材料文件名: ${JSON.stringify(file)}`)
  }
  return name
}


/**
 * 删掉一份材料的**原件**（票 `mineru-formats/03` · `CONTEXT.md`「材料缺口」的「删掉这份」那一半）。
 *
 * 为什么原件也要删：用户说「删掉这份」之后，书夹里还躺着那份 PDF 而材料清单里没有它，
 * 就是另一种「屏上说的与盘上做的不是一件事」。**代价是不可逆**，所以 UI 那一侧是两步确认
 * （先「删掉这份」、再「确认删掉？」），这里只保证「删的确实是用户点名的那一格」。
 *
 * ## 三档结局，不是「删掉了没有」一个布尔（code-review ⑤）
 *
 * 原来这里 `unlinkSync` 外面套着一个空 `catch`（注释写着「已尽力」），之后回 `!existsSync(path)`，
 * 于是 unlink 失败（文件被别的进程占用、权限不足）会与「原件本来就不在」**塌成同一个 false**：
 * 调用方照说「原件本来就不在书夹里」，而那一格**照样从清单里消失**——
 * 文件成了没人管的孤儿，用户再也看不到、也再也点不到它。
 *
 * 现在三档各自说各的（判据只有这里一份，调用方不许自己再 `existsSync` 一遍）：
 *   · `'deleted'` —— 真删掉了；
 *   · `'missing'` —— 原件本来就不在盘上（**不是失败**，用户要的结局已经成立）；
 *   · `'failed'`  —— **在盘上却删不掉**：如实带出原因，调用方据此把那一格**留在清单上**
 *     并告诉用户「删不掉、可以重试」，不许静默摘掉。
 *
 * @param {string} projectId 书号（`projectDir` 的 `PROJECT_ID_RE` 限定）
 * @param {string} file 纯文件名（**先过 `assertPlainFileName`**，请求体里的名字另需命中
 *                       `meta.sources` 那一格——判据在 `actions/convert.js` 的 `assertRemovableSource`）
 * @returns {{outcome: 'deleted'|'missing'|'failed', error?: string}}
 */
export function removeSourceFile(projectId, file) {
  const name = assertPlainFileName(file)
  const path = join(sourcesDir(projectId), name)
  if (!existsSync(path)) return { outcome: 'missing' }
  // ⚠️ 刻意**只**用 unlinkSync 摘这一个文件：递归 `fs.rmSync` 对含中文的路径在 Windows 上
  // 原生崩溃（见 removeTree 头部），文件级删除用 unlinkSync 是本模块既有的安全做法。
  try {
    unlinkSync(path)
  } catch (error) {
    // 删不掉就说删不掉——**不回 `false`**（那个值会被读成「本来就不在」，于是清单那一格
    // 静默消失、文件变孤儿）。失败原因原样带出去，用户看得到也能据此重试。
    return { outcome: 'failed', error: String(error instanceof Error ? error.message : error) }
  }
  // unlinkSync 说成功但文件还在（罕见：网络盘/占用竞态）同样算「删不掉」，不许报成功。
  if (existsSync(path)) return { outcome: 'failed', error: '删除之后它仍在盘上（可能被别的程序占用）' }
  return { outcome: 'deleted' }
}


// ── 状态机运行器 ────────────────────────────────────────────────────────────

const runners = new Map() // projectId -> Promise

const gateWaiters = new Map() // projectId -> { gate, version, resolve }

const parents = new Map() // projectId -> { handle }


/**
 * 自动唤醒主对话 AI，把当前 pendingStage 的任务交给它（真实模式专用）。
 * 消息以「工作台提示」形式出现在对话流（source: plugin + notice），
 * 不冒充用户说话；AI 被唤醒后按人设流程：status → stage-brief → 干活 → 交工。
 */
function wakeMainAI(ctx, projectId) {
  const meta = readMeta(projectId)
  if (meta === null || meta.demo === true) return false
  const sessionId = meta.session
  if (typeof sessionId !== 'string' || sessionId === '') return false
  const agent = ctx.get('agents')?.get?.(sessionId)
  // ⚠️ 票 walkthrough-fixes/01（走查 P41）：这条原来是**无声**的 return false。注册表里
  // 根本没有这本书的会话时（宿主刚重启、agent 还没起来），调用方拿到的也只是「没叫醒」，
  // 没有任何一条线索指向「为什么」。这里补一条 warn：现场日志里能直接看到是「注册表里没有
  // 那个会话」，而不是再去猜是权限、是来源校验还是别的地方出的错。
  if (agent === undefined) {
    ctx.logger.warn(`textbook: 唤醒主 AI 失败：agents 注册表里没有会话 ${sessionId}（项目 ${projectId}）`)
    return false
  }
  // 交办唤醒消息是给人看的（CONTEXT.md：机器以 plugin+notice 注入对话流，不冒充用户），
  // 所以这里用界面词；账本里那条 stage-start 仍记机器 label（见 handoff，机器身份词不动）。
  const label = stageLabelHuman(stageLabel(meta.pendingStage, meta.pendingGate ?? null))
  const text = [
    `【工作台派任务 · ${label}】`,
    `这本书的「${label}」轮到你来做了。`,
    '1. 先调用 workbench_status 看真实状态（项目、阶段、待办、抽查意见）。',
    '2. 再调用 workbench_act（action=stage-brief）领取这一步的任务说明、写作方法与产物要求。',
    '3. 按说明完成（可亲手做，也可派小助手分头干）；过程中用 workbench_act（action=progress）随时上报进度。',
    '4. 完成后调用 workbench_act（action=stage-submit）交工；机器验货合格才会继续下一步。',
    '铁律：先用大白话告诉用户你要做什么，再动手；需要用户拍板的事绝不自作主张。',
  ].join('\n')
  const message = noticeMessage({
    idPrefix: 'tb-task',
    text,
    summary: `工作台：轮到 AI 动手（${label}）`,
  })
  try {
    agent.followup(message)
    return true
  } catch (error) {
    // 极少数宿主版本对 plugin+notice 来源校验严格：回退成普通 user 来源再试一次。
    ctx.logger.warn(`textbook: 唤醒主 AI（工作台提示来源）失败，回退 user 来源: ${String(error instanceof Error ? error.message : error)}`)
    try {
      agent.followup({ ...message, source: { kind: 'user' } })
      return true
    } catch (error2) {
      ctx.logger.warn(`textbook: 唤醒主 AI 彻底失败: ${String(error2 instanceof Error ? error2.message : error2)}`)
      return false
    }
  }
}


/**
 * 交办：记账 pendingStage → 记事件 → 快照 → 唤醒主 AI。
 * 幂等由调用方保证（runPhase 先查 pendingStage 是否已设）。
 *
 * `snapshotReason`（票 pipeline-wiring-gaps/08）：快照的 `reason` 是回退轴上唯一可读的字。例行交办一律写
 * 「交办「X」之前」；**驳回触发的重做**要给一句能分得开的措辞（探查驳回的那次交办也是
 * `stage='explore'`，不另给措辞就在回退轴上与第一次交办长得一模一样）。
 * 不给就沿用例行措辞，所以既有 10 处调用一个字都不用改。
 */
function handoff(ctx, projectId, stage, gate = null, snapshotReason = null) {
  updateMeta(projectId, (meta) => {
    meta.pendingStage = stage
    meta.pendingGate = gate
    meta.wakeToken = (meta.wakeToken ?? 0) + 1
    meta.status = 'running'
  })
  const label = stageLabel(stage, gate)
  const artifact = artifactDataForStage(stage, gate, goldN(readMeta(projectId)))
  appendEvent(projectId, 'textbook/stage-start', {
    stage, gate, label,
    path: artifact.path,
    chapter: artifact.chapter,
  })
  try {
    writeSnapshot(projectId, snapshotReason ?? `交办「${stageLabelHuman(label)}」之前`)
  } catch { /* 快照失败不影响交办 */ }
  return wakeMainAI(ctx, projectId)
}


/**
 * 交办 + demo 通道自驱动：**确认闸门放行/驳回之后**动作层该调的那一个口（票 depth-review-2026-10/07）。
 *
 * 为什么需要它：demo 与真实的唯一 seam＝内容来源（本文件头部自述）。真实书交办完由主 AI 接着推进，
 * demo 书**没有主 AI 可唤醒**——`wakeMainAI` 对 `meta.demo === true` 直接早退返回 false，于是
 * `pendingStage` 挂在那儿、状态机没人推。所以**交办之后得有人推**的那一族动作——确认闸门放行/驳回
 * （`gates` / `gold` / `resume`），以及「把书翻回 running 再交办」的入账动作（`chapters` 的提意见）
 * ——一律必须走这个口，由演示占位通道自己把下一步做出来。原先这个判据在 `actions/` 里抄了七份
 *（每份自带一段理由注释），新增确认动作时最容易漏抄或抄歪；判据与理由收在此处一处。
 *
 * ⚠️ **「七份」是历史份数，不是今天的处数**：走这个出口的地方会随票增长（票 `demo-flow-fidelity/05`
 * 把 `chapters.js` 的**过目态提意见**与**机器空闲时提意见**两处原本裸调 `handoff` 的也改了进来
 * ⇒ 处数 **7 → 9**）。今天的处数由 `test-flow-transitions-chapters.mjs` 的 G5 结构闸数着
 * （票 `test-chain-latency/04` 之前它在 `test-flow-transitions.mjs` 里）——它同时是
 * 「有人又裸调 `handoff`」（demo 书停死在 `running`）与「有人把 kick 堆在手边」（真书多吃一趟
 * 状态机；`kick` 不幂等）这两件事的警报，**本注释不另记一份会腐烂的账**。
 *
 * 判据是两个合取项，**第二个承重**：`woke === false` 的原因不止 demo 一个（meta 读不出、sessionId
 * 非法、`agents` 注册表里没有这本书的会话、两次 followup 都失败，见 wakeMainAI 各早退），只看 woke
 * 会把那些真书也拖去补 kick——那等于凭空多驱动一趟状态机。所以要求 `meta.demo === true` 才补。
 * 另一个承重点：**只读当场状态**（`readMeta` 现读），不收调用方那份局部拷贝——原先那七份拷贝的读取时刻
 * 各不相同，而语义上「交办之后的状态」只有现读才对。
 *
 * `drive: false` 是**刻意不补 kick** 的出口。理由写在定点修改那一族自己那里（`actions/deep-modify.js`）：
 * 它把待办直接写回 `meta.pendingStage` 再单独唤醒，**既不 handoff 也不 kick**——kick 会让状态机从
 * 账本重推导（可能落错段），handoff 会追加 stage-start 事件、破坏「10 分钟内可一键撤销」的
 * 「账面无新进展」守卫。
 *
 * @returns handoff 的返回值（= wakeMainAI 的 woke），调用方需要时自取。
 */
function handoffAndDrive(ctx, projectId, stage, gate = null, snapshotReason = null, options = {}) {
  const woke = handoff(ctx, projectId, stage, gate, snapshotReason)
  if (options.drive === false) return woke
  const meta = readMeta(projectId)
  if (woke === false && meta !== null && meta.demo === true) void kick(ctx, projectId)
  return woke
}


/** 某章的两份产物路径。 */
function chapterArtifacts(projectId, n) {
  // ⚠️ `file` 喂给 `workFile`，而 `workFile` 自己拼 `工作区/` ⇒ 这里要的是**基名**
  // （`chapterName`），不是相对路径。给成 `chapterRel` 会读成 `工作区/工作区/chapter-NN.md`
  // ——真的把文件读坏。票 `depth-review-2026-10/05`。
  const file = chapterName(n)
  const audit = `audit-${String(n).padStart(2, '0')}.md` // audit 族的同款契约，本票不收
  return { file, audit, chapterPath: workFile(projectId, file), auditPath: workFile(projectId, audit) }
}


/**
 * 该章「机器记下的交工通过」——只认账本里已存在的机器证据，**不按文件存在兜底**（票 14 / 票 05 裁决 A）。
 *
 * 判据（两选一，都是写入点早就存在的事件，本程不新造能力）：
 *  ① **章级交工**：`textbook/agent-end` 且 `outcome === 'ok'`，label 里的**第一处章号**＝该章号
 *     （「第N章」是跨通道稳定的机器身份词）。真实通道＝`stage-submit chapters`（小助手执笔 + 小助手审计
 *     + 机器验货），label 形如「第N章《标题》完成（…）」；演示通道＝`demoWriteChapters` 的「写第N章」。
 *  ② **最佳范例章那一章**：`goldN(meta)` 那一章由「最佳范例章」这一步写的就是该章正文，所以那一步交工
 *     ＝该章交工。label 的真实形态是 `最佳范例章`（真实通道）/`最佳范例章（先写一章给你看）`（演示通道），
 *     只认前四个字即可覆盖两者——**不改 demo 轨迹、不重录 cassette**。
 *
 * ⚠️ 章号必须**取 label 里第一处**再与 n 严格比对，不能用 `label.includes('第N章')`：
 * 真实 label 是「第3章《…》完成」，**标题里只要出现「第5章」字样**（如「第1章《第2章的秘密》完成」），
 * 用 includes 就会把第 5 章误判成已交工 → 过目闸门放行未交工的章。
 */
function chapterHasSubmitEvent(projectId, n, meta = null, events = null) {
  const gold = goldN(meta ?? readMeta(projectId) ?? {})
  for (const event of events ?? readEvents(projectId)) {
    if (event.type !== 'textbook/agent-end') continue
    const label = String(event.data?.label ?? '')
    if (event.data?.outcome === 'ok') {
      const first = /第(\d+)章/.exec(label)
      if (first !== null && Number(first[1]) === n) return true
    }
    // 「最佳范例章」那条独立分支：它本身不带章号，走 goldN(meta) 定位
    if (label.includes('最佳范例章') && gold === n) return true
  }
  return false
}


/**
 * 票 22：**正文一改，审过就失效**——检查记录必须**审的是当前这份正文**才算审过它。
 *
 * 判据本体是 `domain-rules.auditCoversProduct`（指纹优先、mtime 兜底），与 `src/workflow.js` 的
 * `buildArtifactFacts` 里那条「新鲜度是服务端事实」**同一对文件**（那边算给界面看，这边卡住闸门）。
 * 读不到 mtime 时**不判旧稿**——「读不出」不许当成「有问题」。
 */
/**
 * 检查记录审的是不是当前这份产物 —— **指纹优先、时序兜底**（票 `context-budget/10` · ADR-0031 决策 4）。
 *
 * ⚠️ 判据本体在 `domain-rules.auditCoversProduct`（两侧共用的纯模块）：「只有一处」是硬要求，
 * 前端与注入面日后都要读它，而抄第二份就是「两个数字打架」的复发。
 * 这里只负责**取事实**（今天章级没有指纹，落回 mtime），判定一个字都不在这里重写。
 *
 * 指纹优先的理由（为什么不是只比 mtime）：mtime 会被 `git checkout`、复制、跨盘搬运整体推后，
 * 一份**对旧稿**的检查记录因此可能「看起来比正文新」——今年已经因此被拦过一次（票 `walkthrough-fixes/22`）。
 * 指纹（内容摘要）没有这个毛病；老账本没有指纹，那一批只能按时序。
 *
 * 读不到 mtime（stat 抛了）时**不判旧稿**——「读不出」不许当成「有问题」，那会让一本正常书
 * 凭空被拦住；那种情况下上面的「两份产物在」已经扛住了最要紧的那一半。
 */
function chapterAuditOlderThanChapter(chapterPath, auditPath) {
  return !auditCoversProduct({
    productModifiedAt: safeMtimeMs(chapterPath),
    auditedModifiedAt: safeMtimeMs(auditPath),
  })
}


/** mtime（毫秒）；读不出返回 `null`（`auditCoversProduct` 把「读不出」判成「不判旧」）。 */
function safeMtimeMs(path) {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}


/**
 * 过目闸门「全部章节都写好了」的单章判据（票 14，**界面数字与闸门共用这一份**，不许写第二份）：
 *  ① 两份产物存在（`工作区/chapter-NN.md` ＋ `工作区/audit-NN.md`，今天已有）；
 *  ② **检查记录不比正文旧**（票 22：正文在审计之后又改过 ⇒ 那份审计审的是旧稿，「审过」当场失效）；
 *  ③ 该章有机器记下的「交工通过」（见 chapterHasSubmitEvent）；
 *  ④ 该章**没有未处置（`status === 'pending'`）的抽查意见**——这条是票 10「翻案 → 这本书重新被拦住」
 *     的服务端一半：翻案把意见写回 `pending` 之后，**即使该章早就交工过**，过目闸门也必须重新拦住它。
 *
 * ⚠️ ② 是**验货**那一半，不是显示那一半（票面 :48-53）：没被审过的正文带着「已审过」进合并、
 *  进交付，比「清单没刷新」严重一个量级。而它必须落在这里——界面的「已完成 X/Y 章」与章徽章
 *  取的就是这一份（票 14 的同源不变量），写在别处就是「两个数字打架」的老病复发。
 *
 * 老书/在建书不新造迁移：某章没交工就重新走既有逐章交工（`stage-submit chapters` 那个写入点在），
 * **不退回到「按文件判」兜底**（不变量 2）。
 */
function chapterDone(projectId, n, meta = null, events = null) {
  return chapterGateMiss(projectId, n, meta, events) === null
}


/**
 * 同一份判据的「差在哪一项」形态（**不重复判据，只给结论起个名**）：
 * 满足返回 `null`，不满足返回 `{ reason: 'artifact' | 'stale' | 'review' | 'submit', state: … }`——
 * `chapters-review-confirm` 闸门要据此说清「是产物缺、还是审的是旧稿、还是该章有未处置意见、还是压根没交工」。
 * 四项与 chapterDone 一一对应，顺序也一致。
 *
 * ⚠️ **`state` 是四档环节状态**（`missing`／`stale`／`unconfirmed`／`ready` · ADR-0031 决策 4），
 * 由 `domain-rules.stageStateOf` **算**出来 —— `reason` 是给闸门报错用的旧词，四档状态是给
 * 界面与注入面用的（票 `02` 的注入触发词表取的就是那一档）。**这里不新造判据**：
 * 本函数只负责取三样事实（产物在不在／审计对不对得上／人工确认到位没有），四档由那一个函数给。
 */
function chapterGateMiss(projectId, n, meta = null, events = null) {
  const { chapterPath, auditPath } = chapterArtifacts(projectId, n)
  const current = meta ?? readMeta(projectId)
  const state = stageStateOf({
    artifactPresent: existsSync(chapterPath) && existsSync(auditPath),
    auditFresh: !chapterAuditOlderThanChapter(chapterPath, auditPath),
    reviewPending: (current?.pendingReviews ?? []).some((r) => r?.chapter === n && r?.status === 'pending'),
    submitRecorded: chapterHasSubmitEvent(projectId, n, current, events),
  })
  return state.reason === null ? null : { reason: state.reason, state: state.state }
}


/**
 * 某一章的**环节状态**（四档，纯派生）——服务端／前端／注入面都读它（只此一份）。
 * @returns {{state: string, reason: string|null}}
 */
export function chapterStageState(projectId, n, meta = null, events = null) {
  return chapterGateMiss(projectId, n, meta, events) ?? { state: 'ready', reason: null }
}


/** 播报上下文：appendEvent 播报主对话用的唯一跨切面依赖。
 *  显式契约：仅 apply 调 bindAnnounce 绑定一次；未绑定时不播报（只进项目时间线）。 */
let announceCtx = null


function bindAnnounce(ctx) {
  announceCtx = ctx
}



/** 主 AI 上下文占用的读数口（票 28 / 走查 P46）：领任务说明要带上它，好让主笔 AI 知道自己该收尾了。
 *
 *  数据源是宿主自己算的那份 `contextPressure` **会话投影**——与宿主输入区角标
 * 「上下文已用 51%」同一份数据。本模块**不 import 任何宿主包**，读数由宿主侧经
 * `bindContextOccupancy` 注入（同 `bindAnnounce` 的显式契约：只有 apply 绑一次）。
 *
 *  绑定方给的 reader 形状：`(sessionId) => number | null`，返回**占用百分比**。
 * 百分比算式只有一份，在 `src/domain-rules.js` 的 `contextOccupancyPercent`
 * （`src/ui/rules.js` 只是再导出；逐字照宿主 `contextOccupancy()`）。
 * 本模块 import 的**就是那同一个模块**（领域规则模块被 esbuild 打进前端、也被 node ESM
 * 后端直接 import，这是它被选为这一份的理由），所以不重算不是「没法共享」，
 * 抄第二份算式才是本仓在治的病（同一件事两份实现 → 改一处必漏两处）。
 *
 *  ⚠️ 未绑定 / reader 抛错 / 返回的不是有限数 → 一律 null，
 * brief 里那一句**整句不出现**（绝不写 0%、绝不编一个百分比）。 */
let contextOccupancyReader = null


function bindContextOccupancy(reader) {
  contextOccupancyReader = typeof reader === 'function' ? reader : null
}


/** 当前会话的主 AI 上下文占用百分比；读不到就是 null（界面/brief 都照此不显示）。 */
function readContextOccupancy(sessionId) {
  if (contextOccupancyReader === null) return null
  if (typeof sessionId !== 'string' || sessionId === '') return null
  let percent
  try {
    percent = contextOccupancyReader(sessionId)
  } catch {
    return null // 读数是辅助信息，读不到不许把领任务说明整个带崩
  }
  return Number.isFinite(percent) ? percent : null
}


/** 领任务说明里那一句（只在读得到数时出现）。
 *  给主笔 AI 看的口径与界面上那一句同源：这是**计量**、不是状态词（CONTEXT.md 三词上限不动）。 */
function contextOccupancyBriefLine(sessionId) {
  const percent = readContextOccupancy(sessionId)
  if (percent === null) return null
  return `上下文已用 ${percent}%（主 AI 这一场的上下文用量，只增不减；上下文满了会压缩正在追的活、还没落账的结论，必要时请用户早点介入：暂停、砍章节、提前过目）。`
}


async function disposeParent(projectId) {
  const entry = parents.get(projectId)
  if (entry === undefined) return
  parents.delete(projectId)
  try { await entry.handle.dispose() } catch { /* 尽力而为 */ }
}


/** 惰性创建父代理（真实模式派生子代理用）。 */
async function getParent(ctx, projectId, _meta) {
  const cached = parents.get(projectId)
  if (cached !== undefined) return cached.handle.agent
  let provider = 'deepseek-official'
  let model = 'deepseek-v4-flash'
  try {
    const defaultModel = ctx.get('agentDefaultModel')
    if (defaultModel !== undefined) {
      const resolved = typeof defaultModel.currentSelection === 'function'
        ? defaultModel.currentSelection()
        : defaultModel
      if (resolved?.provider !== undefined) provider = resolved.provider
      if (resolved?.model !== undefined) model = resolved.model
    }
  } catch { /* 保持默认 */ }
  const handle = await ctx.agents.create({
    sessionId: `textbook-${projectId}`,
    meta: { cwd: projectDir(projectId), origin: 'subagent' },
    agentOptions: { provider, model },
  })
  parents.set(projectId, { handle })
  return handle.agent
}


function projectRuntime(ctx, projectId, meta) {
  return {
    ctx,
    demo: meta.demo === true,
    dir: projectDir(projectId),
    project: meta,
    getParent: () => getParent(ctx, projectId, meta),
  }
}


/** 提案正文的一级标题（人读：《工作区/方案/关卡N-vX.md》的第一行）。
 *  文件名与路径是**机器身份词**（不改，锚定它的正则见 domain-rules 的提案白名单）；
 *  但这一行标题是写给人读的（判定线②），所以走界面词模板。导出以便用词不变量断言直调
 *  真实产出函数（票 01），不在测试里复制模板字符串。 */
export function proposalHeading(gate, version, title) {
  return `# ${gateHuman(gate)} · 方案 v${version}：${title}`
}


/** 关卡方案落盘为可读文档（工作区/方案/关卡N-vX.md）。 */
function writeProposalDoc(projectId, gate, version, title, summary, detail) {
  try {
    const dir = proposalDir(projectId)
    writeFileSync(
      join(dir, `关卡${gate}-v${version}.md`),
      `${proposalHeading(gate, version, title)}\n\n## 摘要\n\n${summary}\n\n## 完整方案\n\n${detail}\n`,
    )
  } catch { /* 文档失败不影响主流程 */ }
}


/** 提交关卡提案（状态机内部与 action 共用）。 */
function proposeGate(projectId, gate, title, summary, detail) {
  writeProposalDoc(projectId, gate, 1, title, summary, detail)
  const snapshot = writeSnapshot(projectId, `提交「${gateHuman(gate)}」方案之前`)
  const event = appendEvent(projectId, 'textbook/gate-proposal', {
    gate, version: 1, title, summary, detail,
  })
  void snapshot
  return event
}


function proposeRevision(projectId, gate, version, title, summary, detail) {
  writeProposalDoc(projectId, gate, version, title, summary, detail)
  writeSnapshot(projectId, `修订「${gateHuman(gate)}」方案 v${version} 之前`)
  return appendEvent(projectId, 'textbook/gate-proposal', {
    gate, version, title, summary, detail,
  })
}


function advance(projectId, fromPhase, toPhase) {
  // 先落「阶段结束」再改状态、最后落「阶段开始」：原先「改状态 → 整份写回旧状态 → 记一笔」的顺序
  // 每次阶段推进都必产一个重号（票 02 的机制一）。现在状态改在 updateMeta 里（不碰账高），
  // 两笔事件的序号都来自「记一笔」自己那份当场新读。
  if (fromPhase !== undefined) {
    appendEvent(projectId, 'textbook/phase-end', { phase: fromPhase, label: PHASE_LABELS[fromPhase] })
  }
  updateMeta(projectId, (meta) => {
    meta.phase = toPhase
    meta.status = 'running'
  })
  appendEvent(projectId, 'textbook/phase-start', { phase: toPhase, label: PHASE_LABELS[toPhase] })
}


function waitForGateDecision(projectId, gate, version) {
  return new Promise((resolve) => {
    gateWaiters.set(projectId, { gate, version, resolve })
  })
}


/**
 * 兑现这一次拍板：`gateWaiters` 里那笔的 `(gate, version)` **逐字对上**时兑现并清掉；否则什么都不做。
 *
 * ⚠️ 票 `deep-module-scan/10`：`gateWaiters` 的 `{gate, version, resolve}` 三字段协议**原先横跨两个文件**——
 * engine 写、`actions/gates.js` 读（那里直接 `.get()` 出来、比对两个字段、再 `.resolve()`）。
 * 那意味着**协议的两半都没有声明它**，而 `gates.js` 必须知道 `resolve` 这个字段名才能兑现它。
 * ⇒ 收回成这一个函数后，**协议只活在 engine 内**，调用方只说「兑现 project 上这一次的拍板」。
 * 只有一个 implementation，所以**不造 seam**——只是把跨文件的形状收回来。
 */
function resolveGateDecision(projectId, gate, version) {
  const waiter = gateWaiters.get(projectId)
  if (waiter === undefined || waiter.gate !== gate || waiter.version !== version) return
  gateWaiters.delete(projectId)
  waiter.resolve()
}


/**
 * 这一本书此刻有没有状态机在跑。
 *
 * ⚠️ 票 `deep-module-scan/10`：原先两个调用点各自直接 `runners.has(project)` 当「别起第二个状态机」
 * 的判据（`actions/convert.js` 与 `workflow.js`），**那条判据的含义只活在它们的注释里**。
 * 收回成具名的一格后，判断的来由写在名字上，而不是靠两处注释各自解释一遍。
 *
 * ⚠️ **但 `runners` 这个 Map 仍然导出**，不是忘了收：`books.js` 删书时要 `runners.delete(project)`
 * （那是清理，与「有没有在跑」不是一回事），`test-material-gap-stance.mjs` 的 `settleRunner`
 * 要**拿到那个 promise 去 await**——它要的不是布尔，是那一条。
 */
function isRunning(projectId) {
  return runners.has(projectId)
}


async function runPhase1(_ctx, projectId, meta) {
  // Phase 1：等待材料 → 逐份转换（MinerU）→ 全部完成推进 Phase 2
  const sources = meta.sources ?? []
  if (sources.length === 0) {
    // 票 09：退役「教材 PDF」。⚠️ `docs/协作模型.md` 的 B53 锚点逐字记着这句，改这里必须同改那张表。
    appendEvent(projectId, 'textbook/hint', { text: '请先上传材料（工作台向导）' })
    return 'waiting'
  }
  // 上次转换可能中途中断（宿主重启）留下卡死的 converting 标记：清掉，从头继续。
  if (meta.converting === true) {
    updateMeta(projectId, (state) => { state.converting = false })
  }
  // 逐本转换，全部转完才进下一阶段（此前只转一本就停，是 bug）。
  // ⚠️ 每一轮**重新读状态**：这一支原本一路握着开工时那份旧状态（转换要 await，期间账本/状态都在动），
  // 收尾时整份写回＝累积性回退（把账高拉回开工时的值，票 02 的真账本第 94 行就是这么来的）。
  for (;;) {
    const current = readMeta(projectId)
    const currentSources = current?.sources ?? []
    // 三值枚举的读法一律经 domain-rules.convertedState（单一真相源；老书布尔只读归一，不回写）。
    const pending = currentSources.filter((source) => convertedState(source) === 'pending')
    const failedSources = currentSources.filter((source) => convertedState(source) === 'failed')
    if (pending.length === 0) {
      // 推进条件（票 `mineru-formats/02` · ADR-0028 决策 1/3）：**没有 pending 也没有 failed** 才推进。
      // 只判 pending 是不够的——失败源会被留在一本「已进 Phase 2」的书里，
      // 于是 brief 指向一份**根本不存在**的 `材料/转换稿/…/full.md`（静默读不到，两边都不报错）。
      if (failedSources.length === 0) {
        advance(projectId, 1, 2)
        return 'advanced'
      }
      // 停在材料准备，**这一轮不重传任何东西**（票面的反证：failed 源下一轮不会被挑中）。
      // 置 error 是为了不留「状态永远 running 却什么都不说」的空档——屏上照旧是那张既有的
      // 错误卡（它读 `lastErrorHuman`，就是上一轮那句批次口径的人话）。
      //
      // 票 `mineru-formats/03`（ADR-0028 决策 3）把「表过态」那一层补在这一格之下：
      // 每一份 `failed` 都要用户**逐个**表态，两个出口各走各的真路径——
      //   · 补传：同名重传（`handleUpload` 把那一格置回 `'pending'`）→ 下一轮真的重转；
      //   · 删掉：契约动作 `source-remove`（`actions/convert.js`）把那一格从 `meta.sources` 摘掉。
      // 两条都改 `meta.sources`，所以「逐个表态完才准推进」这件事**由这一行自己兑现**：
      // 只要还剩任何一格 `failed`，本函数就既不重传也不推进。
      updateMeta(projectId, (state) => { state.status = 'error' })
      return 'error'
    }
    const source = pending[0]
    const sourcePath = join(sourcesDir(projectId), source.file)
    if (!existsSync(sourcePath)) {
      updateMeta(projectId, (state) => { state.status = 'error' })
      appendEvent(projectId, 'textbook/error', { task: '材料', message: `源文件缺失: ${source.file}` })
      return 'error'
    }
    updateMeta(projectId, (state) => { state.converting = true })
    // 批量转换全部待转原件（一次提交并行解析；每份结果按 file_name 落到独立子目录）。
    const startedAt = Date.now()
    // ⚠️ 票 09 裁决：**账本 label 一个字不改**——`批量转换 N 本 PDF` 是机器身份词，
    // 同面先例见 CONTEXT.md「界面用词表」章级完成行（账本 label 照旧、界面走 `stageLabelHuman`）。
    // 这里也正是 `docs/协作模型.md` 的 B55 锚点逐字钉着的那一串。
    appendEvent(projectId, 'textbook/agent-start', { label: `批量转换 ${pending.length} 本 PDF` })
    try {
      const items = pending.map((item) => {
        const index = currentSources.indexOf(item)
        // 票 07：剥**已知**扩展名（`MINERU_KNOWN_EXTENSIONS` 那一份），不再手抄 `/\.pdf$/i`——
        // 受理闸门放开后原件可以是 docx/pptx/图片，那份手抄的后缀会原样留在转换稿目录名里
        // （`01-讲义.docx`），而 PDF 那一半继续被剥掉，同一批里两套命名口径。
        // 剥已知 ≠ 只认 PDF：`讲义.txt`（名单外，本仓压根进不来）原样留着。
        const sub = `${String(index + 1).padStart(2, '0')}-${sanitizeFolderName(stripKnownExtension(item.file)).slice(0, 24)}`
        return {
          file: join(sourcesDir(projectId), item.file),
          name: item.file,
          outDir: join(sourcesMdDir(projectId), sub),
          sub,
        }
      })
      const results = await convertPdfBatch(items, { formula: meta.science === true }, (stage) => {
        // ⚠️ 票 09 记一笔事实：`data.file` 是**死字段**——`src/ui/view-rules.js` 的转换活动行
        // 只读 `data.stage`，从不读 `data.file`。这里改「本→份」纯属账本内一致性，用户零感知。
        appendEvent(projectId, 'textbook/mineru-progress', { file: `${pending.length} 份`, stage })
      })
      const failed = results.filter((result) => result.ok !== true)
      // F26（2026-08-20）：记录人话错误文案（mineru-lib 已把页数超限/Token 失效归一成人话），前端 error 卡直接展示。
      // 票 09：判定线①（error 卡原样渲染 message），数材料说「份」。
      const humanMessage = failed.length === 0
        ? null
        : `${failed.length} 份转换失败：${failed.map((f) => `${f.name}（${f.error ?? '未知错误'}）`).join('；')}`
      // 转换结果写回**当场新读**的那份（按文件名找条目，不按开工时那份数组的下标）。
      // 三个结局都落到**同一个** `converted` 字段（票 `mineru-formats/02`）：
      // 成功写 'ok'（并记下转换稿相对路径），失败写 'failed'——失败源就是**第三态**，
      // 于是它既不会被下一轮重新挑去重传，也不会被推进条件当成「已经转完了」。
      updateMeta(projectId, (state) => {
        state.converting = false
        for (const result of results) {
          const target = (state.sources ?? []).find((s) => s.file === result.name)
          if (target === undefined) continue
          if (result.ok !== true) {
            target.converted = 'failed'
            continue
          }
          const item = items.find((it) => it.name === result.name)
          if (item === undefined) continue
          target.converted = 'ok'
          target.md = join(item.sub, 'full.md')
        }
        if (humanMessage !== null) {
          state.lastErrorHuman = humanMessage
          state.status = 'error'
        }
      })
      if (humanMessage === null) {
        // 票 09 裁决：与 :1524 的 agent-start 同一面——账本 label 一个字不改（B55 锚点逐字钉着）。
        appendEvent(projectId, 'textbook/agent-end', { label: `批量转换 ${pending.length} 本 PDF`, outcome: 'ok' }, Date.now() - startedAt)
      } else {
        appendEvent(projectId, 'textbook/error', {
          task: '转换',
          message: humanMessage,
        })
        return 'error'
      }
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error)
      // F26（2026-08-20）：同上，把人话错误落 meta.lastErrorHuman（旧账本读取时 ?? null 兜底）。
      updateMeta(projectId, (state) => {
        state.converting = false
        state.status = 'error'
        state.lastErrorHuman = message
      })
      appendEvent(projectId, 'textbook/error', {
        task: '转换',
        message,
      })
      return 'error'
    }
  }
}


/** 真实模式：源探查交办给主 AI；演示模式：内置回放（共用产物判定/推进语义）。 */
/** 幂等置态 + 提示（状态没变就不重复写账/发提示）。真实与演示共用。
 *  ⚠️ 原先它还收一个 `meta` 参数——9 个调用方里 5 个递的是自己手里那份**旧状态**（长跑期间拿的），
 *  写回时把账高一起带回旧值（参数透传变体，票 02）。现在它自己去读，参数透传这个形状没有了。 */
function ensureStatus(projectId, status, hint) {
  let changed = false
  updateMeta(projectId, (meta) => {
    if (meta.status === status) return
    meta.status = status
    changed = true
  })
  if (changed && hint !== undefined) appendEvent(projectId, 'textbook/hint', { text: hint })
}


/** 演示模式统一步进：agent-start → 生成 → agent-end → 后续（置态/推进）。
 *  真实模式由主 AI 经 stage-brief/stage-submit 完成（见各 runPhaseX）；
 *  demo 是内置回放适配器，只做内容编排，状态机步进与真实共用 ensureStatus/advance/recordAgentError。 */
async function demoStep(ctx, projectId, meta, label, exec, after) {
  const runtime = projectRuntime(ctx, projectId, meta)
  const artifact = artifactDataForLabel(label, goldN(meta))
  const startedAt = Date.now()
  appendEvent(projectId, 'textbook/agent-start', { label, path: artifact.path, chapter: artifact.chapter })
  try {
    await exec(runtime)
    appendEvent(projectId, 'textbook/agent-end', { label, outcome: 'ok', path: artifact.path, chapter: artifact.chapter }, Date.now() - startedAt)
    if (after !== undefined) return await after(runtime)
    return 'advanced'
  } catch (error) {
    return recordAgentError(projectId, label, error)
  }
}


/**
 * **「此刻还有几个小助手在跑」**——只数个数，不碰它们。
 *
 * ⚠️ 它**不**进任何「就绪」判据（见 {@link exploreArtifactProblems} 的窄处）：`activity === 'running'`
 * 只表示那条子会话的记录还在会话库里活着（**驻留但空闲**也算），不表示「在写」；拿它当就绪判据会造出
 * 「小助手跑挂了就永远不齐」的死锁。它进两处：**卡上的活性文案**、**重做/归档前的那道闸**
 * （票 `premature-announce/01`；此前唯一消费者是 `pause`）。
 *
 * 形状取自随代码入库的契约快照 `docs/reference/dsh-subagent-contracts.md`：子代理条目的字段是
 * **`id`**（宿主**没有** `childId` 这个字段），活性位是 `activity`——`'running'` 表示这条子会话的
 * 记录还在会话库里活着，`'inactive'` 表示只剩磁盘上的记录。⚠️ 这个数**含编排脚本成员**。
 *
 * 数不出来时返回 `null`（「不知道」，不是 0）。**「数不出来」有两条路，都归到下面那个 `catch`**：
 * ① 宿主服务缺席（`ctx.subagents` 没挂、或它没有 `listDescendants`）——可选链短路成 `undefined`，
 *   这里的 `?? null` **刻意不写成 `?? []`**（折成 `[]` 就与「确实为 0」不可区分，票 10），
 *   紧接着的缺席守卫抛错；② `listDescendants` 调用真的抛错。
 * 这一层 try/catch **是会执行的**守卫——调用方不许因为一条附注而失败。
 * ⚠️ 消费它的两处都按「`null` ＝ 不知道 ⇒ **不拦人**」处置：`null` 不是「有人在跑」。
 *
 * ⚠️ 它**不**收回任何小助手：`ctx.subagents.interrupt` 在本仓是登记过的**禁读**成员
 * （`dev/host-contract-gate/catalog/web-chat.js` 的 `forbiddenMemberReads`；边界写在
 * `actions/collab-signals.js` 那一族注释里）——收回小助手是主笔 AI 自己的事。
 *
 * @returns {Promise<number|null>} 在跑的小助手个数；数不出来时 null
 */
export async function countRunningSubagents(ctx, sessionId) {
  try {
    // 「数不出来」不许折成 `[]`（票 host-contract-gate/10）：折成 `[]` 会让「服务缺席」与
    // 「确实一个都没在跑」变成同一个 0，主笔 AI 分不开。折成 `null` 后由下面那次守卫抛错，
    // 与「调用真的抛错」走同一条出口——`catch` 是缺席的唯一出口（改前它对这一支是死代码）。
    const children = await ctx?.subagents?.listDescendants?.(sessionId) ?? null
    if (children === null) throw new Error('宿主小助手服务缺席：ctx.subagents.listDescendants 不可用')
    return children.filter((child) => child?.activity === 'running').length
  } catch (e) {
    ctx?.logger?.warn?.(`textbook: 没数出小助手个数（记 null 不记 0）: ${String(e instanceof Error ? e.message : e)}`)
    return null
  }
}


/**
 * **源探查的就绪判据（全仓唯一一份）**：盘上那几件产物齐了吗？
 *
 * ## 它治的病：早宣告
 *
 * 状态机把「工序中途出现的那**一件**产物」当成「这一步做完了」，于是对用户宣告了一件还没发生的事。
 * 2026-10-10 实跑（`抑郁患者自救`）：那张卡在 `13:58:23.543` 跳出，而 5 件产物**一件都不存在**、
 * 两个精读小助手都还在跑——卡比真就绪早 **4 分 29 秒**，而且那一刻点「满意」会 200 并把书推过这一段，
 * 于是只在交工成功支里诞生的 `工作区/knowledge-map.json` **永久缺位**（回去的路又被 pendingStage 闸焊死）。
 *
 * 三处消费**同一份**：**置态**（{@link runPhase2} 真实支）、**放行**（`explore-confirm` 那座闸）、
 * **交工验货**（`stage-submit explore`）——⛔ 不许任何一处另抄一份枚举（票 `dev-gate-scan/17` 那条纪律）。
 *
 * ## 报错措辞与交工验货逐字同一份
 *
 * 交工那一跳直接拿 `problems[0]` 当 400 文案 ⇒ 这里改一个字，那条 400 也跟着改
 * （`test-explore-handoff-content.mjs` 锚着「探查报告缺必做项：… 」那一句）。所以别在这里另写人话。
 *
 * ## 窄处（判据声称的强度＝实现强度）
 *
 * 它只断「**在不在、能不能拼、形状对不对**」——分片内容真假、知识点抽得准不准仍归真机层与抽查那一面；
 * 也**不看**「还有几个小助手在跑」（`activity === 'running'` 只表示会话还在，不表示在写；
 * 拿它当就绪判据会造出「小助手跑挂了就永远不齐」的死锁）。小助手数只进两处：卡上的活性文案、
 * 重做/归档前的那道闸。
 *
 * @param {string} projectId
 * @param {object|null} [meta] 调用方手里那份状态；不递就自己读（⛔ 别递长跑期间拿的旧状态去写回）
 * @param {{atSubmit?: boolean}} [options] **交工那一跳**传 `true`：那时合并件还没诞生（这一跳自己写它），
 *   而且演示书**不分叉**——`stage-submit(explore)` 验的就是真实工序该有的那几件
 * @returns {{problems: string[], shards: Array<{n: number, map: unknown}>}}
 */
export function exploreArtifactProblems(projectId, meta = null, options = {}) {
  const problems = []
  const shards = []
  const state = meta ?? readMeta(projectId)
  if (state === null) return { problems: ['这本书的状态读不出来（账上的 meta 不在）'], shards }
  const exploreText = existsSync(workFile(projectId, 'explore.md'))
    ? readFileSync(workFile(projectId, 'explore.md'), 'utf8')
    : ''
  if (exploreText.trim() === '') {
    problems.push('工作区/explore.md 不存在或为空，请先写好探查报告再交工')
  } else {
    const exploreTier = exploreDepthTier(state.sources)
    const missingItems = exploreTier.required.filter((item) => !exploreText.includes(item))
    if (missingItems.length > 0) {
      problems.push(`探查报告缺必做项：${missingItems.join('、')} —— 工作区/explore.md 要有这几节（本次 ${exploreTier.count} 份转换完成的源 → ${exploreTier.tier}档，必做：${exploreTier.required.join('、')}），小节名照交办说明逐字写，机器按名字找。`)
    }
  }
  const atSubmit = options.atSubmit === true
  // ⚠️ **这条判据唯一的分叉**（登记在 `src/demo-exemptions.js` 的 `explore-artifact-shards`）：
  // 演示通道**没有「精读小助手」这回事**——分片与细目在那条路上**没有来源**（结构性到不了，不是没做完），
  // 「就绪」那一档因此跳过它们。⚠️ **交工那一跳不分叉**：`stage-submit(explore)` 验的就是真实工序
  // 该有的那几件，演示书漏交一片照样 400（`test-explore-handoff-content.mjs` 第 5 节② 钉着这条机器证据）。
  const demoBook = !atSubmit && state.demo === true
  const okNumbers = demoBook ? [] : okMaterialNumbers(state.sources)
  const shardMissing = okNumbers
    .filter((n) => !existsSync(workFile(projectId, knowledgeShardName(n))))
    .map((n) => knowledgeShardRel(n))
  if (shardMissing.length > 0) {
    problems.push(`知识地图分片缺失：${shardMissing.join('、')} —— 每份转换完成的材料都要有一片（逐份派精读小助手时由它落盘，机器按这些片拼成 工作区/knowledge-map.json），缺 ${shardMissing.length} 片。`)
  }
  const detailMissing = okNumbers
    .filter((n) => !existsSync(join(detailDir(projectId), readingName(n))))
    .map((n) => readingRel(n))
  if (detailMissing.length > 0) {
    problems.push(`精读细目缺失：${detailMissing.join('、')} —— 每份转换完成的材料都要有一份细目（逐份派精读小助手时由它自己落盘，主笔不用转写），缺 ${detailMissing.length} 份。`)
  }
  const brokenShards = []
  for (const n of okNumbers) {
    let map = null
    try { map = JSON.parse(readFileSync(workFile(projectId, knowledgeShardName(n)), 'utf8')) } catch { map = null }
    if (map === null || typeof map !== 'object' || Array.isArray(map)) brokenShards.push(knowledgeShardRel(n))
    else shards.push({ n, map })
  }
  if (brokenShards.length > 0) {
    problems.push(`知识地图分片读不出（不是严格 JSON 对象）：${brokenShards.join('、')} —— 那一片要按精读契约重写；机器按各片拼合并件，读不出就拼不出这一份。`)
  }
  const shardShapes = shardShapeProblems(shards)
  if (shardShapes.length > 0) problems.push(`知识地图分片形状不对：${shardShapes.join('；')}`)
  // 合并件：机器是它**唯一**的写入者，它在交工成功那一刻才诞生 ⇒ 盘上没有它，就等于这一段还没交工。
  // ⚠️ 交工那一跳自己就是写它的那一跳，所以那一处传 `atSubmit: true`。
  if (!atSubmit && !existsSync(workFile(projectId, 'knowledge-map.json'))) {
    problems.push('知识地图还没生成（工作区/knowledge-map.json 不在）—— 它由机器在主 AI 交工那一刻按分片拼装；盘上没有它，说明这一段还没交工')
  }
  return { problems, shards }
}


/**
 * **章节骨架那一段的就绪判据**（放行那一跳用；票 `premature-announce/01`）。
 *
 * ⚠️ 它比探查那一份**窄**，窄处写在明面上：交工验货在 `stage-submit(outline)` 里验的是**内容**
 * （大纲字段归一化、知识点覆盖、章数契约），而那些判据读的是**交工请求体**——放行那一刻拿不到。
 * 这一份只断两件**盘上事实**：
 *   · `工作区/outline.md` 非空（这一段唯一的产物，机器在交工成功那一刻写它）
 *   · `工作区/knowledge-map.json` 在盘（骨架的知识点覆盖判据读的就是它；它不在，后面必然撞 400）
 *
 * @param {string} projectId
 * @param {object|null} [meta] 调用方手里那份状态；不递就自己读
 * @returns {string[]} 缺什么（空数组＝就绪）
 */
export function outlineArtifactProblems(projectId, meta = null) {
  const problems = []
  const state = meta ?? readMeta(projectId)
  const outlineText = existsSync(workFile(projectId, 'outline.md'))
    ? readFileSync(workFile(projectId, 'outline.md'), 'utf8')
    : ''
  if (outlineText.trim() === '') {
    problems.push('工作区/outline.md 不存在或为空——这一段还没交工（章节骨架由机器在交工那一刻写它）')
  }
  // ⚠️ 合并件**只在「这本书真有材料」时才要求**——与交工验货那条判据**同一个条件**：
  // `stage-submit(outline)` 的知识点覆盖闸门只在 `okMaterialNumbers(sources).length > 0` 时才读它
  //（零源旧书两处都不读）。凭空要一份不存在的件，就是「判据比现实严」那一类错。
  const hasSources = state !== null && okMaterialNumbers(state.sources).length > 0
  if (hasSources && !existsSync(workFile(projectId, 'knowledge-map.json'))) {
    problems.push('工作区/knowledge-map.json 不在——章节骨架的知识点覆盖读的就是它（源探查那一段的合并件）')
  }
  return problems
}


/**
 * **范例章那一段的就绪判据**（放行那一跳用；票 `premature-announce/01`）。
 *
 * ⚠️ **它不翻 `ADR-0034` 裁决甲**：裁决甲管的是 {@link runPhase4} 那道**置态**闸门
 * （「稿在盘就提前展示」——有意，一个字不动）；本函数管的是**放行**那一跳（用户点「定稿」时，
 * 这三件必须真在盘上）。两者不是一件事，本票只做后者。
 *
 * 判据与交工验货**同一份来源**（`stage-submit gold` 里那三行 `missing` 逐字）：章正文、
 * `style-spec.md`、检查记录 `audit-NN.md`，「在盘且非空」。⛔ 内容判据（style-spec 五个节标题、
 * 审计矩阵、正文与分片的一致性）**不在这里**：它们读的是内容与交工请求体，而顺序是「先交工、再放行」
 * ——交工那一跳已逐项验过；这一跳只防「产物被搬走／删掉之后书还往前走」。
 *
 * ⚠️ 它堵的是**静默跳过交工**那条路：跳过 `stage-submit gold`，`styleSpecHash` 永不定格，
 * 终检那一条对账会**静默不成立**（票 `05` 记的那半处不可逆）。
 *
 * @param {string} projectId
 * @param {object|null} [meta] 调用方手里那份状态；不递就自己读
 * @returns {string[]} 缺什么（空数组＝就绪）
 */
export function goldArtifactProblems(projectId, meta = null) {
  const state = meta ?? readMeta(projectId)
  if (state === null) return ['这本书的状态读不出来（账上的 meta 不在）']
  const gN = goldN(state)
  const missing = [chapterName(gN), 'style-spec.md', `audit-${String(gN).padStart(2, '0')}.md`].filter((name) => {
    const target = workFile(projectId, name)
    return !existsSync(target) || readFileSync(target, 'utf8').trim() === ''
  })
  return missing.length > 0 ? [`范例章文件缺失或为空：${missing.join('、')}`] : []
}


async function runPhase2(ctx, projectId, meta) {
  if (meta.demo) {
    // 演示模式：与真实共用确认闸门——产物已存在 → 停 awaiting-explore 等人拍板；内容来自内置回放。
    if (existsSync(workFile(projectId, 'explore.md'))) {
      ensureStatus(projectId, 'awaiting-explore', EXPLORE_DONE_HINT)
      return 'waiting'
    }
    return demoStep(ctx, projectId, meta, '源探查', async (runtime) => {
      const result = await generateContent(runtime, 'explore')
      // v2：源探查产出人读索引 + 结构化知识地图（后续设计/写作直接复用）。
      writeWork(projectId, 'explore.md', result.index ?? result.text ?? '')
      if (result.knowledgeMap !== undefined) {
        writeWork(projectId, 'knowledge-map.json', JSON.stringify(result.knowledgeMap, null, 2))
      }
    }, () => {
      ensureStatus(projectId, 'awaiting-explore', EXPLORE_DONE_HINT)
      return 'waiting'
    })
  }
  // 真实模式：源探查交办给主 AI。⚠️ 「这一步做完没有」**只看那一份就绪判据**（票 `premature-announce/01`）：
  // 原先这里只看 `工作区/explore.md` 在不在——主笔一写索引底稿，机器就宣告「材料读完了」，而精读小助手
  // 还在跑（2026-10-10 实跑：卡早 4 分 29 秒；那一刻点「满意」会把书推过这一段，合并件永久缺位）。
  // 已经拍过板（`exploreConfirmed`）的书照旧往前推——放行那一跳自己会过同一份闸。
  if (meta.exploreConfirmed === true) {
    advance(projectId, 2, 3)
    return 'advanced'
  }
  if (exploreArtifactProblems(projectId, meta).problems.length === 0) {
    ensureStatus(projectId, 'awaiting-explore', EXPLORE_DONE_HINT)
    return 'waiting'
  }
  if (meta.pendingStage === 'explore') return 'waiting'
  handoff(ctx, projectId, 'explore')
  return 'waiting'
}
/** 统计某关卡被驳回的次数（从时间线折叠）。 */
function countRejections(projectId, gate) {
  let count = 0
  for (const event of readEvents(projectId)) {
    if (event.type === 'textbook/gate-decision' && event.data?.gate === gate && event.data.approved === false) {
      count += 1
    }
  }
  return count
}


/** 统计某关卡已提案的次数（用于算下一版版本号）。 */
function countProposals(projectId, gate) {
  let count = 0
  for (const event of readEvents(projectId)) {
    if (event.type === 'textbook/gate-proposal' && event.data?.gate === gate) count += 1
  }
  return count
}


/** 该关卡是否已经通过（对该关卡最新提案的决策为通过）。 */
function gateApproved(projectId, gate) {
  let proposal = null
  let decision = null
  for (const event of readEvents(projectId)) {
    if (event.type === 'textbook/gate-proposal' && event.data?.gate === gate) {
      proposal = event
      decision = null
    } else if (event.type === 'textbook/gate-decision' && event.data?.gate === gate && proposal !== null) {
      decision = event
    }
  }
  return decision !== null && decision.data?.approved === true
}


/** 关卡循环：提案 → 等拍板；通过返回，驳回自动生成修订版再等（不限轮次，每 3 轮提示调整目标）。 */
async function runGate(ctx, projectId, meta, gate) {
  for (;;) {
    // 已通过的关卡直接跳过（宿主重启后从 gate 1 重来也不重复生成）。
    if (gateApproved(projectId, gate)) return 'approved'
    const current = foldGate(projectId)
    if (current !== null && current.gate === gate && current.status === 'approved') return 'approved'
    if (current !== null && current.gate === gate && current.status === 'awaiting') {
      await waitForGateDecision(projectId, gate, current.version)
      continue
    }
    // 需要生成提案（首次）或修订版（被驳回后）。
    const prevDecision = current !== null && current.gate === gate ? current.decision : null
    const prevVersion = current !== null && current.gate === gate ? current.version : 0
    const version = prevVersion + 1
    const rejectCount = countRejections(projectId, gate)
    if (rejectCount > 0 && rejectCount % 3 === 0) {
      appendEvent(projectId, 'textbook/hint', {
        // 票 14（承诺账 G）：界面的「回退」只到最近一次存档，**回不到更早的拍板点**——
        // 「回到更早的拍板点并重做下游」只有定点修改能做（CONTEXT.md：「回退（快照）」与
        // 「定点修改」是两条路，勿混用）。这句话由主笔 AI 转述给用户，说错路名用户就找不到。
        text: `这一关已经来回 ${rejectCount} 次了。如果一直不满意，可以在对话里调整目标或换一种思路，或者用「定点修改」回到更早的拍板点重新来。`,
      })
    }
    const runtime = projectRuntime(ctx, projectId, meta)
    const label = version === 1 ? `设计提案·关卡${gate}` : `设计提案·关卡${gate}·修订v${version}`
    const artifact = artifactDataForLabel(label, goldN(meta))
    const startedAt = Date.now()
    appendEvent(projectId, 'textbook/agent-start', { label, path: artifact.path, chapter: artifact.chapter })
    try {
      const proposal = await generateContent(runtime, 'gate', {
        gate, version, prevSummary: current?.summary ?? null, decision: prevDecision,
      })
      // 安全网：设计方案缺字段就中止，绝不生成空提案占住面板。
      if (typeof proposal?.title !== 'string' || proposal.title.trim() === ''
        || typeof proposal?.summary !== 'string' || proposal.summary.trim() === ''
        || typeof proposal?.detail !== 'string' || proposal.detail.trim() === '') {
        throw new Error('设计方案不完整（缺少标题/摘要/正文），已中止生成，请重试')
      }
      appendEvent(projectId, 'textbook/agent-end', { label, outcome: 'ok', path: artifact.path, chapter: artifact.chapter }, Date.now() - startedAt)
      if (version === 1) {
        proposeGate(projectId, gate, proposal.title, proposal.summary, proposal.detail)
      } else {
        proposeRevision(projectId, gate, version, proposal.title, proposal.summary, proposal.detail)
      }
      await waitForGateDecision(projectId, gate, version)
    } catch (error) {
      return recordAgentError(projectId, label, error)
    }
  }
}


/** 真实模式：三关设计提案与章节骨架全部交办给主 AI；演示模式：三关自动跑 + 骨架回放（共用 runGate/advance）。 */
async function runPhase3(ctx, projectId, meta) {
  if (meta.demo) {
    // 演示模式：三关逐关提案→等拍板（runGate），全部通过后章节骨架回放生成。
    for (const gate of ['1', '2', '3']) {
      const result = await runGate(ctx, projectId, meta, gate)
      if (result !== 'approved') return result
    }
    if (meta.outline === undefined) {
      const outlineResult = await demoStep(ctx, projectId, meta, '整理章节骨架', async (runtime) => {
        const outline = await generateContent(runtime, 'outline', {})
        // 改在改法里写（不拿手里那份旧状态整份写回）：生成要 await，期间账本可能已经动过。
        updateMeta(projectId, (state) => { state.outline = outline })
        // ⚠️ 演示模式写的是**同一份 JSON**（与 `actions/chapters.js` 的真实模式一个文件、一个形状）：
        // 所以产物判据对两条路是同一条——`工作区/outline.md` 判 `'inline'`、不开右栏预览
        // （票 pipeline-wiring-gaps/09），人读形态是章节安排确认卡与阶段页第 3 阶段的就地折叠清单。
        writeWork(projectId, 'outline.md', JSON.stringify(outline, null, 2))
      })
      if (outlineResult !== 'advanced') return outlineResult
    }
    // 票 10（判定一 #7）：按钮名统一成「🔁 让 AI 重做」，这句告诉用户点哪个按钮的播报跟着改。
    ensureStatus(projectId, 'awaiting-outline', '📐 章节安排出来了，请在工作台查看：满意点「✅ 通过」，不满意点「🔁 让 AI 重做」，AI 会重新安排。')
    return 'waiting'
  }
  // 真实模式：三关设计提案与章节骨架全部交办给主 AI（已通过的关自动跳过）。
  for (const gate of ['1', '2', '3']) {
    if (gateApproved(projectId, gate) || waived(projectId, 'gate-skip')) continue
    if (meta.pendingStage === 'gate' && meta.pendingGate === gate) return 'waiting'
    handoff(ctx, projectId, 'gate', gate)
    return 'waiting'
  }
  // 章节安排在等用户人审（outline-confirm）：停在确认点，不自动推进。
  if (meta.status === 'awaiting-outline') return 'waiting'
  if (meta.outline === undefined) {
    if (meta.pendingStage === 'outline') return 'waiting'
    handoff(ctx, projectId, 'outline')
    return 'waiting'
  }
  advance(projectId, 3, 4)
  return 'advanced'
}
/** 真实模式：最佳范例章交办给主 AI（金标准，全书基准）；演示模式：回放生成（共用 awaiting-gold 闸门）。 */
async function runPhase4(ctx, projectId, meta) {
  const gn = goldN(meta)
  if (existsSync(workFile(projectId, chapterName(gn)))) {
    // 已写好：必须用户确认后才进全章写作（awaiting-gold）。真实与演示共用同一块（原逐字节相同）。
    ensureStatus(projectId, 'awaiting-gold', '📖 最佳范例章写好了，请在工作台查看：满意点「✅ 满意，继续写全书」，不满意点「❌ 重写」。')
    return 'waiting'
  }
  if (meta.demo) {
    // 演示模式：范例章回放生成，产出后停在 awaiting-gold 等人拍板（与真实同闸门）。
    return demoStep(ctx, projectId, meta, '最佳范例章（先写一章给你看）', async (runtime) => {
      const outline = meta.outline ?? { chapters: [{ title: '示例章节', outline: '' }] }
      const result = await generateContent(runtime, 'gold', {
        outline, targetWords: meta.targetWords, chapterSource: outline.chapters?.[goldN(meta) - 1]?.source ?? '',
        redoNote: meta.goldRedoNote ?? '',
      })
      writeWork(projectId, 'style-spec.md', result.styleSpec)
      writeWork(projectId, chapterName(gn), result.chapter)
      writeWork(projectId, `audit-${String(gn).padStart(2, '0')}.md`, JSON.stringify(result.audit, null, 2))
      if (result.audit?.passed === false) {
        appendEvent(projectId, 'textbook/hint', { text: '最佳范例章检查发现待完善项，已随章记录，可在交付前查看。' })
      }
    }, async () => {
      // 对齐真实模式 stage-submit gold：新稿落地即意见转 applied、本轮重做意见用毕即清。
      updateMeta(projectId, (state) => {
        if (Array.isArray(state.goldOpinions)) {
          for (const o of state.goldOpinions) if (o.status === 'sent') o.status = 'applied'
        }
        delete state.goldRedoNote
      })
      ensureStatus(projectId, 'awaiting-gold', '📖 最佳范例章写好了，请在工作台查看：满意点「✅ 满意，继续写全书」，不满意点「❌ 重写」。')
      return 'waiting'
    })
  }
  if (meta.pendingStage === 'gold') return 'waiting'
  handoff(ctx, projectId, 'gold')
  return 'waiting'
}
/** 演示模式 · 铺章的内容编排（回放）：逐章写 + 自查。
 *  只做内容落盘与 agent 事件，不路由状态机（推进/闸门由 runPhase5 负责）。
 *  真实模式铺章由主 AI 经 stage-brief/stage-submit 完成，不在这里。 */
async function demoWriteChapters(ctx, projectId, meta) {
  const chapters = meta.outline?.chapters ?? [{ title: '第1章', outline: '' }]
  const styleSpec = existsSync(workFile(projectId, 'style-spec.md')) ? readWork(projectId, 'style-spec.md') : ''
  const audits = []
  for (let index = 0; index < chapters.length; index += 1) {
    const n = index + 1
    const file = chapterName(n)
    const chapterPath = workFile(projectId, file)
    if (existsSync(chapterPath)) {
      const auditPath = workFile(projectId, `audit-${String(n).padStart(2, '0')}.md`)
      if (existsSync(auditPath)) {
        try { audits.push(JSON.parse(readFileSync(auditPath, 'utf8'))) } catch { audits.push({ passed: true }) }
      }
      // 票 14「演示通道照旧走到过目」：范例章那一章在第 4 阶段就已落盘（`chapter-0N.md` ＋ audit），
      // 这里原本直接 `continue`——于是这一章**永远没有章级完成事件**，新闸门（两份产物在 ＋ 机器记下的
      // 交工通过）在 demo 上就永远为假，demo 会卡死在过目门前。
      // 处置：**在这里补写入点**（不重写产物、不动内容），落一条与下面新写章节同形状的「写第N章」事件。
      // 判据不给 demo 开口子（spec 第 6 条：若某条演示流程缺章级事件，就在那里补写入点）。
      if (!chapterHasSubmitEvent(projectId, n, meta)) {
        const artifact = artifactDataForChapter(n)
        appendEvent(projectId, 'textbook/agent-end', { label: `写第${n}章`, outcome: 'ok', path: artifact.path, chapter: artifact.chapter })
      }
      continue
    }
    const runtime = projectRuntime(ctx, projectId, meta)
    const title = chapters[index].title ?? `第${n}章`
    const artifact = artifactDataForChapter(n)
    const writeStartedAt = Date.now()
    appendEvent(projectId, 'textbook/agent-start', { label: `写第${n}章《${title}》`, path: artifact.path, chapter: artifact.chapter })
    try {
      const written = await generateContent(runtime, 'chapter', {
        n, title, outline: chapters[index].outline ?? '', styleSpec,
        targetWords: chapters[index].targetWords ?? meta.targetWords,
        chapterSource: chapters[index].source ?? '',
      })
      // demo 通道的 chapter 产物是字符串（demoChapterWrite 直接返回正文），不是 {text} 对象。
      writeWork(projectId, file, written)
      appendEvent(projectId, 'textbook/agent-end', { label: `写第${n}章`, outcome: 'ok', path: artifact.path, chapter: artifact.chapter }, Date.now() - writeStartedAt)
    } catch (error) {
      return recordAgentError(projectId, `写第${n}章`, error)
    }
    const auditStartedAt = Date.now()
    appendEvent(projectId, 'textbook/agent-start', { label: `自查第${n}章` })
    try {
      const audit = await generateContent(runtime, 'audit', {
        n, title, chapterPath,
      })
      writeWork(projectId, `audit-${String(n).padStart(2, '0')}.md`, JSON.stringify(audit, null, 2))
      audits.push(audit)
      appendEvent(projectId, 'textbook/agent-end', { label: `自查第${n}章`, outcome: audit.passed === true ? 'ok' : 'issues' }, Date.now() - auditStartedAt)
    } catch (error) {
      // 审计失败也落盘一条"警告"记录，保证每章都有审计记录（质量门可核）。
      const fallback = { passed: true, issues: [{ level: '警告', text: `自查未能完成：${String(error instanceof Error ? error.message : error)}` }] }
      writeWork(projectId, `audit-${String(n).padStart(2, '0')}.md`, JSON.stringify(fallback, null, 2))
      audits.push(fallback)
      appendEvent(projectId, 'textbook/error', { task: `自查第${n}章`, message: String(error instanceof Error ? error.message : error) })
    }
  }
}


/** 演示模式 · 合并成书的内容编排（回放）：把已过目的章节拼成 book.md。
 *  与 demoWriteChapters 分开：全章过目闸门（awaiting-chapters-review）通过后才调它。 */
async function demoMergeBook(ctx, projectId, meta) {
  if (existsSync(workFile(projectId, 'book.md'))) return
  const runtime = projectRuntime(ctx, projectId, meta)
  const artifact = artifactDataForLabel('合并成书', goldN(meta))
  const startedAt = Date.now()
  appendEvent(projectId, 'textbook/agent-start', { label: '合并成书', path: artifact.path })
  try {
    const merged = await generateContent(runtime, 'merge', {
      chapters: (meta.outline?.chapters ?? [{ title: '第1章' }]).map((chapter, index) => {
        const file = chapterName(index + 1)
        return {
          n: index + 1,
          title: chapter.title ?? `第${index + 1}章`,
          path: workFile(projectId, file),
          text: existsSync(workFile(projectId, file)) ? readWork(projectId, file) : '',
        }
      }),
      title: meta.name,
    })
    // demo 通道的 merge 产物是字符串（demoMergeBook 直接返回正文），不是 {text} 对象。
    writeWork(projectId, 'book.md', merged)
    appendEvent(projectId, 'textbook/agent-end', { label: '合并成书', outcome: 'ok', path: artifact.path }, Date.now() - startedAt)
  } catch (error) {
    return recordAgentError(projectId, '合并成书', error)
  }
}


/** 真实模式：铺章交办给主 AI（小助手执笔 → 小助手审计 → 主 AI 终审），全部完成后交办合并；演示模式：回放编排。 */
async function runPhase5(ctx, projectId, meta) {
  if (meta.demo) {
    // 演示模式：与真实共用「全部写完 → 全章过目闸门 → 合并」的步进语义，内容来自内置回放。
    // 过目闸门判据与真实同源（chapterDone，票 14）：演示通道逐章写「写第N章」的 agent-end、
    // 范例章那章另有一条「最佳范例章（先写一章给你看）」——写入点早已存在，这里只是让闸门读它，
    // 所以 demo 轨迹零变化（ADR-0004，不重录 cassette）。
    const chapters = meta.outline?.chapters ?? []
    const allDone = chapters.length > 0 && chapters.every((_chapter, index) => chapterDone(projectId, index + 1))
    if (allDone) {
      if (!existsSync(workFile(projectId, 'book.md'))) {
        // 全章过目闸门（与真实共用）：写完先请人过目，通过才合并。
        if (meta.chaptersReviewed !== true) {
          ensureStatus(projectId, 'awaiting-chapters-review', '📚 全部章节都写好了！请在工作台逐章过目：想细看就点「看看这章」，有意见直接写（AI 会照改）；都满意了点「✅ 都过了，交工」开始合并。')
          return 'waiting'
        }
        const mergeResult = await demoMergeBook(ctx, projectId, meta)
        if (mergeResult === 'error') return mergeResult
        advance(projectId, 5, 6)
        return 'advanced'
      }
      advance(projectId, 5, 6)
      return 'advanced'
    }
    const writeResult = await demoWriteChapters(ctx, projectId, meta)
    if (writeResult === 'error') return writeResult
    ensureStatus(projectId, 'awaiting-chapters-review', '📚 全部章节都写好了！请在工作台逐章过目：想细看就点「看看这章」，有意见直接写（AI 会照改）；都满意了点「✅ 都过了，交工」开始合并。')
    return 'waiting'
  }
  // 真实模式：铺章交办给主 AI（小助手执笔 → 小助手审计 → 主 AI 终审），全部完成后交办合并。
  const chapters = meta.outline?.chapters ?? []
  // 过目闸门「全部章节都写好了」＝ 每章**两份产物在 ＋ 机器记下的交工通过 ＋ 没有未处置的抽查意见**
  // （票 14 / 票 05 裁决 A；判据在 chapterDone 一处）。不再只数文件在不在——真机发生过「5 章文件齐全、
  // 账本只有 1 条章级完成事件」也一路进了过目 → 合并 → 交付。老书某章没交工就重新走既有逐章交工。
  const allDone = chapters.length > 0 && chapters.every((_chapter, index) => chapterDone(projectId, index + 1))
  if (allDone) {
    // ⚠️ 「机器已合并」**只认当前账本里的交工事实**（票 walkthrough-2026-10/10 裁决 A）。
    // 回退（快照）会把 `timeline.jsonl` 换回快照那一刻（ADR-0016 决策 3 的明文例外），而
    // **回退不删产物文件**——`book.md` 照旧在盘上。原先这里只看 `existsSync(book.md)`，于是
    // 回退到「交办合并之前」之后：机器看见旧书还在 ⇒ 直接 `advance(5,6)` 跳过合并，
    // 「合并成书」这一步再也点不动，成品变成 AI 手拼——「机器 100% 保真拼装」这条契约在回退
    // 路径上被绕过（真机账本 seq 107–113 的实录）。现在盘上有 `book.md` **且**当前账本里有
    // 一条合并交工，才算「机器已合并」；否则照常走全章过目闸门 → 交办合并（重拼由机器做）。
    if (!existsSync(workFile(projectId, 'book.md')) || !mergeSubmitRecorded(projectId)) {
      // 全章过目闸门（真实模式）：所有章写完先请人过目，不自动合并（F18）。
      if (meta.status !== 'awaiting-chapters-review' && meta.chaptersReviewed !== true && meta.demo !== true) {
        updateMeta(projectId, (state) => { state.status = 'awaiting-chapters-review' })
        appendEvent(projectId, 'textbook/hint', {
          text: '📚 全部章节都写好了！请在工作台逐章过目：想细看就点「看看这章」，有意见直接写（AI 会照改）；都满意了点「✅ 都过了，交工」开始合并。',
        })
        return 'waiting'
      }
      if (meta.pendingStage === 'merge') return 'waiting'
      handoff(ctx, projectId, 'merge')
      return 'waiting'
    }
    advance(projectId, 5, 6)
    return 'advanced'
  }
  if (meta.pendingStage === 'chapters') return 'waiting'
  handoff(ctx, projectId, 'chapters')
  return 'waiting'
}
const SCAFFOLD_MARKERS = /\b(META|TODO|FIXME|HACK)\b|审计批注|未决问题|loader 指令/g


function scanScaffolding(text) {
  const found = []
  for (const match of text.matchAll(SCAFFOLD_MARKERS)) {
    const lineNo = text.slice(0, match.index).split('\n').length
    const line = text.slice(0, match.index).split('\n').pop()?.trim().slice(0, 60) ?? ''
    found.push(`${match[0]}（第 ${lineNo} 行：${line}）`)
  }
  return found
}


/** 正则元字符转义（票 20 护栏 ①）。
 *  * 为什么必须有它*：`runQualityChecks` 是**同步调用**（`chapters.js` 的单章验货与终检各一处），
 *  AI 在 style-spec 里声明的标题会**原样进 `new RegExp`**——`## 备注（草稿` 这种写法抛 `SyntaxError`，
 *  抛出即把一次交工打成 500。**闸门会被声明文本杀死**，是本条最坏的一种失败。
 *  超长/超量标题在 `declaredScaffoldTitles` 里已先收口，这里是最后一道。 */
function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 声明「本书没有这类标题」的写法——**认出它等于不追加，不是关闭扫描**。 */
const NO_SCAFFOLD_TITLES = /^(无|没有|不需要|无额外|不适用|无额外标题|本书无)/
/** 数量上限（票 20 护栏 ③）：再宽的声明也会把 check note 变成一本账。 */
const DECLARED_TITLE_MAX = 12
/** 长度上限：与 `parseStyleSpecList` 既有的 ≤20 字符过滤同档（它先收口，这里是显形的第二道）。 */
const DECLARED_TITLE_MAX_LEN = 20

/**
 * 票 20：读 style-spec 行首的「脚手架标题：」声明（**复用 `parseStyleSpecList`**，判据句式与豁免出口
 * 照抄现有实现——必含板块/禁用词那两项就是这么读的）。
 *
 * 契约原则（`parseStyleSpecList` 的注释与 CONTEXT.md 质量门词条逐字记着）：**没显式列出就跳过该项，
 * 不以硬编码词表误判**。读不到文件 / 没声明 → `state` 不是 `declared`，调用方**不追加任何检查项**
 * （那不是「绿」，是「这项没跑」——两者的区别在 check note 上写明）。
 *
 * @returns {{state:'unreadable'|'undeclared'|'declared-none'|'declared', items:string[], dropped:number}}
 */
export function declaredScaffoldTitles(projectId) {
  const path = workFile(projectId, 'style-spec.md')
  if (!existsSync(path)) return { state: 'unreadable', items: [], dropped: 0 }
  const parsed = parseStyleSpecList(readFileSync(path, 'utf8'), '脚手架标题')
  if (parsed === null) return { state: 'undeclared', items: [], dropped: 0 }
  const items = []
  let dropped = 0
  for (const raw of parsed) {
    const title = String(raw).replace(/^`+|`+$/g, '').trim()
    if (title === '') continue
    // 「无／不需要／无额外标题」= 显式声明「没有」：**不追加**，也**不**当成「关闭扫描」。
    if (NO_SCAFFOLD_TITLES.test(title)) continue
    if (title.length > DECLARED_TITLE_MAX_LEN) { dropped += 1; continue }
    if (items.length >= DECLARED_TITLE_MAX) { dropped += 1; continue }
    if (items.includes(title)) continue
    items.push(title)
  }
  return { state: items.length === 0 ? 'declared-none' : 'declared', items, dropped }
}

/**
 * 按声明的标题扫残留（票 20）。逐条独立正则 + `escapeRegExp`——**一个标题炸掉不该让整轮验货炸掉**。
 * @returns {string[]} 形如 `「写作笔记」（第 12 行：…）`
 */
export function scanDeclaredScaffolding(text, titles) {
  const found = []
  for (const title of titles) {
    let re
    try {
      re = new RegExp(escapeRegExp(title), 'g')
    } catch {
      found.push(`「${title}」（声明的标题无法编译，已跳过匹配）`)
      continue
    }
    for (const match of text.matchAll(re)) {
      const lineNo = text.slice(0, match.index).split('\n').length
      const line = text.slice(0, match.index).split('\n').pop()?.trim().slice(0, 60) ?? ''
      found.push(`「${match[0]}」（第 ${lineNo} 行：${line}）`)
    }
  }
  return found
}

/**
 * 票 20：脚手架残留的**两个来源分开报**，报告里不混成一条。
 *   · `declared` —— AI 在 style-spec 声明「本书写作时会用哪些元数据板块标题」的那些（**它要求的**）
 *   · `generic`  —— 硬编码的通用残留标记（`META`/`TODO`/`FIXME`/`HACK`/审计批注/未决问题/loader 指令）
 * ⚠️ 分开是因为两者性质不同：通用残留是**任何书都不该留的**，声明项是**本书特有**的；
 * 混成一条就会让「AI 声明要拆的」看起来像通用规则，而它其实是本书自己定的。
 */
export function scaffoldResidue(projectId, text) {
  const declared = declaredScaffoldTitles(projectId)
  return {
    generic: scanScaffolding(text),
    declared: declared.state === 'declared' ? scanDeclaredScaffolding(text, declared.items) : [],
  }
}

/** 剥掉 human 路线的 loader 指令区（装配说明，留给 AI 老师，不是成品脚手架残留）。 */
function stripLoaderRegion(text) {
  return String(text).replace(/<!-- loader:begin -->[\s\S]*?<!-- loader:end -->/g, '')
}


// ── 标题身份：合并剥章标题与终检判重共用同一份定义（不许两处各写一份正则）──

/** 行首「第N章」（数字或中文数字都收）。章标题行与普通小节标题的分界。 */
const CHAPTER_HEADING_RE = /^第\s*[0-9一二三四五六七八九十百零两]+\s*章/

/**
 * 标题归一化：**只留文字与数字**（剥掉 emoji、符号、标点、空白）。
 * ⚠️ 旧口径只删 8 个标点（`[\s，。、,.·：:]`），emoji 原样留在串里——
 * 「🚧 常见误区」按 6 个字符算，混过了「≥6 字才参与判重」那道闸，于是每章都有的
 * 板块名被判成「重复标题」拦交付（三本真书实测 27 / 12 / 1 处，见 ADR-0008 修订 2026-09-30）。
 */
function headingKey(text) {
  return String(text).replace(/[^\p{L}\p{N}]/gu, '')
}

/**
 * 剥掉章正文自带的章标题行——合并时机器已经拼了一个 `# 第N章 <大纲标题>`，
 * 正文里那一行留着，成品里同一个章标题就出现两次，终检「无重复标题」会把
 * **「第X章」判成重复标题、拦交付**（这正是用户报的那条）。
 * ⚠️ 旧实现 `body.replace(/^#\s+.*$/m, '')` 只认单 `#`：AI 把章标题写成 `##` 时剥不掉。
 * 判据：文件里**第一个**标题行，且它长得像章标题（行首「第N章」，或与本章大纲标题同串）；
 * 第一个标题不是章标题就当它是真的小节标题，一个字不动。
 */
export function stripChapterTitleHeading(body, outlineTitle) {
  const text = String(body)
  const want = headingKey(outlineTitle)
  for (const match of text.matchAll(/^(#{1,6})[ \t]+(.*)$/gm)) {
    const title = match[2].trim()
    if (title === '') continue
    const bare = headingKey(title.replace(CHAPTER_HEADING_RE, ''))
    const isChapterish = CHAPTER_HEADING_RE.test(title) || (want !== '' && bare === want)
    if (!isChapterish) return text
    return text.slice(0, match.index) + text.slice(match.index + match[0].length)
  }
  return text
}


/** 真实模式：最后检查交办给主 AI（自查报告），机器硬检查兜底后交付；演示模式：机器质量门 + 交付（共用 book.md 缺失兜底）。 */
async function runPhase6(ctx, projectId, meta) {
  const bookPath = workFile(projectId, 'book.md')
  if (!existsSync(bookPath)) {
    appendEvent(projectId, 'textbook/error', { task: '交付', message: 'book.md 不存在，请回退重跑' })
    updateMeta(projectId, (state) => { state.status = 'error' })
    return 'error'
  }
  if (meta.demo) {
    // 演示模式：机器质量门 → 停 awaiting-final-approval 等人认可（与真实同闸门），认可后交付。
    const startedAt = Date.now()
    const checks = runQualityChecks(projectId)
    updateMeta(projectId, (state) => { state.finalChecks = checks })
    appendEvent(projectId, 'textbook/quality', { checks })
    appendEvent(projectId, 'textbook/agent-end', { label: '最后检查（质量门）', outcome: 'ok', ...artifactDataForStage('final') }, Date.now() - startedAt)
    ensureStatus(projectId, 'awaiting-final-approval', FINAL_CHECK_DONE_HINT)
    return 'waiting'
  }
  if (meta.pendingStage === 'final') return 'waiting'
  handoff(ctx, projectId, 'final')
  return 'waiting'
}
/** style-spec 指纹：范例章交工时定格，终检交工时对账——契约修改必须留痕（Q9，2026-08-27）。 */
function specFingerprint(projectId) {
  return createHash('sha256').update(readFileSync(workFile(projectId, 'style-spec.md'), 'utf8')).digest('hex').slice(0, 16)
}


/**
 * 票 12 · ①：**机器替 AI 记「它改了机器契约」这一笔**（落账侧检测）。
 *
 * 病（2026-09-29 真机走查）：范例章 22:57:09 定稿、指纹 `1e117f928b674fc7` 定格，
 * **`工作区/style-spec.md` 在 88 分钟后的 00:25:22 被改写**——而这 88 分钟里第 1–12 章全部照**旧版**落盘。
 * 机器**有**判据（终检那一次对账），但它：① 拦在最后一刻、② 拦错了对象（说的是「你的报告要补一句声明」，
 * 不是「你那 12 章是照一份已经作废的契约写的」）、③ **账本里一个字都没有**。
 *
 * 判据只有一条：**当前指纹 ≠ 范例章定稿时定格的那一枚**。其余全是边界：
 * - 范例章还没定稿（`styleSpecHash` 为 null）⇒ 根本没有「定稿后」这一说，不记；
 * - 读不到文件 ⇒ `to` 记 null 并照记一笔（「删掉规范逃检查」也是一次变更，**读不出不是「没变」**）；
 * - **同一次变更只记一条**（`styleSpecSeen` 存的是「已记过的那一枚」）——
 *   调用点在工作台 2 秒一轮的轮询里，不去重就是每两秒一条事件，把账本淹掉。
 *
 * ⚠️ **为什么检测点是一个 GET**：AI 用文件工具直接改盘，服务端没有写入点可挂；
 * 唯一「那段时间里一定在跑」的东西是工作台自己的轮询（`/textbook/process`）。
 * 稳态下它**只读不写**（指纹没变就立即返回），且终检交工那一次也会补检一次，
 * 所以「工作台没开过」也不漏记。**这是一个有意的取舍，写在这里以免下一个人当漏洞改掉。**
 *
 * @returns {boolean} 这一次是否真的新记了一条
 */
function noteStyleSpecChange(projectId) {
  const meta = readMeta(projectId)
  const frozen = meta?.styleSpecHash
  if (frozen == null) return false
  let now = null
  try { now = specFingerprint(projectId) } catch { /* 文件不在/读不到：to 记 null，那也是一次变更 */ }
  if (now === frozen) return false
  if ((meta.styleSpecSeen ?? frozen) === now) return false
  const chapters = (meta.outline?.chapters ?? []).filter((_c, i) => existsSync(workFile(projectId, chapterName(i + 1)))).length
  appendEvent(projectId, 'textbook/style-spec-change', { from: frozen, to: now, chapters })
  updateMeta(projectId, (state) => { state.styleSpecSeen = now })
  return true
}


/** 服务端确定性质量门（机器兜底，不依赖 LLM）：主 AI 自查之外的最后防线。 */
/** 从 style-spec 读机器可判定的契约列表（质量门判据，非硬编码）：
 * 只认行首显式声明的清单行（允许 markdown 标题 # 与加粗 ** 前缀）——「必含板块：」「禁用词：」开头；
 * 正文里「句中提到必含板块」的行不再被误当清单（2026-08-27 grill 修订，防误判卡死交付）。
 * 契约原则：style-spec 没显式列出 → 返回 null，跳过该项检查（不以硬编码词表误判）。 */
function parseStyleSpecList(specText, label) {
  if (typeof specText !== 'string' || specText === '') return null
  const re = new RegExp(`(?:^|\\n)\\s*(?:#{1,6}\\s*)?(?:\\*\\*)?${label}(?:\\*\\*)?\\s*[:：]([^\\n]*)`)
  const m = specText.match(re)
  if (m === null) return null
  const items = m[1].split(/[、,，;；|/]+/).map((s) => s.trim().replace(/^[-*]\s*/, '')).filter((s) => s.length > 0 && s.length <= 20)
  return items.length > 0 ? items : null
}


/** style-spec 是否显式声明「本书不设练习」（契约原则：声明豁免自动跳过练习/答案检查）。 */
function styleSpecDeclaresNoExercises(projectId) {
  const path = workFile(projectId, 'style-spec.md')
  if (!existsSync(path)) return false
  const spec = readFileSync(path, 'utf8')
  return /不设练习|无练习|不设习题|无习题|不写练习|不要练习/.test(spec)
}


function runQualityChecks(projectId) {
  const meta = readMeta(projectId)
  const bookPath = workFile(projectId, 'book.md')
  const sourceCount = (meta?.sources ?? []).length
  const chapterCount = meta?.outline?.chapters?.length ?? 1
  const bookText = readFileSync(bookPath, 'utf8')
  // human 路线的 loader 指令区是给 AI 老师的装配说明（保留在成品里），扫脚手架前剥掉，避免误判残留。
  const scanText = meta?.route === 'human' ? stripLoaderRegion(bookText) : bookText
  // 票 20：通用残留与「AI 声明要拆的」**分两个来源收**（报告里也是两条，不混）。
  // 声明项在 style-spec 没显式声明时**整项不追加**（契约原则：不以硬编码词表误判）——
  // 注意「没跑」与「跑过且全绿」在 note 上必须说得出来，否则界面会拿「没查」当「查过了」。
  const declaredTitles = declaredScaffoldTitles(projectId)
  const residue = scanScaffolding(scanText)
  const declaredResidue = declaredTitles.state === 'declared' ? scanDeclaredScaffolding(scanText, declaredTitles.items) : []
  const auditNames = readdirSync(workDir(projectId)).filter((name) => /^audit-\d+\.(md|json)$/.test(name))
  const auditWaived = waived(projectId, 'audit-skip')
  const scaffoldWaived = waived(projectId, 'scaffold-keep')
  const otherWaived = waived(projectId, 'other')
  const gateWaived = waived(projectId, 'gate-skip')
  // 票 15①（票 06 的 Answer）：这里原先还有一支「三关全 approved」的实时折叠判断——它**恒假**，
  // 因为折叠只保留最后一关（foldGate(wanted=null) 只折出最后那一关的当前状态），
  // `every(gate => current === gate)` 不可能对三关同时成立。恒假支已删，只留按事件统计的这一支。
  const gatesApproved = (() => {
    // 折叠只保留最后一关，所以只能按事件统计三关是否都通过过。
    const approved = new Set()
    for (const event of readEvents(projectId)) {
      if (event.type === 'textbook/gate-decision' && event.data.approved === true) approved.add(event.data.gate)
    }
    return approved.has('1') && approved.has('2') && approved.has('3')
  })()
  // 票 15②（票 06 的 Answer 第 2 条）：成品文件齐全**真数既有产物清单**——`工作区/book.md` ＋ 每章
  // `工作区/chapter-NN.md`（清单从 meta.outline 读，不硬编码章数）。缺项即 ok:false（other 豁免仍可放行）。
  // 按**硬闸门**的强度做：runQualityChecks 的结论在终检交工处是「全过才交付」，恒真项等于这道闸门少一格。
  // 清单**绝不许含** `preface.md` / `progress.md`：演示通道不写它们，含了就是给 demo 判假（判据按
  // demo 的确定性产物清单校准，不给 demo 开豁免）。
  const requiredArtifacts = [
    { rel: '工作区/book.md', path: bookPath },
    ...(meta?.outline?.chapters ?? []).map((_chapter, index) => {
      const { chapterPath } = chapterArtifacts(projectId, index + 1)
      return { rel: chapterRel(index + 1), path: chapterPath }
    }),
  ]
  const missingArtifacts = requiredArtifacts.filter((item) => !existsSync(item.path) || readFileSync(item.path, 'utf8').trim() === '')
  const checks = [
    {
      name: '成品文件齐全',
      ok: missingArtifacts.length === 0 || otherWaived,
      note: missingArtifacts.length === 0
        ? `该有的成品文件都在（${requiredArtifacts.length} 份）`
        : (otherWaived
          ? `你已同意：以你的说明为准（缺：${missingArtifacts.slice(0, 3).map((i) => i.rel).join('、')}）`
          : `少了这些成品文件：${missingArtifacts.slice(0, 3).map((i) => i.rel).join('、')}`),
    },
    { name: '所有章节都有审计记录', ok: auditNames.length >= chapterCount || auditWaived, note: auditWaived ? '你已同意：不要求每章都有独立检查' : `${auditNames.length}/${chapterCount} 章有检查记录` },
    // 票 20：这一条现在**只管通用残留**（硬编码的 8 个标记）。AI 在写作规范里声明的那些本书特有标题
    // 由下面单独一条查——两者性质不同，混成一条会让「AI 声明要拆的」冒充通用规则。
    {
      name: '没有遗留的通用脚手架标记',
      ok: residue.length === 0 || scaffoldWaived,
      note: scaffoldWaived ? '你已同意：保留 AI 的笔记不删' : (residue.length === 0 ? '没有留下 AI 的草稿痕迹' : `发现这些标记没清掉：${residue.slice(0, 3).join('；')}`),
    },
    { name: '练习与答案齐全', ok: /练习|答案|习题/.test(bookText) || otherWaived || styleSpecDeclaresNoExercises(projectId), note: otherWaived ? '你已同意：以你的说明为准' : (styleSpecDeclaresNoExercises(projectId) ? '写作规范里说了这本书不设练习' : '成品里有练习和答案') },
    { name: '与已拍板的设计一致', ok: gatesApproved || gateWaived, note: gateWaived ? '你已同意：跳过设计拍板' : (gatesApproved ? '三次设计拍板都过了' : '还有设计拍板没过') },
    { name: '源材料引用可追溯', ok: sourceCount > 0 || otherWaived, note: otherWaived ? '你已同意：以你的说明为准' : `${sourceCount} 份源材料都用上了` },
  ]
  // 票 20：声明项**只在写作规范显式声明时才追加这一条**。状态四分：
  //   `declared`      有条目 → 真查；
  //   `declared-none` 明写「无/不需要/无额外标题」→ 追加一条**显形**的说明，**不是静默绿**
  //                    （静默绿会被读成「机器查过了、没查到」，而实际是「AI 说不用查」）；
  //   `undeclared` / `unreadable` → **整项不追加**（契约原则：不以硬编码词表误判）。
  if (declaredTitles.state === 'declared' || declaredTitles.state === 'declared-none') {
    checks.push({
      name: '没有遗留本书声明的脚手架标题',
      ok: declaredResidue.length === 0 || scaffoldWaived,
      note: scaffoldWaived
        ? '你已同意：保留 AI 的笔记不删'
        : (declaredTitles.state === 'declared-none'
          ? '写作规范里明写「本书无额外脚手架标题」，这一项按声明不追加（不是查过没查到）'
          : (declaredResidue.length === 0
            ? `本书声明的 ${declaredTitles.items.length} 个脚手架标题都没留在成品里`
            : `这些本书声明过的脚手架标题还留着：${declaredResidue.slice(0, 3).join('；')}`)),
    })
  }
  if (declaredTitles.state === 'declared' && declaredTitles.dropped > 0) {
    // 护栏 ③ 的可见面：越界的声明不能悄悄消失——AI 要看得见自己写宽了。
    checks.push({
      name: '脚手架标题声明未越界',
      ok: true,
      note: `声明里超过 ${DECLARED_TITLE_MAX} 条、或超过 ${DECLARED_TITLE_MAX_LEN} 字符的 ${declaredTitles.dropped} 条已忽略（只按剩下的 ${declaredTitles.items.length} 条查）`,
    })
  }
  // 风格线条条有着落（真实模式）：机器只验「每条 active 都有处置」，不搜关键词伪验。
  if (meta?.demo !== true) {
    const activeStyles = (meta.styleNotes ?? []).filter((n) => n.status === 'active')
    checks.push({
      name: '风格线条条有着落',
      ok: activeStyles.length === 0,
      note: activeStyles.length === 0 ? '全部风格意见已处置（或没有风格意见）' : `${activeStyles.length} 条还没交代去向`,
    })
  }
  // 进度账本（真实模式）：AI 的工作过程留账，交接/重做有参照；progress-skip 可豁免。
  if (meta?.demo !== true) {
    const progressWaived = waived(projectId, 'progress-skip')
    const progressExists = existsSync(workFile(projectId, 'progress.md'))
    checks.push({
      name: '进度账本齐全',
      ok: progressExists || progressWaived,
      note: progressWaived ? '你已同意：不检查工作记录' : (progressExists ? '工作记录在' : '缺工作记录（每章一行：写完/检查/验货）'),
    })
  }
  // 质量门并入机器（2026-08-27 用户拍板 Q3）：从 skill 文档的 grep 流程收编为机器可判定项——
  // 乱码 U+FFFD、章节数符合大纲、必含板块齐全、禁用词。判据全部从已拍板的 style-spec/outline 读，
  // 非硬编码（契约原则）；demo 确定性内容都满足，不改变 cassette 轨迹。
  if (meta?.demo !== true) {
    const spec = existsSync(workFile(projectId, 'style-spec.md')) ? readWork(projectId, 'style-spec.md') : ''
    // ① 乱码 U+FFFD（OCR 残留替换字符）。误伤逃生口：other 豁免（2026-08-27 grill 修订——
    //    契约类检查全部挂豁免，机器误判时用户不被卡死）。
    checks.push({
      name: '成品无乱码（U+FFFD）',
      ok: !bookText.includes('\uFFFD') || otherWaived,
      note: bookText.includes('\uFFFD')
        ? (otherWaived ? '你已同意：以你的说明为准（成品里有乱码字符）' : '成品里有乱码字符，需要清理')
        : '没有乱码',
    })
    // ② 章节数符合大纲（从 outline 读，非硬编码）
    const chapterHeadings = (bookText.match(/^#{1,3}\s*第\s*\d+\s*章/gm) ?? []).length
    checks.push({
      name: '章节数符合大纲',
      ok: chapterHeadings >= chapterCount,
      note: `${chapterHeadings}/${chapterCount} 章标题齐（合并时机器拼的，这里再验一遍）`,
    })
    // ③ 必含板块齐全（从 style-spec 行首「必含板块：」读清单；未声明则跳过，不以硬编码列表误判）。
    //    设计已改的合法出口：AI 同步更新 style-spec 清单行，或 other 豁免。
    const requiredBoards = parseStyleSpecList(spec, '必含板块')
    if (requiredBoards !== null) {
      const missingBoards = requiredBoards.filter((board) => !bookText.includes(board))
      checks.push({
        name: '必含板块齐全（契约项）',
        ok: missingBoards.length === 0 || otherWaived,
        note: missingBoards.length === 0
          ? `该有的板块都在（${requiredBoards.length} 个）`
          : (otherWaived
            ? `你已同意：以你的说明为准（缺：${missingBoards.slice(0, 3).join('、')}）`
            : `少了这些板块：${missingBoards.slice(0, 3).join('、')}（若设计已改，请同步更新写作规范的「必含板块」行）`),
      })
    }
    // ④ 禁用词（从 style-spec 行首「禁用词：」读；未声明则跳过）
    const bannedWords = parseStyleSpecList(spec, '禁用词')
    if (bannedWords !== null) {
      const hits = bannedWords.filter((word) => bookText.includes(word))
      checks.push({
        name: '无禁用词（契约项）',
        ok: hits.length === 0 || otherWaived,
        note: hits.length === 0
          ? '没出现写作规范里禁用的词'
          : (otherWaived
            ? `你已同意：以你的说明为准（还在：${hits.slice(0, 3).join('、')}）`
            : `这些不该用的词还在：${hits.slice(0, 3).join('、')}`),
      })
    }
  }
  // 矛盾审查（终检新增，用户拍板 2026-08-26）：引用矛盾 + 事实矛盾。
  // 引用矛盾：章节骨架标称的 source（资料N…）必须指向真实存在的源材料；指向不存在的资料 = 引用矛盾。
  if (meta?.demo !== true) {
    const chapters = meta?.outline?.chapters ?? []
    const sourceCount = (meta?.sources ?? []).length
    const badRefs = []
    for (let index = 0; index < chapters.length; index += 1) {
      const src = String(chapters[index]?.source ?? '')
      // matchAll：一章标称多份资料（「资料2、资料3」）时逐个核对，不只查第一处。
      for (const m of String(src).matchAll(/资料\s*(\d+)/g)) {
        const n = Number(m[1])
        if (n < 1 || n > sourceCount) {
          badRefs.push(`第${index + 1}章标称「${m[1]}号资料」但只有 ${sourceCount} 份源材料`)
        }
      }
    }
    checks.push({
      name: '章节引用可追溯（无引用矛盾）',
      ok: badRefs.length === 0,
      note: badRefs.length === 0 ? '每章标称的源材料都真实存在' : `发现引用矛盾：${badRefs.slice(0, 3).join('；')}`,
    })
  }
  // 事实矛盾（机器层，2026-09-30 诊断后拆成两件事——旧口径是**一条判据两头都不准**）：
  //   旧口径拿「全书所有 H1–H3 标题归一化后去重」当重复标题。实测（ADR-0008 修订 2026-09-30）：
  //     ① 每章都有的**板块名**（🚧 常见误区 / 🎬 场景引入…，书自己在 style-spec 里声明的）被判重复
  //        → 拦交付，三本真书分别 27 / 12 / 1 处，全是误伤；
  //     ② 两章**章名真写成一样**反而**放行**——机器拼的「第1章」「第2章」前缀让归一化串不相等。
  //   所以：章名唯一性单独立一条（读大纲，精确）；小节标题去重收窄成**同一章内**才拦。
  if (meta?.demo !== true) {
    // ① 章名全书唯一：直接读大纲的章名，不经正文——正文里的写法（`#`/`##`/带不带冒号）不该影响这一条。
    const seenChapterTitles = new Set()
    const dupChapterTitles = []
    for (const chapter of meta?.outline?.chapters ?? []) {
      const key = headingKey(chapter?.title ?? '')
      if (key === '') continue // 没有章名不是「两章同名」，归别处管
      if (seenChapterTitles.has(key)) {
        if (!dupChapterTitles.includes(key)) dupChapterTitles.push(key)
      } else seenChapterTitles.add(key)
    }
    checks.push({
      name: '章名全书唯一',
      ok: dupChapterTitles.length === 0 || otherWaived,
      note: dupChapterTitles.length === 0
        ? '每一章的章名在全书中都不一样'
        : (otherWaived
          ? `你已同意：以你的说明为准（重名章：${dupChapterTitles.slice(0, 3).join('、')}）`
          : `有 ${dupChapterTitles.length} 组章名在书里重复：${dupChapterTitles.slice(0, 3).join('、')}——请在拍板定方案那一关改掉重名的章名，再重新交工做最后检查`),
    })

    // ② 无重复标题 → 收窄为**同一章内**的小节标题重复。跨章同名多半是每章都有的板块名
    //    （设计使然，AI 改不掉——那是本书自己定的板位），机器分不出「板位名」与「复制粘贴的
    //    小节名」：字符串完全一样。所以跨章同名只**提示**（`warn` 第三态，不拦交付），
    //    语义归 AI 自查报告与合并前跨章审计（「机器扫结构、AI 查语义」分工不变）。
    //    同章内同名则多半是复制粘贴的产物，是真重复，拦。
    //    归一化用 `headingKey`：剥掉 emoji/符号/标点（旧的只删 8 个标点，emoji 留在串里
    //    把「🚧 常见误区」撑成 6 个字符混过下面的长度闸——那是 27 处误伤的直接成因）。
    //    标题正则的空白也从 `\s` 收紧成 `[ \t]`：`\s` 吃换行，一行裸 `##` 会把下一行正文收成标题。
    const BOILERPLATE = /小结|练习|答案|习题|本节|本章|目标|重点|方法|导入|复习|课后|思考/
    const perChapter = new Map() // 章号 → 该章已出现的小节标题键
    const acrossChapters = new Map() // 键 → 出现在几章（同章内多次只算一章）
    const dupInChapter = [] // 同章内重名：显示用（保留书里原样的标题，好让人照着改）
    const dupInChapterKeys = new Set() // 同章内重名的键：只作集合判据，不重复显示
    let chapterNo = 0
    for (const match of bookText.matchAll(/^(#{1,3})[ \t]+(.*)$/gm)) {
      const title = match[2].trim()
      if (title.length < 4) continue
      // 机器拼的章标题行（`# 第N章 …`）开启新的一章；它自己归 ① 那条判，这里只用来分章。
      if (match[1].length === 1 && CHAPTER_HEADING_RE.test(title)) {
        chapterNo += 1
        continue
      }
      const key = headingKey(title)
      if (key.length < 6 || BOILERPLATE.test(key)) continue
      const seenHere = perChapter.get(chapterNo) ?? new Set()
      if (seenHere.has(key)) {
        dupInChapterKeys.add(key)
        if (!dupInChapter.some((shown) => shown === title)) dupInChapter.push(title)
      } else {
        seenHere.add(key)
        acrossChapters.set(key, (acrossChapters.get(key) ?? 0) + 1)
      }
      perChapter.set(chapterNo, seenHere)
    }
    // 跨章同名（不含同章内已报的那些）：只提示，不拦。
    const sharedAcross = [...acrossChapters.entries()]
      .filter(([key, chapters]) => chapters > 1 && !dupInChapterKeys.has(key))
      .map(([key]) => `「${key}」`)
    const blocked = dupInChapter.length > 0
    checks.push({
      name: '无重复标题',
      ok: !blocked || otherWaived,
      warn: !blocked && sharedAcross.length > 0,
      note: blocked
        ? (otherWaived
          ? `你已同意：以你的说明为准（重复标题：${dupInChapter.slice(0, 3).map((t) => `「${t}」`).join('、')}）`
          : `发现重复标题 ${dupInChapter.slice(0, 3).map((t) => `「${t}」`).join('、')}——同一个标题在同一章里出现不止一次，请合并或改写重名的小节，改完重新交工做最后检查`)
        : (sharedAcross.length > 0
          ? `同一章里没有重名的小节；这些标题在多章里各出现一次（多半是每章都有的板块）：${sharedAcross.slice(0, 3).join('、')}——是不是内容重复，请 AI 在自查报告里说明`
          : '每一章里都没有重名的小节标题'),
    })
  }
  return checks
}


function recordAgentError(projectId, task, error) {
  // 演示模式出错是流程 bug 或环境问题（可直接重试）；真实模式的子代理失败多半是
  // LLM 未配置/欠费，标为 needs-config 并给出引导。
  updateMeta(projectId, (meta) => {
    meta.status = meta.demo === true ? 'error' : 'needs-config'
  })
  appendEvent(projectId, 'textbook/error', {
    task,
    message: String(error instanceof Error ? error.message : error),
  })
  return 'error'
}


/** 状态机主循环：每次从账本重推导，幂等，可跨重启。 */
async function runLoop(ctx, projectId) {
  for (;;) {
    const meta = readMeta(projectId)
    if (meta === null) return
    if (meta.pause !== null && meta.pause !== undefined) return
    if (meta.status === 'error' || meta.status === 'needs-config'
      || meta.status === 'awaiting-gold' || meta.status === 'awaiting-explore'
      || meta.status === 'awaiting-outline' || meta.status === 'awaiting-chapters-review'
      || meta.status === 'awaiting-final-approval'
      || meta.status === 'delivered') return
    let result
    switch (meta.phase) {
      case 1: result = await runPhase1(ctx, projectId, meta); break
      case 2: result = await runPhase2(ctx, projectId, meta); break
      case 3: result = await runPhase3(ctx, projectId, meta); break
      case 4: result = await runPhase4(ctx, projectId, meta); break
      case 5: result = await runPhase5(ctx, projectId, meta); break
      case 6: result = await runPhase6(ctx, projectId, meta); break
      default: return
    }
    if (result === 'delivered' || result === 'waiting' || result === 'error' || result === 'running') return
    // 'advanced' / 'decided' / 'approved' → 继续循环
  }
}


function kick(ctx, projectId) {
  const promise = runLoop(ctx, projectId)
    .catch((error) => {
      ctx.logger.warn(`textbook: 状态机 ${projectId} 异常: ${String(error)}`)
      if (readMeta(projectId) !== null) {
        updateMeta(projectId, (meta) => { meta.status = 'error' })
        try {
          appendEvent(projectId, 'textbook/error', { task: '状态机', message: String(error instanceof Error ? error.message : error) })
        } catch { /* 账本也可能坏了 */ }
      }
    })
    .finally(() => {
      runners.delete(projectId)
      void disposeParent(projectId)
    })
  runners.set(projectId, promise)
  return promise
}


/**
 * 注入面（票 02 两层合并）：**注入什么由 `disclose` 决定 ＋ 一页纸常驻 ＋ 状态迁移→节注入表 ＋ 指针兜底**。
 *
 * ① `disclose`（产物清单那一列，**唯一判据** · ADR-0031「给下游票的接口清单 → 票 02」）：
 *    注入件集合＝`manifestRowsFor(shape)` 里 `disclose !== 'never'` 的切片，
 *    **每份一行登记（一句话 ＋ 路径）**。`pointer` 给一行 ＋ 精确路径；`inline` 的正文常驻
 *    （今天**只有工具纪律 §九 那一页纸**）；`never` 一个字都不给（今天＝模式卡那一族）。
 *    ⚠️ 「什么时候给」**不在 `disclose` 里**（`CONTEXT.md`「disclose」词条明写）——那是下面那张表。
 * ② `METHODOLOGY_ONEPAGE` —— 每份共用文档一行「管什么＋何时需要」（那一行**就是**登记行本身）。
 * ③ `STAGE_STATE_INJECTIONS` —— **触发取状态迁移、不取阶段**：键取 `stageStateOf()` 的 `reason`
 *    （`artifact`／`stale`／`review`／`submit`／`null`＝全齐），取值域**就是那四档**，
 *    `reason → 四档` 的映射由 `domain-rules.STAGE_STATE_BY_REASON` 单点持有（**本层不重述四档**）。
 *    另有三条**仓库事件**行（用户驳回／暂停且还有小助手在跑／进入审计动作）——它们不是状态迁移，
 *    但同样是仓库可读的事实，与本文件既有的 `deepRedo`／`userFeedback`／`occupancyLine` 同构。
 * ④ 指针兜底 —— 精确路径＋节号（沿用旧 `clipMethodology` 第三参那种形态），
 *    事件没接住时 AI 自救；节号从源文自己的 `##` 标题派生，台账不会与正文漂移。
 *
 * Q3 退役记账：这里原先是 `clipMethodology`（cap 9000）＋ `METHODOLOGY_TAIL_BY_STAGE` ＋
 * `withTailSections` 一整套。**当初为什么定**（票 subagent-guidance/09）：`audit-and-testing.md`
 * 有四节整节落在 cap 之外，而「省上下文」这条约束已被 9000 证明有效；指针曾掩盖交付缺失，
 * 所以不敢只留指针。**现在为什么改**（grilling Q7'(c)）：指针的病在**触发**不在**存在**——
 * 「需要时」的判定粒度停在「哪个阶段」，同一份 9000 字头重复进 gold/chapters/final 三份 brief。
 * 事件表把触发变成接线，AI 不必自觉判断；省上下文这条约束本身不变，机制细化。
 *
 * ⚠️ 本层只负责「交出去的在不在」；主笔**读没读**注入节、时机赶没赶上动作，归真机层（票 07）。
 */
const AUDIT_DOC = 'references/audit-and-testing.md'
/**
 * 章级审计的**派发模板**（rel，不含 `resources/` 前缀）——写完整本那一跳要交给审计小助手填的那一份。
 * 票 `chapter-audit-orchestration/03`：这一跳改由编排脚本驱动之后，派发正文仍按这份模板填，
 * 所以脚本那一跳的指路与交办说明里的指路**同出一源**（同一枚常量，不手抄第二个字面量）。
 */
const AUDIT_TEMPLATE_REL = 'references/subagent-prompts/audit-agent-prompt.md'
/**
 * 编排脚本骨架（rel）——铺章那一跳的审计改由宿主 `workflow` 工具驱动，主笔照这一份填脚本。
 * 它是**给主笔读的形状出处**，不是给成员读的派发模板（成员由脚本派、拿不到方法论挂载面）。
 */
const CHAPTER_AUDIT_SCRIPT_REL = 'references/workflow-scripts/chapter-audit.md'
/** 形状契约那份（四份设计产物的字段契约与铁律）——「产物不在 → 给形状」与「全齐 → 给下一阶段的形状」都指它。 */
const SHAPE_DOC = 'references/file-contracts.md'

/** 一页纸常驻：一行 = 一份共用方法论文档（`管什么` ＋ `何时需要`）。键 = 挂载面那份 rel。 */
export const METHODOLOGY_ONEPAGE = {
  'SKILL.md': {
    what: '全流程导航 ＋ 两条 Iron Law（设计先行／先写金标准再并行铺章）',
    when: '不确定这一步该干什么、或要卡 Iron Law 判据时',
  },
  'references/source-material.md': {
    what: '源材料通读法 ＋ 源角色标签（哪一份当权威源）',
    when: '判断某份材料能不能当真相源、要抽结构或定知识点时',
  },
  'references/patterns/README.md': {
    what: '21 张教学板块模式卡（卡本身判 never、不进上下文，经这一行按教学问题翻）',
    when: '关卡②选教学模式、给每章设计板块结构时',
  },
  'references/file-contracts.md': {
    what: '四份设计产物的字段契约与铁律',
    when: '写 工作区/style-spec.md 等四件设计产物、或交工前自查格式时',
  },
  [AUDIT_DOC]: {
    what: '审校与教学测试细则（§九 工具纪律全文常驻）',
    when: '派小助手、派审计小助手、暂停、收到驳回意见时',
  },
  'references/delivery-checklist.md': {
    what: '交付前 6 项质量门',
    when: '最后检查与交付前逐条过',
  },
  'references/subagent-prompts/writing-agent-prompt.md': {
    what: '写作小助手派发模板',
    when: '派写作小助手时按模板填',
  },
  [AUDIT_TEMPLATE_REL]: {
    what: '章级审计小助手派发模板',
    when: '派章级审计小助手时按模板填',
  },
  'references/subagent-prompts/cross-audit-prompt.md': {
    what: '跨章审计小助手派发模板（四项判定词只住那一份）',
    when: '合并前派跨章审计小助手时按模板填',
  },
  [CHAPTER_AUDIT_SCRIPT_REL]: {
    what: '编排脚本骨架：一次运行只审一章',
    when: '审计那一跳要调 workflow 时',
  },
  'references/subagent-prompts/gold-audit-prompt.md': {
    what: '金标准章审计模板（必读矩阵＋一致性核对）',
    when: '派范例章审计小助手时按模板填',
  },
  'references/invariants.md': {
    what: '不变量底线 I/H 编号（按路线选节，见上面那段）',
    when: '拿不准某条底线适用哪条路线时',
  },
}

/**
 * 票 subagent-guidance/09：从方法论文档里切出指定的 `##` 级小节。
 *
 * 一节 = 从它的 `## ` 行到**下一个同级或更高级标题**为止（`###` 归它所有）。
 * 找不到标题就返回空串——**缺一节不该炸掉整个交办说明**，上层会断言它。
 *
 * @param {string} text 方法论全文
 * @param {string[]} headings 要切出的 `## ` 标题逐字前缀（如 `'## 十一、'`）
 * @returns {string} 按 headings 顺序拼接的小节正文
 */
export function pickSections(text, headings) {
  const clean = String(text ?? '')
  const starts = []
  for (const match of clean.matchAll(/^## .+$/gm)) starts.push({ at: match.index, title: match[0] })
  const picked = []
  for (const heading of headings) {
    const from = starts.findIndex((s) => s.title.startsWith(heading))
    if (from < 0) continue
    const at = starts[from].at
    const end = from + 1 < starts.length ? starts[from + 1].at : clean.length
    picked.push(clean.slice(at, end).trim())
  }
  return picked.join('\n\n')
}

// ── 这一步的产物行（阶段 → 它该产出的那几件）───────────────────────────────────
//
// 它有两个消费者，**只有这一份**：
//   ① `stepStageState()` —— 环节状态的四项事实从这些产物行在盘上的实况取（ADR-0031 决策 4
//      「粒度挂在产物行上，环节状态是它上面的聚合」）；
//   ② `dispatchRegistryFor()` —— 派发面「该产出的登记行」按这张表与清单的 `producer` 列对出来。
// `chapters` 是 `per-chapter`：它一次写 N 章，没有单文件（形状先例＝`artifactDataForStage` 的注释）。
const PER_CHAPTER = 'per-chapter'
/**
 * 章正文的**清单行路径**（`工作区/chapter-{n}.md`）——从 `domain-rules` 的族声明**派生**，
 * 不在这里手抄一遍（手抄的路径改名时会静默失配）。
 */
const CHAPTER_ROW_PATH = BOOK_PRODUCT_FAMILIES.find((family) => family.family === '章节正文').path
/**
 * 章正文**分片**的清单行路径（`工作区/分片/*`）——票 `walkthrough-2026-10/02` 之后**小助手产出的
 * 就是这一族**（章正文那一族改成 `machine` 产出：机器按分片拼）。同款：从族声明派生，不手抄。
 */
const CHAPTER_SHARD_ROW_PATH = BOOK_PRODUCT_FAMILIES.find((family) => family.family === '章节正文分片').path
const STEP_OUTPUT_ROWS = {
  explore: ['工作区/explore.md', '工作区/knowledge-map.json'],
  // 关卡的「产物」是用户拍板的裁决，不是 AI 写出来的文件——所以这一步没有产物行，
  // 状态恒为「产物不在」，注入的正是形状契约那一节（缺件时最该给的就是形状）。
  gate: [],
  outline: ['工作区/outline.md'],
  gold: [CHAPTER_ROW_PATH],
  chapters: PER_CHAPTER,
  // 合并的产物是机器拼装的成品书 + AI 前言；跨章审计报告是**检查记录**（`machine` 件，不进清单）。
  merge: ['工作区/book.md', '工作区/preface.md'],
  final: ['工作区/book.md'],
}

/**
 * 这一步**派出的小助手**要产出的登记行（派发面「该产出的」那一半）。
 * ⚠️ 它与 `STEP_OUTPUT_ROWS` **不是同一张表的两个意思**：那一张是「这一步整体该有的产物」
 * （环节状态的事实来源），这一张是「派出去的那几路该落哪几件」。
 * `merge` 那格是空的——跨章审计报告与章审计报告都是**检查记录**（`productOpenMode` 判 `'machine'`，
 * 按 ADR-0031 决策 3 不进产物清单），所以「该产出的」在清单里真的没有它们；这不是漏，是判出来的事实。
 */
const STEP_SUB_OUTPUT_ROWS = {
  // ⚠️ 票 `premature-announce/02` 修了两处**声明面的错**（此前它们被 `dispatchRegistryFor` 的 `pick`
  // **静默过滤**掉，一声不响）：
  //   ① `工作区/reading-{n}.md` —— 早已随票 11 并进 `工作区/细目/*`（退役注记在
  //      `domain-rules.js` 的「细目」族那一行），留在这里就是一条**死条目**；
  //   ② `工作区/knowledge-map-{n}.md` —— 扩展名写错了，分片是 `.json`（族声明
  //      `domain-rules.js` 的「知识地图分片」那一行是同一份契约）。
  // ⇒ 现在这一行与产物清单**逐字对得上**，「该产出的」里终于有那一片分片。
  // 读数与判据见 `declaredStageRowsMissingFromManifest()`（静默过滤变成可断言的读数）。
  explore: ['工作区/细目/*', '工作区/knowledge-map-{n}.json'],
  gate: [],
  outline: [],
  // ⚠️ 票 `walkthrough-2026-10/02`：执笔小助手产出的是**分片**（章正文由机器拼，那一族改成
  // `machine` 产出）——这两格因此指向分片族。判据（`test-tool-discipline.mjs`）按清单的
  // `producer` 列与这张表对账，指错了当场红。
  gold: [CHAPTER_SHARD_ROW_PATH],
  chapters: [CHAPTER_SHARD_ROW_PATH],
  merge: [],
  final: ['工作区/报告/*'],
}

/**
 * 这一步的**输入**产物行（派发面「该读的登记行」里那些书内产物）。
 * 共用文档那一半（`scope === 'reference'` 的规范行）由挂载面直接给，不在这张表里。
 */
const STEP_INPUT_ROWS = {
  explore: [],
  gate: [],
  outline: ['工作区/knowledge-map.json', '工作区/explore.md'],
  gold: ['工作区/outline.md'],
  chapters: ['工作区/style-spec.md', '工作区/outline.md'],
  merge: [chapterRel],
  final: ['工作区/book.md'],
}

/**
 * 「产物不在 → 给形状」时，`file-contracts.md` 的**哪一节**对应这一步（票面 8 行表第 1 行）。
 * 逐档带理由：`file-contracts.md` 的四节正好对应四类设计产物，「这一步的形状」与
 * 「下一阶段的形状」走同一张表（判据 `test-tool-discipline.mjs` 断它是**闭的**：每个阶段都有一格）。
 */
const SHAPE_HEADING_BY_STAGE = {
  explore: '## 源材料索引与源定位（有源场景）',   // 这一步产出的两件都是源材料索引
  gate: '## 章节骨架（大纲与架构）',            // 关卡③要定的正是骨架与体量
  outline: '## 章节骨架（大纲与架构）',
  gold: '## 写作规范 · 契约与铁律',
  chapters: '## 风格与语法',                    // 铺章逐章落实的是风格线那一份
  merge: '## 写作规范 · 契约与铁律',             // 成书与前言仍受铁律约束
  final: '## 写作规范 · 契约与铁律',
}

/** 阶段的推进次序（供「全齐 → 下一阶段的形状」用；末一个没有下一站，原地不动）。 */
const NEXT_STAGE = { explore: 'outline', gate: 'outline', outline: 'gold', gold: 'chapters', chapters: 'merge', merge: 'final', final: 'final' }

/**
 * 票 02 第 1 层：**注入什么由 `disclose` 决定**（ADR-0031 给票 02 的接口清单）。
 *
 * 一份共用文档在交办说明里能以什么形态出现，**只由产物清单那一列决定**，本函数是那一份的读法：
 * · `never`   → 返回 `null`，**不许挂**（一个字都不给，连指针都没有）。
 * · `pointer` → 那一行 ＋ 精确路径（正文自己回读）。
 * · `inline`  → 那一页正文常驻（今天只有工具纪律 §九）。
 * 清单里查不到的行**同样判 never**：挂载面宁可少给，也不许自己另定一套规矩——
 * 「代码里另有一份名单」正是票 02 第 1 层要消灭的那个病（`CONTEXT.md`「disclose」词条的 Avoid 行）。
 *
 * @param {string} rel 挂载面用的 rel（`references/…` 或 `SKILL.md`）
 * @returns {string|null} `disclose` 三档之一；不可注入时为 `null`
 */
export function discloseOf(rel) {
  const row = SPEC_ROW_BY_PATH[rel] ?? SPEC_ROW_BY_PATH[`resources/${rel}`] ?? null
  const disclose = row?.disclose ?? null
  return DISCLOSE_MODES.includes(disclose) ? disclose : null
}

/**
 * 这一步该给 AI 的几行登记——**注入件集合＝清单里 `disclose` 命中的切片**（用户故事 13／19）。
 * 每一行 = 一句话（那一页纸行）＋ 路径（`resources/…`）＋ 它自己在清单里的那一档 `disclose`。
 *
 * @param {string[]} rels 这一步挂载面交出去的每份共用文档的 rel
 * @returns {{path: string, rel: string, role: string, disclose: string}[]}
 */
function registryRowsFor(rels) {
  const rows = []
  for (const rel of rels) {
    const disclose = discloseOf(rel)
    if (disclose === null) continue
    const row = SPEC_ROW_BY_PATH[rel] ?? SPEC_ROW_BY_PATH[`resources/${rel}`]
    rows.push({ path: `resources/${rel}`, rel, role: row.role, disclose })
  }
  return rows
}

/**
 * 派发面也走**同一张表**（票 02 实现决策 11 · ADR-0031 接口清单第四行）：
 * 给「你该读的登记行 ＋ 你该产出的登记行」，**不再靠派发措辞**。
 *
 * 病根（实测）：explore 交办原文写「要求详细摘录」，于是三份精读报告 22,106／39,321／52,770
 * 字符全文回灌，而另一本书**同一机制**三个精读全落盘——同一个机制、两本书两种表现，全凭自觉。
 * 派发面拿到的两组清单**全部来自产物清单**（共用文档那一半＝本页挂载面；书内产物那一半＝上面两张表），
 * 所以「该读什么／该产出什么」不再由主笔的措辞决定。
 *
 * @param {string} stage
 * @param {object} meta
 * @param {string[]} mountedRels 这一步挂载面交出去的共用文档（它们就是「该读的」共用那一半）
 */
function dispatchRegistryFor(stage, meta, mountedRels) {
  const live = new Map(manifestRowsFor({ hasSources: okMaterialShards(meta.sources).length > 0 })
    .filter((row) => row.disclose !== 'never')
    .map((row) => [row.path, row]))
  const pick = (paths, producer) => [...new Set(paths)]
    .map((p) => live.get(p))
    .filter((row) => row !== undefined && (producer === null || row.producer === producer))
    .map((row) => ({ path: row.path, role: row.role, disclose: row.disclose }))
  return {
    read: [...pick(STEP_INPUT_ROWS[stage] ?? [], null), ...registryRowsFor(mountedRels)],
    produce: pick([...(STEP_OUTPUT_ROWS[stage] === PER_CHAPTER ? [CHAPTER_ROW_PATH] : STEP_OUTPUT_ROWS[stage] ?? []), ...(STEP_SUB_OUTPUT_ROWS[stage] ?? [])], 'subagent'),
  }
}

/**
 * **声明面自检**（票 `premature-announce/02`）：上面两张派发表里**落不到产物清单**的条目 ＋ 扫到的条数。
 *
 * 病：`dispatchRegistryFor` 的 `pick` 对认不出的路径**静默过滤**（`.filter((row) => row !== undefined)`），
 * 于是声明面里躺着退役的、或名字写错的条目也一声不响——实测两处（见 `STEP_SUB_OUTPUT_ROWS` 的注记：
 * `工作区/reading-{n}.md` 已随票 11 退役、`工作区/knowledge-map-{n}.md` 扩展名写错）。
 * ⇒ 本函数把「静默」变成**读数**：判据断 `missing` 为空、`checked` 有下限（防空跑）。
 *
 * ⚠️ **我的枚举面比现实窄在哪里**：它只对账**声明面 ↔ 产物清单**（两张表 ↔ 由
 * `BOOK_PRODUCT_FAMILIES` 派生的清单行，`hasSources` 两种形状都试，任一对得上就算活）；
 * **不判**「清单本身是不是交工验货要的那几件」——那一层是另一件事（A/B 与交工验货 C 的粒度差，
 * 例如检查记录成对挂在那份正文上，不由这里列）。
 *
 * @returns {{missing: string[], checked: number}}
 */
export function declaredStageRowsMissingFromManifest() {
  const liveByVariant = [false, true].map((hasSources) => new Set(manifestRowsFor({ hasSources }).map((row) => row.path)))
  const missing = []
  let checked = 0
  for (const [stage, rows] of Object.entries(STEP_OUTPUT_ROWS)) {
    const list = rows === PER_CHAPTER ? [CHAPTER_ROW_PATH] : rows ?? []
    for (const path of [...new Set([...list, ...(STEP_SUB_OUTPUT_ROWS[stage] ?? [])])]) {
      checked += 1
      if (!liveByVariant.some((live) => live.has(path))) missing.push(`${stage}: ${path}`)
    }
  }
  return { missing, checked }
}

/**
 * 票 02 第 1 层 + 第 2 层：**状态迁移 → 节注入表**（票面那张 8 行表，逐行落成数据）。
 *
 * ⚠️ **键取 `stageStateOf()` 的 `reason`，不取阶段名，也不另立一份事件清单**：
 * `reason` 的取值域就是既有四档判据那四个词（`artifact`／`stale`／`review`／`submit`），
 * `null` 是「全齐」（= `ready`）。`reason → 四档` 的映射由 `domain-rules.STAGE_STATE_BY_REASON`
 * 单点持有——**本表不重述四档**（重述就是「两个数字打架」的原材料）。
 * 三条 `event` 行（用户驳回／暂停且还有小助手在跑／进入审计动作）不是状态迁移，
 * 是同样可读的仓库事件，判定口径与本文件既有的 `deepRedo`／`userFeedback`／`occupancyLine` 同一形状：
 * 读得到事实才成立，读不到就不成立（宁可少给，不编）。
 *
 * 逐行理由（哪一行为什么是这一节）：
 * · `产物不在`   → 该产物的**形状契约**（`file-contracts.md` 对应节）：缺件时最该给的是形状。
 * · `旧审计过期` → §十（那里面写死了「第三轮：修订复审」＝改稿之后必须重审）＋「须重新审计」口径。
 * · `抽查意见未清零` → §十一；「交工前三查」的落点是 §11.5「pending 不得交工」＋人设第 15 条，
 *   **不另写一份**。
 * · `机器交工未过` → `delivery-checklist.md` 的分工那一节（交工那一档的质量门住在交付清单里）。
 * · `用户驳回` → §十一（重做优先唤醒原来那个小助手，不另派）＋风格线处置那段。
 * · `暂停且还有小助手在跑` → §十二（§十二 自己的触发就只有「暂停」这一个，判据是那个数）。
 * · `进入审计动作` → §十 ＋ 审计派发模板（今天已有，保留；按仓库事实选一份，不两份都塞）。
 * · `全齐` → 下一阶段的**形状**（只给形状，不给方法论）。
 */
export const STAGE_STATE_INJECTIONS = [
  {
    id: '产物不在',
    why: '这一步该有的产物还不在盘上（artifact）——缺件时最该给的是它的形状契约',
    reason: 'artifact',
    inject: (meta) => [{ rel: SHAPE_DOC, headings: [SHAPE_HEADING_BY_STAGE[meta.pendingStage] ?? SHAPE_HEADING_BY_STAGE.outline] }],
  },
  {
    id: '旧审计过期',
    why: '产物被改过 ⇒ 旧审计过期（stale）：审的是旧稿的那份不算数，须重新审计',
    reason: 'stale',
    inject: () => [{ rel: AUDIT_DOC, headings: ['## 十、'] }],
  },
  {
    id: '抽查意见未清零',
    why: '产物与审计对得上但人工确认没到位（review）——§11.5「pending 不得交工」就是三查那一半',
    reason: 'review',
    inject: () => [{ rel: AUDIT_DOC, headings: ['## 十一、'] }],
  },
  {
    id: '机器交工未过',
    why: '没有机器记下的交工（submit）——交工那一档的质量门住在交付清单里',
    reason: 'submit',
    inject: () => [{ rel: 'references/delivery-checklist.md', headings: ['## Phase 6 的三步分工'] }],
  },
  {
    id: '用户驳回',
    why: '关卡方案被用户驳回或终检 approved=false——重做优先唤醒原来那个小助手，不另派',
    event: '用户驳回',
    inject: () => [{ rel: AUDIT_DOC, headings: ['## 十一、'] }],
  },
  {
    id: '暂停且还有小助手在跑',
    why: '用户点过暂停且 pause.subagentsRunning > 0——§十二 自己的触发就只有这一个',
    event: '暂停且还有小助手在跑',
    inject: () => [{ rel: AUDIT_DOC, headings: ['## 十二、'] }],
  },
  {
    id: '进入审计动作',
    why: '本阶段进入审计动作（派审计小助手／产出审计结论）——§十 自己写死了三轮归属',
    event: '进入审计动作',
    inject: () => [
      { rel: AUDIT_DOC, headings: ['## 十、'] },
      // 审计派发模板跟着「进入审计」这一条走，且**按仓库事实选一份**（票 02 落地记录的原话：
      // 「按仓库事实选一份，不两份都塞」）。⚠️ 那一刀在票 05 落进这张表之后**没有回头改**，
      // 于是 merge / final 也拿到了**章级**那份——它教的是落 `工作区/audit-<NN>.md` 严格 JSON、
      // ≤2K token，而 merge 真要派的 `cross-audit-prompt.md` 落 `工作区/audit-cross.md`、final 真要派的
      // 是 §10.b 的五份分查形状（**各自落 `工作区/报告/`**）：**同一份 brief 里并存两套互相打架的派发口径**。
      // 口径（与 `test-tool-discipline.mjs` 的 `AUDIT_DISPATCH_BY_STAGE` 同一份形状，逐档对账）：
      //   gold     → 金标准章审计那份（审「范例章兑现了设计没有」）
      //   chapters → 章级审计那份（审「这一章写对没有」）
      //   merge    → 跨章审计那份（审「这本书拼起来对不对」，落盘点是 audit-cross）
      //   final    → **不带任何章级模板**：它派的是 §10.b 那五份分查，那一节的形状由 §十 自己承载。
      { rel: 'references/subagent-prompts/cross-audit-prompt.md', full: true, when: (meta) => meta.pendingStage === 'merge' },
      { rel: AUDIT_TEMPLATE_REL, full: true, when: (meta) => meta.pendingStage === 'chapters' },
      { rel: 'references/subagent-prompts/gold-audit-prompt.md', full: true, when: (meta) => meta.pendingStage === 'gold' },
    ],
  },
  {
    id: '全齐可推进',
    why: '产物／审计／人工确认都到位（reason 为 null，即全齐）——只给下一阶段的形状，不给方法论',
    reason: null,
    inject: (meta) => {
      const next = NEXT_STAGE[meta.pendingStage] ?? meta.pendingStage
      return [{ rel: SHAPE_DOC, headings: [SHAPE_HEADING_BY_STAGE[next] ?? SHAPE_HEADING_BY_STAGE.outline] }]
    },
  },
]

/** 本轮有没有用户意见/风格线变化在案（抽查意见／用户留言／金标准意见——都读 meta，不读措辞）。 */
function userFeedbackInFlight(meta) {
  const count = (list, keep) => (Array.isArray(list) ? list.filter(keep).length : 0)
  return count(meta.pendingReviews, (r) => r.status !== 'revoked')
    + count(meta.pendingInterventions, (i) => i.status === 'pending')
    + count(meta.goldOpinions, (o) => o.status === 'pending' || o.status === 'sent')
}

/** 本轮是不是「用户驳回触发的重做」（关卡方案被驳回，或终检给了改进意见）。 */
function gateRejectedInFlight(meta, facts) {
  if (facts?.gateRejected === true) return true
  return typeof meta.finalRedoNote === 'string' && meta.finalRedoNote.trim() !== ''
}

/** 「进入审计动作」：本阶段会派审计小助手或产出审计结论（**选哪一份模板是另一件事**，在 inject 里分档）。 */
const AUDIT_ACTION_STAGES = new Set(['gold', 'chapters', 'merge', 'final'])
/** 会派小助手的阶段——派发面那一半（两组登记行）只对这几个阶段有意义。 */
const SUBAGENT_DISPATCH_STAGES = new Set(['explore', 'gold', 'chapters', 'merge', 'final'])

/**
 * 本轮触发了哪几行（`{state, reason}` ＋ meta ＋ 已知事实 → 触发行 id 集合）。
 * 状态行按 `reason` 精确匹配（**不按阶段名匹配**），事件行读仓库可读的事实。
 */
function firedInjectionIds(state, meta, facts) {
  const events = {
    用户驳回: gateRejectedInFlight(meta, facts),
    暂停且还有小助手在跑: meta.pause != null && (meta.pause.subagentsRunning ?? 0) > 0,
    进入审计动作: AUDIT_ACTION_STAGES.has(meta.pendingStage),
  }
  const fired = new Set()
  for (const row of STAGE_STATE_INJECTIONS) {
    if (row.event !== undefined) {
      if (events[row.event] === true) fired.add(row.id)
      continue
    }
    if (state.reason === row.reason) fired.add(row.id)
  }
  return fired
}

/**
 * 单个产物行的四项事实 → 四档状态（走的是 `stageStateOf` 那**一个**函数，本层不判档）。
 *
 * ⚠️ **「交工」那一项由调用方喂进来，本层不许自己算第二份**：`stepStageState` 那一层已经在算
 * `stepSubmitRecorded`，在这里重算就是本程要消灭的「两个数字打架」。它曾被**写死**成 `false`，
 * 而 `stageStateOf` 在 `submitRecorded !== true` 时**必返 reason** ⇒ 调用方的循环**必在首轮 return**
 * ⇒ 末尾那行聚合**不可达** ⇒ 非 `PER_CHAPTER` 工序（explore／outline／gold／merge／final）的
 * **`ready` 档结构性不可达**（ADR-0031 决策 4 补记 · 票 `15`）。
 *
 * ⚠️ **配对检查件经 `domain-rules.pairedAuditRels` 取，不在这里按文件名猜**：那一份是
 * 「这一行**结构上**有没有配对检查件」的单一出处，**空数组＝没有**（`stale` 档对那几族不适用）。
 * 它曾在这里就地做「产物文件名 → 检查件名」的字符串变换（`chapter-NN.md` → `audit-NN.md`），
 * 对不带章号前缀的行那次变换**原样返回** ⇒ 拿**自己**当自己的检查件 ⇒ 自比较恒真 ⇒ `stale` 恒不可达。
 *
 * @param {string} stage 分段机器键（配对检查件那张表按它分档）
 * @param {string} productRel 产物行的书夹相对形状（规范形状）
 * @param {boolean} reviewPending 本轮有没有未处置的意见
 * @param {boolean} submitRecorded 账本里有没有这一步的机器交工证据（**调用方算好的那一枚**）
 */
function stepRowState(projectId, stage, productRel, reviewPending, submitRecorded) {
  const productPath = workFile(projectId, basename(productRel))
  const auditRels = pairedAuditRels(stage, productRel)
  return stageStateOf({
    artifactPresent: existsSync(productPath),
    // ⚠️ **三档判法，缺的那一档不许蒙过去**：
    //   · 配对清单为空 ⇒ 结构上就没有配对检查件 ⇒ 这一项**不适用**，不判旧；
    //   · 配对清单非空而**缺一份** ⇒ 判不成立（把「还没审」与「审的是旧稿」并成一档 `stale`，
    //     因为注入面那一行给的口径就是「须重新审计」——那正是缺一份时该说的话）；
    //   · 齐了且没有一份比产物旧 ⇒ 审的就是当前这份。
    //   「读不出」当成「有问题」会让正常的一步凭空被拦，但**更坏**的是反过来：
    //   拿自己当自己的检查件，于是 `stale` 那一档永远绿灯。
    auditFresh: auditRels.length === 0 || auditRels.every((rel) => {
      const auditPath = bookRelOnDisk(projectId, rel)
      return existsSync(auditPath) && !chapterAuditOlderThanChapter(productPath, auditPath)
    }),
    reviewPending,
    submitRecorded,
  })
}

/** 账本里有没有「这一步交工通过」的机器证据（只认已存在的写入点，不按文件存在兜底——同 `chapterHasSubmitEvent` 的纪律）。 */
function stepSubmitRecorded(projectId, meta) {  const stage = meta.pendingStage ?? null
  if (stage === null) return false
  if (readEvents(projectId).some((event) => event.type === 'textbook/agent-end'
    && event.data?.outcome === 'ok' && event.data?.stage === stage)) return true
  if (stage === 'chapters') {
    const chapters = meta.outline?.chapters ?? []
    return chapters.length > 0 && chapters.every((_chapter, index) => chapterHasSubmitEvent(projectId, index + 1, meta))
  }
  return false
}

/**
 * 账本里有没有「**合并**这一步交工通过」的机器证据（票 `walkthrough-2026-10/10` 裁决 A）。
 *
 * **以当前账本为准**：回退（快照）会把 `timeline.jsonl` 换回快照那一刻（ADR-0016 决策 3），
 * 而**回退不删产物文件** ⇒「盘上有 `book.md`」不等于「机器合并过」。跳步闸门（`runPhase5`）
 * 读的就是这一枚：没有它就不许跳过合并。
 *
 * ⚠️ **判据取 label 前缀，不取 `data.stage`**：`agent-end` **不带 `stage`**（只有 `stage-start`
 * 带，见 `handoff()`），按 `data.stage` 认是**结构性不命中**。前缀取自 `stageLabel('merge')`
 * 这一份现成的机器身份词，**不另写一个 label 字面量**——写入点（`actions/chapters.js` 的
 * `stage-submit merge`）那条 label 正是以「合并成书」开头。同款先例：`chapterHasSubmitEvent`
 * 按 label 里的章号认章级交工、`goldVersions` 按 label 认范例章。
 */
function mergeSubmitRecorded(projectId) {
  const prefix = stageLabel('merge')
  return readEvents(projectId).some((event) => event.type === 'textbook/agent-end'
    && event.data?.outcome === 'ok'
    && String(event.data?.label ?? '').startsWith(prefix))
}

/**
 * 这一步的**环节状态**——`stageStateOf` 的**调用方**，不是第二份判据（ADR-0031 决策 4 第一条纪律）。
 *
 * 四项事实从 `STEP_OUTPUT_ROWS` 指的产物行在盘上的实况取；章一级逐章那一档**直接复用既有的
 * `chapterStageState`**（它自己已经调 `stageStateOf`），本函数不重写任何一条判据。
 *
 * **聚合口径**：一步有多个产物行时，取**顺序里第一个没齐的**那一行的状态；全齐才报 `ready`
 * （「第一个没齐的」是阅读顺序，不是另立一份严重度排序——那样就成了第二份判据）。
 *
 * @param {string} projectId
 * @param {object} [meta]
 * @returns {{state: string, reason: string|null}}
 */
export function stepStageState(projectId, meta = null) {
  const current = meta ?? readMeta(projectId) ?? {}
  const reviewPending = userFeedbackInFlight(current) > 0
  const outputs = STEP_OUTPUT_ROWS[current.pendingStage] ?? []
  const submitRecorded = stepSubmitRecorded(projectId, current)
  if (outputs === PER_CHAPTER) {
    const chapters = current.outline?.chapters ?? []
    for (let index = 0; index < chapters.length; index += 1) {
      const state = chapterStageState(projectId, index + 1, current)
      if (state.reason !== null) return state
    }
    return stageStateOf({ artifactPresent: chapters.length > 0, auditFresh: true, reviewPending, submitRecorded })
  }
  for (const rel of outputs) {
    const state = stepRowState(projectId, current.pendingStage, rel === CHAPTER_ROW_PATH ? chapterRel(goldN(current)) : rel, reviewPending, submitRecorded)
    if (state.reason !== null) return state
  }
  return stageStateOf({ artifactPresent: outputs.length > 0, auditFresh: true, reviewPending, submitRecorded })
}


/** 三层挂载的块首（与判据里那几个哨兵同形——判据按**内容**定位，不按行号）。 */
const ONEPAGER_HEAD = '↓ 方法论一页纸（本 brief 挂的每份共用文档：管什么 ＋ 何时需要）'
const RESIDENT_HEAD = '↓ 常驻全文块（普适短规则，不按事件增减）'
const EVENT_HEAD = '↓ 状态迁移注入节（本轮命中的状态迁移 → 对应小节）'
const POINTER_HEAD = '↓ 指针兜底（上面没给的，按精确路径＋节号自己回读）'
/**
 * 方法论**根目录**那一行——本机绝对路径，运行时从 `content-lib.RESOURCES_DIR` 算，**不写死**
 * （写死＝`.scratch/dsh-contract-drift/issues/03` 那个病：代码里出现某台机器的路径）。
 *
 * 为什么必须有（票 `.scratch/methodology-root-pointer/01`）：下面每一条指针都是 `resources/…`
 * 形态的**包内相对路径**，而宿主把相对路径按**会话 cwd** 解析（`dsh-tool-fs` 的 `sessionResolveOptions`）。
 * 开发机上会话工作区恰好就是仓根、仓根又躺着几本书，所以 `resources/…` 凑巧命中、看不出病；
 * 换台机器（工作区 ≠ 插件包）就一条都读不到，只剩搜盘一条路。
 *
 * ⚠️ 它是**指针面**的一部分，不是新增的正文面——ADR-0030 决策 3（一页纸 ＋ 状态迁移→节 ＋ 指针兜底）
 * 那条取舍一个字没动：本票只补「发给 AI 的路径缺一个解析基准」。
 */
const RESOURCE_ROOT_LINE = `   - 方法论根目录（本机绝对路径，下面每条 resources/… 都相对它）：${RESOURCES_DIR}`

/** 一页纸的一行：路径＋管什么＋何时需要。没登记的文档明说「未登记」（由判据盯住不许出现）。 */
function onepagerLine(rel) {
  const entry = METHODOLOGY_ONEPAGE[rel]
  if (entry === undefined) return `- resources/${rel}：共用方法论文档（本仓未登记它管什么——补登记，或别挂它）`
  return `- resources/${rel}：${entry.what}｜何时需要：${entry.when}`
}

/**
 * 指针兜底里的节号台账：**从源文自己的 `##` 标题派生**，标题改名时台账跟着走（不会漂）。
 *
 * ⚠️ 票 02 第 1 层起它对**每一份**挂载文档派生（原先只有 `audit-and-testing.md` 有）——
 * 因为「状态迁移→节」那张表现在也指向 `file-contracts.md` 与 `delivery-checklist.md`，
 * 它们的节号如果不在指针上，那几节就成了死路。**读不出标题就只给路径**（不给空气节号）。
 */
function pointerMarks(rel) {
  const text = resourceSafeText(rel)
  if (text === null) return []
  return [...text.matchAll(/^## (.+)$/gm)]
    .map((match) => `§${match[1].split(/[、（]/)[0]}`)
}

/** `resourceText` 的安全形：文件读不出来就返回 `null`（挂载面不许因为一份文档坏掉就炸掉整份 brief）。 */
function resourceSafeText(rel) {
  try { return resourceText(rel) } catch { return null }
}

/**
 * 把三层挂到 brief 上（票 02）。返回拼好的正文；顺带把状态迁移注入的文档**登记进挂载闭包**，
 * 让 `brief.methodologyDocs` 仍然是「这一份实际挂了哪几份」的完整事实。
 *
 * ⚠️ **`never` 的行挂不进来**（`register` 与事件注入两处都直接跳过）：注入件集合由清单那一列说了算，
 * 挂载面不拥有「这一份例外」的权力——那正是本票第 1 层要消灭的「代码另定一套规矩」。
 */
function mountMethodology(base, meta, facts, state, onepagerLines, docs) {
  const register = (rel) => {
    if (discloseOf(rel) === null) return
    if (!docs.includes(rel)) {
      docs.push(rel)
      if (!onepagerLines.some((line) => line.startsWith(`- resources/${rel}：`))) onepagerLines.push(onepagerLine(rel))
    }
  }
  // ① 一页纸（阶段分支里 mtl() 攒的行）——**在状态迁移循环之后才拼**：注入的文档也要补一行。
  const resident = [RESIDENT_HEAD, pickSections(resourceText(AUDIT_DOC), ['## 九、'])].join('\n')
  // ② 状态迁移→节：触发取 `stageStateOf` 的 `reason` ＋ 仓库事件；没命中的节不进 brief
  const fired = firedInjectionIds(state, meta, facts)
  const notes = []
  const bodies = []
  for (const row of STAGE_STATE_INJECTIONS) {
    if (!fired.has(row.id)) continue
    const marks = []
    for (const wiring of row.inject(meta, facts)) {
      if (typeof wiring.when === 'function' && wiring.when(meta, facts) !== true) continue
      if (discloseOf(wiring.rel) === null) continue
      register(wiring.rel)
      if (wiring.full === true) {
        marks.push(`${wiring.rel} 全文`)
        bodies.push(resourceText(wiring.rel).trim())
        continue
      }
      const section = pickSections(resourceText(wiring.rel), wiring.headings)
      if (section === '') continue
      marks.push(`${wiring.rel} ${wiring.headings.map((h) => `§${h.replace(/^## /, '')}`).join('、')}`)
      bodies.push(section)
    }
    if (marks.length > 0) notes.push(`   · 状态迁移「${row.id}」（${row.why}）→ ${marks.join('；')}`)
  }
  const events = notes.length === 0 ? '' : [
    EVENT_HEAD,
    ...notes,
    '   （触发是仓库状态判定的，不是你自觉判断；没被触发的节一律走下面的指针兜底。）',
    '',
    bodies.join('\n\n'),
  ].join('\n')
  // ③ 指针兜底：精确路径＋节号，事件没接住时 AI 自救（rot 护栏：读一次 → 落产物 → 留摘要）
  const pointer = [
    POINTER_HEAD,
    RESOURCE_ROOT_LINE,
    ...[...new Set(docs)].map((rel) => {
      const marks = pointerMarks(rel)
      return `   - resources/${rel}${marks.length > 0 ? `：${marks.join('／')}` : ''}`
    }),
    '   （只回读当前这一步真要用到的小节，读完把结论落进产物——别把整份读进来。）',
  ].join('\n')
  // ① 一页纸（阶段分支里 mtl() 攒的行）＋常驻全文块（工具纪律 §九：短小普适，不按事件增减）
  const head = [ONEPAGER_HEAD, ...onepagerLines].join('\n')
  return [base, head, resident, events, pointer].filter((part) => typeof part === 'string' && part.trim() !== '').join('\n\n')
}

/**
 * 票 22（2026-09-29 用户裁决）：`references/invariants.md` **挂进 brief，但按 route 选节**。
 *
 * 口径三条，缺一不可：
 * ① 挂在哪几个阶段 = 下面 `INVARIANTS_STAGES` / `INVARIANTS_GATES` 两张表
 *    （`gold`/`merge`/`final` 已有 `delivery-checklist.md` 覆盖 I8，**不重复挂**）。
 * ② 按 `meta.route` 选节 = 下面这张**按 route 的节清单表**。
 *    ⚠️ **它不是事件→节注入表**：那张选的是 audit-and-testing.md 的小节（按事件触发），
 *    本表选的是 invariants.md 的小节（按路线），两回事，别互相推导。
 * ③ invariants.md **只按 route 选节**，不参与事件注入：它只有约 3000 字符、不需要按事件增减。
 *
 * 节号口径来自 `invariants.md` 自己的四段结构：I1-I4 跨路线 / I5-I6 仅 blueprint /
 * H1-H3 仅 human / I7-I9 过程（两条路线同等适用）。`writing-agent-prompt.md:17` 的占位符映射与此同源。
 */
const INVARIANTS_SECTIONS_BY_ROUTE = {
  'blueprint': ['## 一、', '## 二、', '## 四、'],
  'human-readable': ['## 一、', '## 三、', '## 四、'],
}
/** 挂的阶段：`explore`（否则 `SKILL.md` 那条 REQUIRED 是个**空指针**）与 `chapters`（铺章全程）。 */
const INVARIANTS_STAGES = new Set(['explore', 'chapters'])
/** 关卡阶段挂哪几关：②（教学模式选型）与 ③（整书教学架构）——最需要底线的两个设计路口。 */
const INVARIANTS_GATES = new Set(['2', '3'])


/** 给主 AI 的阶段任务说明（stage-brief 返回；全部中文、人话）。 */
function buildStageBrief(projectId) {
  const meta = readMeta(projectId)
  const stage = meta?.pendingStage ?? null
  const gate = meta?.pendingGate ?? null
  if (stage === null) return null
  // 票 03 · 「几路精读」这个数**只数一次**：连同它对应的材料条目一起从
  // `okMaterialShards`（`src/domain-rules.js`）取，`brief.materials` 与 `brief.parallelReads`
  // 都由**这一份**驱动。⚠️ 之前 `sources` 在这里私滤一遍 `convertedState(source) === 'ok'`，
  // `parallelReads[].n` 却来自 `okMaterialNumbers`（另一处过滤），而 `file/role/md` 靠
  // `sources[i]` **位置**对齐——两处口径哪天一分叉（一边认 `'ok'`、一边只认老书布尔 `true`），
  // 就是「派出去的文件名和材料对不上号」而没人看得懂。**位置对齐这个洞随本票一起消失。**
  const okShards = okMaterialShards(meta.sources)
  // 票 21 · pipeline-wiring-gaps：落到 brief 的 role 只认 `domain-rules.ROLES` 这一套 canonical
  // 五分类——空串（老代码 `?? ''` 兜底写法的产物）、字段缺失、老书遗留的越界值**一律不发**：
  // 发出去就等于告诉 AI「这份材料有一个五分类之外的角色」，AI 只能自己编一个（同一份 brief 注入的
  // source-material.md 里那张七类表正等着被抄——本票的病根）。键整体缺席（undefined 经 sendJson 的
  // JSON.stringify 消失），不是发个空串。⚠️ 归一与 `okMaterialShards` 的转换状态过滤是**两道独立的闸**
  // （判据见 test-brief-role-taxonomy.mjs：越界值源转完了照样不发，转没完的源归那道闸管）。
  // `sources` 在下面只算这一次、explore/gate/outline/gold 四个阶段的 `brief.materials` 都由它派生，
  // 归一在单点生效。判据强度对齐：`brief.materials[].role ⊆ ROLES` 是无条件不变量，所以这里按
  // `ROLES.includes` 收口，而不是只挡空串。
  const briefRole = (role) => (ROLES.includes(role) ? role : undefined)
  const sources = okShards.map(({ source }) => ({ file: source.file, role: briefRole(source.role), md: `材料/转换稿/${source.md}` }))
  /** 本 brief 实际挂了哪几份共用方法论文档——**记下来随 brief 一起交出去**（`brief.methodologyDocs`）。
   *  「哪个阶段挂了哪几份」从此是**生产路径上的一个事实**，不是靠人反解 `engine.js` 源码猜的
   *  （`test-brief-doc-closure.mjs` 的传递闭包断言读的就是这一份）。 */
  const methodologyDocs = []
  /** 一页纸的行：挂载闭包照旧登记，正文交出去的是那一行摘要（票 02：不再全文内联）。
   *  ⚠️ **`never` 的行直接不给**——注入件集合由产物清单那一列说了算（`discloseOf`），
   *  挂载面不拥有例外权；`docs` 也不会记它，所以它连指针兜底都进不去。 */
  const onepagerLines = []
  const mtl = (rel) => {
    if (discloseOf(rel) === null) return ''
    methodologyDocs.push(rel)
    onepagerLines.push(onepagerLine(rel))
    return onepagerLine(rel)
  }
  // 票 22：按 route 选节的不变量底线（**只对挂了的那几个阶段追加**）。
  const attachInvariants = (stageKey) => {
    if (!invariantsAttached(stageKey, gate)) return
    // ⚠️ 同一条 `never` 纪律：这张表按 route 选节是票 22 的口径，但**挂不挂**仍然由
    // 产物清单那一列说了算（今天它是 `pointer`；哪天判 never，这里就整块不给）。
    if (discloseOf('references/invariants.md') === null) return
    const headings = INVARIANTS_SECTIONS_BY_ROUTE[meta.route ?? 'blueprint'] ?? INVARIANTS_SECTIONS_BY_ROUTE['blueprint']
    const sections = pickSections(resourceText('references/invariants.md'), headings)
    if (sections === '') return
    // 路线名照 meta.route 逐字取（'blueprint' / 'human-readable'），不另造一套译法——
    // 这里写错会让 AI 看到「适用本路线（blueprint）」却拿到 human 的小节。
    const routeLabel = INVARIANTS_SECTIONS_BY_ROUTE[meta.route] === undefined ? 'blueprint' : meta.route
    brief.methodology = `${brief.methodology ?? ''}\n\n↓ 以下是不变量底线里**适用本路线（${routeLabel}）**的 ${headings.length} 节（resources/references/invariants.md 的其余小节属于另一条路线，不适用本书）：\n\n${sections}`
    methodologyDocs.push('references/invariants.md')
    onepagerLines.push(onepagerLine('references/invariants.md'))
  }
  /** 某份 brief 该不该挂不变量底线（阶段 + 关卡两维；`gold`/`merge`/`final` 一律不挂）。 */
  function invariantsAttached(stageKey, gateKey) {
    if (stageKey === 'gate') return INVARIANTS_GATES.has(String(gateKey))
    return INVARIANTS_STAGES.has(stageKey)
  }
  /** 关卡当前盘上真实裁决（驳回重做事件的判据之一；只在这一步读一次，别在两处各读一遍）。 */
  const gateDecision = stage === 'gate' ? foldGate(projectId) : null
  const brief = {
    stage, gate, label: stageLabel(stage, gate), dir: projectDir(projectId),
    // 方法论根目录也走**结构化字段**（不只是指针块里那一行）：派发行要原样转给小助手，
    // 从字段取比从散文里抠路径可靠。票 `.scratch/methodology-root-pointer/01`。
    resourceRoot: RESOURCES_DIR,
    project: { name: meta.name ?? '', goal: meta.goal ?? '', route: meta.route ?? 'blueprint', science: meta.science === true },
  }
  switch (stage) {
    case 'explore': {
      // 票 03 · ADR-0030 决策 2（改派）／4（模板层）：这一段的病是**回灌**——交办原文
      // 「要求详细摘录」把 3 份精读报告（22,106／39,321／52,770 字符）全灌回了主笔上下文。
      // 真机已经证明另一条路可行（有个精读小助手自发「细目落盘 38,030 字符＋摘要回灌」），
      // 但**全凭自觉**——这一支把它变成结构：精读派读是主路径，主笔的活是派发／合并／抽查。
      // 票 `context-budget/17`：合并件改**机器拼装**，主笔只交书级两件——口径改了，交办不给新说法
      // AI 就仍会去抄一遍（那 24,025 字符的 write 正是本票要永久省掉的那一笔）。
      brief.task = '统筹读完全部转换后的材料（每份的 材料/转换稿/ 子路径与 full.md 见 materials）：**按 parallelReads 逐份派精读小助手**（每份一个干净上下文，各路可并发），每路按 resources/references/subagent-prompts/close-reading-prompt.md 派，自己落下该材料的细目与知识地图分片。你只做三件：派发与抽查一两路、产出书级的 teachingFocus 与 chapterSuggestion、以及亲自汇总写 工作区/explore.md（那份索引的必做小节见 outputs，机器交工时逐项验）——**合并件由机器按分片拼装**（交工那一刻它按键拼成 工作区/knowledge-map.json），**不要自己再合并一遍**，那正是要砍掉的那份重复搬运。'
      // 票 07 · pipeline-wiring-gaps：explore.md 的必做小节与机器验货是**同一份词表**
      //（`domain-rules.exploreDepthTier`——任务说明与机器判据各写一份词表就会漂，漂了就是永远 400）。
      // 档位按当次转换完成的源数量分（同一次数出来的口径：分片/细目义务、parallelReads、这里的档位）。
      const exploreTier = exploreDepthTier(meta.sources)
      const exploreTierLine = exploreTier.count === 0
        ? '本次没有转换完成的源（无源书）：必做小节为空，索引写本次实际做的事。'
        : `本次转换完成的源共 ${exploreTier.count} 份 → 探查深度档「${exploreTier.tier}」，explore.md 必做小节：${exploreTier.required.join('、')}（小节名**逐字**含这些词，机器交工时按名字逐项验，缺哪项当场 400 点名哪项）。`
      brief.outputs = [
        // 票 brief-word-limits/01：主次分工写明——**细颗粒度落细目目录与知识地图 JSON，explore.md 只做给人读的索引**。
        // 原式两句并列，AI 看不出主次，于是「用户要更多细节」与「≤1200 字」互相顶。
        // ⚠️ 票 11 改掉了后半句：它原先逐字写着「细颗粒度的东西（逐条摘录、知识点细目）**一律进
        // 工作区/knowledge-map.json**」——那是**与落盘正面冲突**的一句话（spec 决策 14 点名要改的那句）：
        // 逐条摘录与知识点细目落的是**每个精读小助手自己的细目文件**，知识地图装的是结构化键与聚合，
        // 两件不是同一件，把细目导向 JSON 等于让主笔把五份全文手抄进一个文件里（实测最贵的那次搬运）。
        // 票 07 · pipeline-wiring-gaps：内容清单从「散文三类」换成与机器验货同一套词的必做小节
        //（源材料方法论 source-material.md §二第一层的产物：源文件简码表、真相校准、全书通用锚点；
        // 完整版再加每源结构探查与高频陷阱预判——三档分法见那份文档，档位与必做项由
        // exploreDepthTier 按源数给）。
        // ⚠️ 票 17 · ADR-0023：那份方法论简码表里的「地位」列**不在**这份索引里要求——
        // 逐源声明是结构化字段 materials[].standing（见下一条 outputs），散文里不再有第二份
        // 地位/权威式的要求（两处说法必然漂，结构化的那份是唯一出口；这个退役了的词
        // 在本文件里一个字都不许再出现——test-material-standing.mjs 的契约面判据盯着）。
        `工作区/explore.md —— **给人读的索引**（纯 Markdown，篇幅从简）。${exploreTierLine}每节下写真东西：源文件简码表要有 简码/路径/定位 三列，真相校准写实际翻源发现的「看起来完整其实是碎片」的坑，全书通用锚点写跨章共享的源定位（公式汇总表/原则全文位置/术语表位置）。约 1200 汉字（软目标，机器不验字数、验上述必做小节，超一点没关系）。**逐条摘录与知识点细目落 ${DETAIL_DIR_REL}/（每份材料一份，由那个精读小助手自己落盘，见 parallelReads[].reading），结构化的知识点键落 工作区/knowledge-map.json**——两份都不要塞进这个索引，它只做索引。`,
        `工作区/knowledge-map.json —— 结构化知识地图（严格 JSON，**结构化键与书级聚合的主落点**，格式与以前那份一模一样）：materials:[{num,standing,sections:[{title,summary,keywords}]}]（standing＝**材料分量声明**，逐源一句人话写清这份材料在什么问题上说了算、在什么问题上不算数；本次转换完成的源只有一份时可省——单本教材的声明无信息量；角色为「真题」的源必须写，且要显式写明有无配套答案与评分标准）、knowledgePoints:[{id,title,source,summary,difficulty}]（difficulty 只填 基础/重点/难点/进阶 四档之一——取值域登记在案，出域值机器交工时会归一化写回并告知用户；id 可选，机器不依赖它）、teachingFocus:[string]（重点/难点各一句人话，纯字符串，如「重点：分数运算」「难点：应用题建模」）、chapterSuggestion:[{title,source,points}]（${CHAPTER_SUGGESTION_MIN}-${CHAPTER_SUGGESTION_MAX} 章，契约区间，机器交工时验）。**materials 与 knowledgePoints 由各精读小助手各写各的分片（工作区/knowledge-map-NN.json），合并件由机器按分片序号按键拼装、交工那一刻落盘——你不用交它；你只交 teachingFocus 与 chapterSuggestion 这两件书级聚合（交工参数同名），它们是这一份里唯一只有你能产出的部分。逐条摘录与细目正文不在这里——它们在各路自己的细目文件里。**`,
      ]
      brief.materials = sources
      // 票 03 · Q6 已锁的落点：**逐份列并发单元**（形状先例＝ chapters 的 `remaining` 逐章表）。
      // 每格把那一份材料的两件落盘路径写死，派发时照抄即可——「并行」从散文里的「材料多时可以」
      // 变成表里的一行行事实。序号与材料条目**成对取自 `okMaterialShards`**（与
      // `stage-submit(explore)` 的验货同一份口径，且**不再按 `sources[i]` 位置对齐**）。
      brief.parallelReads = okShards.map(({ n, source }, i) => ({
        n,
        file: sources[i].file,
        role: sources[i].role,
        md: sources[i].md,
        reading: readingRel(n),
        shard: knowledgeShardRel(n),
      }))
      brief.methodology = `${mtl('SKILL.md')}\n\n${mtl('references/source-material.md')}`
      brief.hints = [
        '这是全书设计的基准，宁可多读、多整理，不要只读开头。',
        `精读派发模板：resources/references/subagent-prompts/close-reading-prompt.md —— 派每一路之前照它填（细目落盘 ${readingRel('NN')}、分片落盘 ${knowledgeShardRel('NN')}、最终回复 ≤2K token：结论／结构一句话／质量信号／落盘路径）。按 parallelReads 逐份派、可并发；材料多时不要退回「自己从头读到尾再汇总」，那会把同一份内容搬两遍。`,
        `精读小助手的回灌要短：细目写在它自己的 ${readingRel('NN')} 里，带回来的是浓缩结论＋条目级点名＋落盘路径。**别让它把整份摘录灌回你的上下文**——那是你这一段最大的开销来源。`,
        `合并步：合并由机器做——交工那一刻它按 NN 把各份 ${knowledgeShardRel('NN')} 的 materials/knowledgePoints 拼成 工作区/knowledge-map.json；你只交书级的 teachingFocus 与 chapterSuggestion（stage-submit 的同名参数）。抽查请读分片或细目的**片段**，不要整份搬进上下文。`,
        '无论自己读还是派小助手，文件操作用文件工具（read/write/edit/glob/grep），别用 shell（工具纪律见 audit-and-testing.md §九，跨平台一致）。',
        `写完用 stage-submit（stage=explore）交工，带 teachingFocus 与 chapterSuggestion；机器会验 工作区/explore.md（必做小节逐项在场，见 outputs）、每份转换完成的材料各有一片 ${knowledgeShardRel('NN')} 与一份 ${readingRel('NN')}、材料分量声明（≥2 份源时逐源要有 standing，真题源还要显式表态有无配套答案与评分标准——单源可省）、以及 chapterSuggestion 的章数（${CHAPTER_SUGGESTION_MIN}-${CHAPTER_SUGGESTION_MAX} 章），缺一件当场 400 并逐件点名；合并件由机器拼，不用你交。`,
      ]
      // 重做时：把用户的不满意见带给 AI（这是重做唯一的改进方向）。
      const redoNote = meta.exploreRedoNote
      if (typeof redoNote === 'string' && redoNote.trim() !== '') {
        brief.userFeedback = redoNote
        brief.hints.push(`这是重做：用户上次的不满意见是「${redoNote}」。必须照着改；实在不清楚就先在对话里问用户确认方向，绝不能再交一份几乎一样的。`)
      }
      break
    }
    case 'gate': {
      const current = gateDecision
      brief.task = `手工起草${gateHuman(gate)}的设计方案，用人话向用户解释，等用户拍板。`
      brief.gateLabel = GATE_LABELS[gate] ?? ''
      brief.gateTask = {
        '1': '分析源材料并推导学习目标：这本书让学习者最终能做到什么？最大的坑是什么？',
        '2': '教学模式选型与板块语法：读了模式库，考虑过哪些、拒绝哪些、为什么；选中的模式解决本书哪个教学问题；设计每章的板块结构。',
        '3': '整书教学架构：知识链主线、卷/部划分、逐章骨架表（每章五行：章号/标题/类型/知识链位置/锚定知识点——**锚定知识点来自知识地图**（探查段合并件 工作区/knowledge-map.json），第 5 列统一是知识点，无源书没有知识点清单、那一列改写锚定的源任务或概念）、特殊章、跨章引用机制、附录策略、贯穿案例约定；以及体量设计：整书总字数与预计学时、每章字数区间、依据（材料知识量/学习目标/读者背景），体量须在大白话摘要中呈现。**另有两件在**这一步**就要答、不能拖到写范式章才答**：①本书第一读者是谁（AI 老师 / 人类读者）；②防螺旋铁律的**设计期禁令**——从这一关拍板到写作规范产出之间，不许自行加章/加附录/加机制级板块，真要加等用户走定点修改重新拍板（style-spec 里的「防螺旋铁律」那一项记的是**定稿之后**的回炉规则，两半不是一回事）。',
      }[String(gate)] ?? ''
      // 票 `pipeline-wiring-gaps/05`：关卡③ 的骨架表第 5 列要「锚定知识点」，但这一关原先
      // 既没挂参考件、任务词也不提知识地图（核验报告 verification.md 第 1 条：CONFIRMED）——
      // 孤儿指令的形状。与 outline 段同形地**两处一起接**：参考件挂 `brief.references`、
      // 任务词在 gateTask['3'] 里明写「锚定知识点来自知识地图」（判据见 test-gate3-knowledge-map.mjs，
      // 两处缺一即红）。只在 gate 3 挂：①② 用不到知识地图，不动前两关。
      if (String(gate) === '3') {
        brief.references = ['工作区/knowledge-map.json（知识地图）']
      }
      brief.previousDecision = current === null || current.gate !== gate ? null : {
        version: current.version, status: current.status,
        reasons: current.decision?.reasons ?? [], note: current.decision?.note ?? '',
      }
      brief.outputs = '方案三段通过 stage-submit（stage=gate）提交：title（一句话标题）/ summary（给用户看的人话摘要，约 300 汉字以内；软目标，机器不验）/ detail（完整方案 Markdown 正文，必须内联全文--禁止写「见文件/proposal-*.md」，用户只在页面上看方案，不会去文件夹翻）。**正式拍板卡的入参来自真实方案，不许出现测试/占位字样**——三段都填了不等于内容是真的（真出过的一次三段全非空、内容全是占位件）；机器逐字段筛测试/占位词表（「测试标题」「测试摘要」「稍后重发」「占位」「TODO」…），命中当场 400 并点名是哪个词、在哪个字段，纪律见 resources/references/anti-patterns.md 的流程级反模式。'
      brief.materials = sources
      brief.methodology = mtl({
        '1': 'references/source-material.md', '2': 'references/patterns/README.md', '3': 'references/file-contracts.md',
      }[String(gate)] ?? 'SKILL.md')
      // 本书自定义模式库一并交给 AI（与内置模式库同等地位）：用户在拍板/驳回「换个风格」时
      // 粘贴的描述会变成自定义模式卡，任何一关（含修订）都要读到它。
      {
        const customPatterns = customPatternsBrief(projectId)
        if (customPatterns !== '') brief.methodology = `${brief.methodology}\n\n${customPatterns}`
      }
      brief.hints = [
        '面向家长/老师，别用黑话；字符串里严禁英文双引号，引用一律用「」。',
        '若 previousDecision 是被驳回的方案，必须认真采纳用户意见再修订，并在摘要里说明采纳了哪些。',
      ]
      break
    }
    case 'outline': {
      // 票 `pipeline-wiring-gaps/12`：任务词写明知识点覆盖闸门（票 07 的同一口径：交办与机器验货
      // 同一套词，AI 与机器都知道交工时验什么）。口径按票 01：title 单键、先规范化、id 不进比对环。
      brief.task = '基于知识地图与材料结构，设计整书章节骨架：每章明确用哪份材料的哪一部分、覆盖哪些知识点（points，来自知识地图——交工时机器会按 title 逐条比对知识地图（比对前先规范化：去尾部括注/trim/全半角）：知识地图里每条知识点都要被某一章的 points 认领，points 里也不许出现知识地图没有的条目，漏了/多了当场 400 并逐条点名）、建议字数（遵循第 3 次拍板已定的体量设计，不许静默缺省）、体量依据；并标注建议的最佳范例章（goldChapter+理由：哪章最能代表全书风格/结构最完整/材料最充分）。'
      brief.outputs = 'chapters 数组通过 stage-submit（stage=outline）提交：[{title,outline(一句话),source:"资料N：小节或主题",targetWords,points:[知识点…],volumeReason(一句依据)}]（4-10 章），外加 goldChapter（1 基章号）与 goldChapterReason（一句理由）。'
      brief.references = ['工作区/knowledge-map.json（知识地图）', '工作区/explore.md（探查报告）']
      brief.materials = sources
      brief.methodology = mtl('references/file-contracts.md')
      const outlineRedo = meta.outlineRedoNote
      if (typeof outlineRedo === 'string' && outlineRedo.trim() !== '') {
        brief.userFeedback = outlineRedo
        brief.hints = [...(brief.hints ?? []), `这是重做：用户上次的意见是「${outlineRedo}」。必须照着改；不清楚就先问，绝不能交一份几乎一样的。`]
      }
      break
    }
    case 'gold': {
      const gn = goldN(meta)
      const chapterSource = meta.outline?.chapters?.[gn - 1]?.source ?? ''
      const auditName = `工作区/audit-${String(gn).padStart(2, '0')}.md`
      brief.chapter = gn
      brief.title = meta.outline?.chapters?.[gn - 1]?.title ?? ''
      // 票 `context-budget/04` · ADR-0030 决策 2：**风格源头从主笔挪到执笔小助手**。
      // 这一段的正文（写作规范 ＋ 范例章）原先由主笔亲笔写 ⇒ 主笔同时是「写的人」和「审的人」，
      // 而且材料正文要过主笔的手（与 ADR-0030 决策 1「材料不搬运」正面矛盾）。
      // 现在主笔是**纯协调者**：派发 ＋ 转达用户意见 ＋ 逐条回权威源核实后汇总裁决（裁决权那一半保留）。
      // ⚠️ 这是**质量模型的变化**、不只是省 token（ADR-0030 后果第一条）：机器层只断接线与形状，
      //    范例章质量与用户意见闭环的手感是真机层（ADR-0005，票 07）。
      brief.task = `协调全书的最佳范例章（第 ${gn} 章，全书基准）。这一段的正文不由你写——风格源头单点在执笔小助手那边，你走四步：①派执笔小助手起草（写作规范 ＋ 第 ${gn} 章**分片**，按 \`resources/references/subagent-prompts/gold-writing-agent-prompt.md\` 那份派发模板填必带内容；本章材料小节由它在自己的干净上下文里读）；②**它交稿后先让机器把分片拼成章正文**（workbench_act(action=chapter-assemble, chapter=${gn})）——审计小助手要读的 ${chapterRel(gn)} 就是机器拼出来的那一份；③再派全新上下文的审计小助手（模板与产出形状照旧，结论照旧过 audit-submit）；④读审计报告，**逐条回权威源核实后汇总裁决**（审计员也会误判，不照单全收）；⑤点名条目与用户意见一并回灌给执笔小助手修订（改完分片要**再让机器拼一次**），最后 stage-submit 交工。这是全书其余章节要模仿的基准，务必高质量、与教材内容一致。`
      brief.targetWords = meta.outline?.chapters?.[gn - 1]?.targetWords ?? meta.targetWords ?? 6000
      brief.chapterSource = chapterSource
      brief.outputs = [
        // 票 19：这份契约文本是「审计要查的东西、producer 不许写」那条悬空契约的**生产端**。
        // 票 `context-budget/04` 起它**随 producer 搬到执笔派发模板**（生产端跟着生产端的人走），
        // engine 这一侧只留落盘形状 ＋ 指路；十八项与 `resources/references/subagent-prompts/audit-agent-prompt.md
        // §审计要求`、`audit-and-testing.md §7.0` 两份审计清单**逐项对齐**；差集断言（`test-contract-gap.mjs`）
        // 从两侧**解析**出集合来比，三处都不硬编码第二份清单。解析锚点与截段规则单点在
        // `dev/style-spec-contract-source.mjs`（三条判据共用，别各写一份）。
        `工作区/style-spec.md -- 写作规范（十九项契约，**每项都要有一个同名小节**，逐项打钩）。**十九项的全文与每一项的答法不在这里，在派发模板 \`resources/references/subagent-prompts/gold-writing-agent-prompt.md\` 的「写作规范十九项契约」一节**——照那一节写，别凭印象；「N. **项名**」的编号是给机器解析用的，改成散文这一段的差集判据就空转了。`,
        // 票 `walkthrough-2026-10/02`：执笔小助手**只落分片**（章正文由机器拼）。这一行是它的产物要求，
        // 而下面那一行是被拼出来的那一份——两份都在清单里，AI 才知道「谁写哪一份」。
        `${chapterShardRel(gn, 1)} —— 第 ${gn} 章正文的**分片**（执笔小助手写这一份；NN＝章号、MM＝第几路，都补两位、从 01 起。一章只派一路就是「-01」；派两路就是「-01」＋「-02」，机器按 MM 升序拼）`,
        `${chapterRel(gn)} —— 第 ${gn} 章全文（按 style-spec，含全部板块与答案；约 ${brief.targetWords} 汉字，是写作体量参考、**不是闸门**——机器不验字数，宁可多写不可敷衍）。**这一份由机器从分片拼**（chapter-assemble），你与小助手都不写它`,
        `${auditName} —— 审计记录（四层审计 + 试教[条件触发]；**由那份额外派出的审计小助手产出**，严格 JSON：{"passed":true,"issues":[{"level":"错误|警告|提示","text":"具体问题"}]}）`,
      ]
      brief.materials = sources
      brief.methodology = `${mtl('references/file-contracts.md')}\n\n${mtl('references/audit-and-testing.md')}`
      // 票 workbench-transitions/19③（2026-09-24 裁决补充）：范例章也是写作任务，风格线同样必读。
      // 这一段原先**没有** `references` 字段（`gold` 是新建，不是「加一行」）。
      brief.references = ['工作区/style-line.md（写每一章前必读、逐条落实）']
      // 金标准写作规范：本书自定义模式库一并交给 AI（「模式选型」节须覆盖它们）。
      {
        const customPatterns = customPatternsBrief(projectId)
        if (customPatterns !== '') brief.methodology = `${brief.methodology}\n\n${customPatterns}`
      }
      brief.hints = [
        // 票 04：原来这条要求主笔自己「找到对应材料小节通读，再动笔」——那正是 ADR-0030 决策 1
        // 「材料不搬运」的活体反例。现在 `brief.materials` 只当**路径清单**用：主笔据它 ＋ outline 的
        // source 合成一条定位交给执笔小助手，**材料正文留在执笔小助手的干净上下文里**。
        `材料怎么交给执笔小助手：brief.materials 给的是**路径清单**（文件名／角色／转换后 md 相对路径，纯元数据不是正文搬运），你据它 ＋ outline 里第 ${gn} 章的 source（${chapterSource === '' ? '这一章没填 source，先按 outline 与知识地图对出来' : `「${chapterSource}」`}）合成一句定位——哪份材料的哪个小节——写进派发 prompt；**材料正文由执笔小助手在它自己的干净上下文里读，你不读**（ADR-0030 决策 1「材料不搬运」，rot 护栏：读一次 → 落产物 → 留摘要）。`,
        '派执笔小助手时按 `resources/references/subagent-prompts/gold-writing-agent-prompt.md` 那份模板填必带内容（章骨架＋知识点清单／材料定位／风格线／本书自定义模式库／不变量编号）；它写 工作区/style-spec.md ＋ **本章分片**（`工作区/分片/chapter-NN-MM.md`，本章就是上面 outputs 里那一片），**章正文与审计文件都不归它**（也不许它先把审计文件写出来占位）。',
        // 票 `walkthrough-2026-10/02`：分片落齐后**先让机器拼**，再派审计——审计读的是拼出来的正文，
        // 而票 22 的新鲜度闸门比的就是它与检查记录的 mtime（晚拼一步，检查记录当场变成「审的是旧稿」）。
        `分片落齐后**先让机器拼章正文**：workbench_act(action=chapter-assemble, chapter=${gn})。审计小助手读的就是拼出来的 ${chapterRel(gn)}；改过分片（含用户意见那一轮修订）要**再拼一次**，否则审计审的是旧稿。交工时机器会再拼一次并验「盘上那份就是这几片分片的拼装件」——**盘上那份若不是机器拼的，交工会被拒收**（机器不覆盖它）。`,
        // 票 context-budget/06（ADR-0030 决策 4）＋ 合并对齐：回灌预算**不留占位符**——
        // 逐类定档已经落定（audit-and-testing.md §九 那张表的「范例章执笔回执」＝≤1K token），
        // 这里只点那一档与出处，不重述形状（与 chapters / final 两支同口径）。
        '回灌有预算：执笔小助手的完工回执 ≤1K token（形状与逐类一档表的单一事实源是 audit-and-testing.md §九「回灌三件套」，派发时按 gold-writing-agent-prompt.md 那份填）——超了就只留指针、细目去 工作区/style-spec.md 与章稿里看，不许把正文或逐条证据抄回回报。',
        '稿子回来后**不要自己充审计**：按 `resources/references/subagent-prompts/gold-audit-prompt.md` 派全新上下文的审计小助手（必读文档矩阵+一致性核对，产出含 matrix 的 audit 文件），读报告、判决后才交工。',
        `审计结论落盘后，先交给机器过一遍形状：workbench_act（action=audit-submit）当场验 ${auditName} 的 matrix（5 个必读文件各一行 {file, quote}、quote 逐字；不带内容就读书里那份，也可带 auditJson 正文由机器落盘）。不合格会当场把机器看到的行键、样例与缺口说清——别等 stage-submit 那一刻才知道。`,
        '派小助手/审计小助手时提醒：文件操作用文件工具（read/write/edit/glob/grep），别用 shell（工具纪律见 audit-and-testing.md §九，跨平台一致）。',
        '要小助手继续跑：优先 send_message 唤醒原来那个执笔小助手（忘了是谁就用 list_agents 按「章号 ＋ 角色」的 label 召回），召不回才新派——与逐章写作段既有先例同形。',
        `写完用 stage-submit（stage=gold）交工；机器验三份文件都在且非空。`,
      ]
      // 修订时：把用户的金标准意见（意见单 + 合并后的交办）透出给 AI，由它转达给执笔小助手。
      const goldActive = (meta.goldOpinions ?? []).filter((o) => o.status === 'pending' || o.status === 'sent')
      const goldRedo = meta.goldRedoNote
      if (goldActive.length > 0 || typeof goldRedo === 'string') {
        brief.goldOpinions = goldActive.map((o) => ({ kind: o.kind, wish: o.wish, target: o.target }))
        const note = typeof goldRedo === 'string' && goldRedo !== '' ? goldRedo : goldActive.map((o, i) => `#${i + 1} ${o.wish}`).join('；')
        brief.userFeedback = note
        brief.hints = [
          ...(brief.hints ?? []),
          ...(meta.goldRedoNote != null && meta.goldRedoNote.includes('整版重写')
            ? // 整版重写本就「不参考旧稿」：唤醒原来那个等于让它背着旧稿重来，这一轮**直接新派**
              // 一个执笔小助手按派发模板从头起草，再走一遍审计（唤醒策略与普通修订轮不同形，理由在此）。
              [`这是整版重写：${meta.goldRedoNote} 不参考旧稿（已归档）——**直接新派一个执笔小助手**按派发模板从头起草（这一轮不唤醒原来那个，唤醒了它就是背着旧稿重写），审完再交工。`]
            : [`这是修订：用户的意见是「${note}」。**逐条转达给执笔小助手去改**（仍优先 send_message 唤醒原来那个，召不回才新派），正文不由你亲手改；改完自查一遍再交工。`]),
          '交工后用户会在工作台「边读边标记」确认；每条意见都会在定稿时沉淀进风格线，全书写都要遵守。',
        ]
      }
      break
    }
    case 'chapters': {
      const chapters = meta.outline?.chapters ?? []
      const remaining = chapters
        .map((chapter, index) => ({ n: index + 1, ...chapter }))
        .filter((chapter) => !chapterDone(projectId, chapter.n))
      brief.task = `写完整本：对每一章走四步——派小助手写（给大纲/材料小节/写作规范/范例章路径；**它只落分片** \`工作区/分片/chapter-NN-MM.md\`，一路一个号，章正文不归它）→ **让机器把分片拼成章正文**（workbench_act(action=chapter-assemble, chapter=N)——审计要读的 \`工作区/chapter-NN.md\` 就是拼出来的那一份，改过分片要再拼一次）→ **调一次编排脚本审这一章**（宿主 \`workflow\` 工具，**一次运行只审一章**：脚本自己派一个干净上下文的审计小助手，**审计员自己落盘 \`工作区/audit-NN.md\`** 的严格 JSON，机器按章验货读的就是它；**你不再从它的回报转写**——脚本把 \`{chapter, passed, auditPath}\` 结构化带回）→ 机器按章验货（audit.passed===true 才放行）。**remaining 里还没写的各章可并行派多个写作小助手**（每章一个、干净上下文、各写各的分片），各自完成后逐个交工验货。你不逐章复核；只有该章有用户抽查意见时，才需要你亲自核对修订结果。`
      brief.total = chapters.length
      brief.remaining = remaining.map((chapter) => ({
        n: chapter.n, title: chapter.title ?? '', outline: chapter.outline ?? '',
        source: chapter.source ?? '', targetWords: chapter.targetWords ?? meta.targetWords,
        points: chapter.points ?? [],
      }))
      brief.references = [
        '工作区/style-spec.md（写作规范）',
        // 票 workbench-transitions/19③：风格线原先只有 persona 一条 + `工作区/style-line.md` 镜像，
        // 逐章交办里没有它——界面那句「AI 写每一章都会照着办」于是不兑现。这里把它补进必读清单。
        '工作区/style-line.md（写每一章前必读、逐条落实）',
        '范例章（见 brief）',
        '工作区/outline.md（章节骨架）',
        // 票 `chapter-audit-orchestration/03`：审计那一跳改由编排脚本驱动 ⇒ 两件进必读清单。
        // 两处路径都从上面的常量派生（不在这里手抄第二个字面量）。
        `resources/${AUDIT_TEMPLATE_REL}（章级审计派发模板：脚本里那份派发正文照它逐项填）`,
        `resources/${CHAPTER_AUDIT_SCRIPT_REL}（编排脚本骨架与调用形状：一次运行只审一章）`,
      ]
      // F39（2026-08-20 走查）：段落级抽查意见也透出给 AI（整章意见带 comment，段落意见合成人话；已撤回的跳过）。
      // 票 09：**必须带 id**——没有 id，主笔 AI 交工时无从点名（handledReviews 按 id 销号）。
      brief.pendingReviews = (meta.pendingReviews ?? []).filter((r) => r.status !== 'revoked').map((r) => ({ id: r.id, chapter: r.chapter, comment: paragraphReviewText(r) }))
      brief.methodology = `${mtl('references/audit-and-testing.md')}\n${mtl('references/file-contracts.md')}\n${mtl('references/subagent-prompts/writing-agent-prompt.md')}\n${mtl(AUDIT_TEMPLATE_REL)}\n${mtl(CHAPTER_AUDIT_SCRIPT_REL)}`
      brief.hints = [
        CHAPTER_PROGRESS_REQUIREMENT,
        // 票 03 · P34：上面那条只说了 stage 有哪些取值，没说**什么时候**必须报——实测 9.4 小时里
        // 「还剩 39 步」一字未变、▶ 指着 10 小时前就写完的第 1 章，因为 AI 一次都没带过
        // chapter/stage（契约有、转发有、按章落账有、界面也接上了，只有上报这一格是空的）。
        '逐章阶段上报：每章走「写 → 审 → 复核」时，**每次状态变化**都用 workbench_act(action=progress) 把 chapter=N 与 stage 一起报上（stage 的取值见上一条）——派出去写时报 writing、检查时报 auditing、检查完报 audited、你要复核报 finalizing、这一章交工完报 done。只有文字、没有 chapter 与 stage 的 progress 落在步清单上什么也看不出来。',
        // 票 `walkthrough-2026-10/02`（走查 A10 的裁决）：**换协议**，不是「加一把锁」。
        // 病：「拆两半派」时两个执笔小助手写**同一个** `工作区/chapter-08.md`——零互斥、零合并，
        // 谁后落盘谁说了算（后半段那位报「已落盘、前半段未改动一字」的时间早于前半段报「已落盘 455 行」）。
        // 换协议之后**每一路落自己的分片**，章正文由机器按分片号拼——两个写者结构上碰不到同一个文件。
        // ⛔ 旧句「各章独立文件（chapter-NN.md / audit-NN.md），绝不共享工作区写同一文件」随本票退役：
        // 那句话当年就是**唯一的载体**（`src/**` 里没有任何机器判据断它），而它管不住子助手手里的写工具。
        '并行纪律：remaining 各章可并行派多个写作小助手，并发 2-4 章为宜（低内存/老机器从 2 起）；每章一个写作小助手、**各写各的分片文件**（`工作区/分片/chapter-NN-MM.md`：NN＝章号、MM＝第几路，都补两位、从 01 起，一路一个号——**同一章拆两半派就是 01 ＋ 02，谁也不碰别人的分片**；章正文 `工作区/chapter-NN.md` 由机器按 MM 升序拼，谁都不直接写它）；分片落齐后**先让机器拼章正文**（chapter-assemble）再派审计，改过分片要再拼一次；各章各自完成后逐个交工验货（ordered-commit：慢章压住快章属预期，不必等齐）。宿主不支持并行 spawn 时小助手自动排队，退化为逐章串行，行为与现状等价。',
        // 票 `chapter-audit-orchestration/03`：审计那一跳改由宿主的 `workflow`（编排脚本）驱动。
        // 三条杠杆与骨架同源——脚本形状住 resources/…（references 清单里也点了一次），这里只点
        // 「什么时候用、边界在哪」，不重述脚本正文（重述就是会漂的第二份）。
        `审计那一跳用编排脚本（宿主 \`workflow\` 工具，骨架与调用形状见 resources/${CHAPTER_AUDIT_SCRIPT_REL}）：**一次运行只审一章**——要审哪一章就把它放进 args 单开一次运行，别把 remaining 里剩下的章塞进同一次运行。`,
        '审不过就停：编排脚本**不自行派修复、也不重试**——它把 `{chapter, passed, auditPath}`（章号、结论、报告落点）原样带回；要修就由你按点名条目**另派一个干净上下文的成员**去改该章，改完重新走一遍审计与机器验货。',
        '脚本里不许再嵌 `workflow`：脚本成员继承模式里的**全部**工具集，引擎也不传深度限制——递归扇出是真实风险。⚠️ 这一条**只有纪律、机器不强制**（宿主没有按工具名的白/黑名单，可用的机制只有「挂不挂」）。',
        '派小助手/审计小助手时提醒：文件操作用文件工具（read/write/edit/glob/grep），别用 shell（工具纪律见 audit-and-testing.md §九，跨平台一致）。',
        '小助手与审计小助手用你的 subagent 工具派；提醒小助手材料小节与产出文件的准确路径（都在 dir 下）。',
        '每交一章前先 workbench_status 查有没有新抽查意见，有就先处理（修订 → 重新审计 → 机器验货）再继续；该章意见未处置机器会拒收。',
        '写完整本途中的引导杠杆：来了用户意见/风格线变化 → 先 send_message 转达给正在写那一章的小助手（别等整章写完再打回），并落一行 progress；小助手跑完没交齐 → 优先用 send_message 唤醒原来那个小助手（忘了是谁就用 list_agents 按「章号 + 角色」的 label 召回），不用重派。细则见 audit-and-testing.md §十一。',
        // 票 11 · P30＋P42：焦点区主卡逐字显示最近一条 progress（顶部横幅只出状态词那半截，
        // 见 audit-and-testing.md §11.5②），所以「只在开工时发一条」等于对外宣称一件
        // 已经结束的事；而要用户拍板的那类决定记进 progress，机器侧就无从知道有**一个问题悬着**。
        '进度保鲜与拍板通道：每个小助手回来、每交工一章时，**必须补一条 progress**，写那段时间里真的在做的事（派了几路、在写哪几章、哪几章检查完了、下一路是谁）；上一次落账到这一次之间一个章的时长都没补，工作台上挂的就是旧闻。要用户拍板、选一条路、授权一次改动，走 intervene，不要记进 progress（它是留给用户回话的悬案通道，工作台据此把闸门按钮亮出来）。留痕不许因为加了保鲜就被稀释——该落的引导那一行一次都不能少，细则见 audit-and-testing.md §十一。',
        '处置过的抽查意见要在交工时报出：stage-submit（stage=chapters）带 handledReviews:[{id, how}]——id 取 pendingReviews 里那一条，how 是一句人话（这条我怎么改的）。机器**只给点名的**置为已处置，没点名的继续拦；一条都不点名就交工会被 400 打回。',
        // 票 walkthrough-2026-10/06 现象二（2026-10-05 走查 BUG-4①）：主卡把 progress 的 detail **原样**
        // 上屏，而走查那一屏的自述写着「你已点继续」——屏上根本没有那个按钮。规则正文在 §11.5（进度保鲜那一半）。
        '进度行只叙述已发生的事实的界线：progress 那一行会**原样**出现在主卡上给用户读，所以它只说已经发生过的事（盘上写了、账上记了、小助手回来了）；不许承诺还没发生的事，也不许引用一个界面上没有的动作（走查那一屏写着「你已点继续」、而屏上只有「⏸ 暂停」）。别替用户记动作。细则见 audit-and-testing.md §11.5。',
        '机器按章验货：每章都要有 工作区/chapter-NN.md 和 audit-NN.md，且 audit.passed 必须是 true（读审计 JSON，不是只看文件存在）。',
        // 票 brief-word-limits/01：把「字」的口径与「这些数字不是闸门」**一次说清**（主笔 AI 自报进度
        // 那行自由文本只能靠交办说明/persona 传口径，服务端改不了它的措辞）。
        '体量口径：remaining[].targetWords 的「字」一律按**汉字**计（数字/字母/标点/空白都不计），它是写作体量参考、**不是交工闸门**——机器不验字数，超一点没关系。自报 progress 时也按这个口径说。',
        // 票 02 · P19：要用户拍板的选择由宿主 `ask_user_question` 提问卡渲染（工作台零实现），
        // 它逐字显示每个选项的说明——**预告只能写在选项说明里**，写成别的位置等于没写。
        // 措辞沿用工作台「✍️ 定点修改这一步」那段既有的影响预告（`src/ui/phase-page.js`），不另起一份格式。
        '要用户拍板时先把影响预告给出来：凡是你要在几个选项里请用户选、而选哪条会牵动已经写好或已经拍板的内容（例如全书体量、章节结构、范例章写法），**每个选项的说明都要各带一句影响预告**，照「影响预告：这一步改了，这些要一起重做：…」那个形状说人话——按现在已写 N 章、累计多少汉字说清：选它要重写哪几章、最终落在多少汉字。三条路各有各的代价（实测里最忠于用户当初拍板的那条恰好最贵），不许等用户点完再在正文里补一句「我倾向」。',
        '派写作小助手时必须带（按 writing-agent-prompt.md 模板填）：本章知识点清单（remaining[].points）、本章在知识链中的位置与跨章引用指向（前面哪章讲过什么、后面哪章会用到这里）、范例章路径与写作规范。',
        '跨章引用纪律：前向引用只到大纲承诺粒度（「第 N 章会展开」），禁止编造未写章节的具体数字/结论/例题；审计小助手按 audit-agent-prompt.md 派，要求其扫跨章引用存在性（含前向承诺失配）。',
        // 票 context-budget/06（ADR-0030 决策 4）：回灌预算从交办说明这一层点一次名——形状与逐类
        // 一档表的唯一出处是 audit-and-testing.md §九「回灌三件套」，这里只点两档与出处，不重述形状。
        // N 是 AI 侧软目标（机器永不查字数/篇幅，CONTEXT.md「机器检查契约原则」），真合没合规归真机层。
        '回灌有预算：写作小助手的完工回执 ≤1K token、章审计报告 ≤2K token（形状与逐类一档表的单一事实源是 audit-and-testing.md §九「回灌三件套」，派发时按 writing-agent-prompt.md / audit-agent-prompt.md 填）——超了就只留指针、细目去落盘件里看，不许把正文或逐条证据抄回回报。',
      ]
      // 票 28 / 走查 P46：每次领任务都把**主 AI 上下文占用**一并告诉主笔 AI，
      // 好让它知道自己该收尾了。读不到（宿主投影缺席 / 未绑定读数口）就**整句不追加**——
      // 绝不写 0%、绝不编一个百分比。落点在这一层（brief.hints），不改方法论文档、
      // 不动 progress 事件语义、不新增 workbench_act 动作名与账本事件类型。
      {
        const occupancyLine = contextOccupancyBriefLine(meta.session)
        if (occupancyLine !== null) brief.hints.push(occupancyLine)
      }
      break
    }
    case 'merge': {
      // 票 `.scratch/context-budget/issues/05` · ADR-0030 决策 2（改派第一刀 · merge 段）。
      //
      // **病根是分工，不是措辞**：改之前这一支要求主笔「通读全部章节 + outline +
      // knowledge-map」，而实测（session-98d830e6）merge 窗口 **+0 token**——一个章都没读，
      // 凭协调记忆写出了 2,780 字符的 audit-cross.md，机器只验「文件存在且非空」就放行。
      // 交办文本与「材料不搬运」的诊断正面矛盾，实测的解法就是静默不做。
      // 所以这一支改成**协调者形态**：派审计小助手 → 收报告 → 按点名条目派修复小助手 →
      // 汇总裁决追加进 audit-cross.md → 写前言 → 交工。**主笔不碰章正文。**
      //
      // ⚠️ 四项核对的**判定词与判定口径只住在派发模板**（`references/subagent-prompts/
      // cross-audit-prompt.md` 的「四项核对判定表」，机器的验货判据也从那儿解析）。
      // 这里与方法论文档、拒收文案、人设一律只**引**它——各写一份就是四份会漂的平行清单。
      const mergeTemplatePath = `resources/${CROSS_AUDIT_TEMPLATE_REL}`
      brief.task = `合并前先**派跨章审计小助手**做跨章审计（派发模板：${mergeTemplatePath}，四项判定词与判定口径只住在那一份里，别处不另抄）：**派发那一刻你手里不许有任何一章正文**，它从零读全部章 + outline + knowledge-map + style-spec 逐项核对，**报告人自落** 工作区/audit-cross.md（机器逐项验那四项都有交代才放行合并）。你只收它的报告：按它**条目级点名**的那几条**逐条派修复小助手**去改（你不碰章正文），再把「哪几条要改、哪几条判为误判」的汇总裁决**追加**进 audit-cross.md（小 edit，别整份重写）。然后写这本书的前言/使用说明（约 300 汉字，通俗；软目标，机器不验字数），随 stage-submit（stage=merge, preface=...）交工；机器会 100% 保真拼装各章成书（不删节）。`
      // 章路径清单（票面「派发接线」）：**纯路径元数据**，不带正文——形状先例＝chapters 的
      // `brief.remaining`。路径逐字取自 `chapterRel`（章节正文路径的单一出处，见 `src/domain-rules.js`）。
      const mergeChapters = meta.outline?.chapters ?? []
      brief.auditScope = {
        template: mergeTemplatePath,
        chapters: mergeChapters.map((_chapter, index) => chapterRel(index + 1)),
        constraints: [...CROSS_AUDIT_CONSTRAINTS],
        report: CROSS_AUDIT_REPORT_REL,
      }
      brief.references = ['交工后工作台会生成 工作区/book.md（机器拼装成品）']
      // 挂载关系照旧（票 05 口径）：这一支仍挂 `references/audit-and-testing.md`，
      // 但**取法**用票 02 合并后的形态——`mtl(...)`（事件注入表已接管分阶段尾节，`mtlWithTail` 退役）。
      brief.methodology = mtl('references/audit-and-testing.md')
      brief.outputs = ['维护 工作区/progress.md（每章一行：写完/审计/验货）', `工作区/audit-cross.md —— 合并前跨章审计结论，由审计小助手自落（机器逐项验四项核对都有交代才放行）`]
      brief.hints = [
        '前言写给"拿到这本书的人"：这本书讲什么、怎么用（给 AI 老师上课还是人直接读）。',
        `audit-cross.md 是硬门槛：没落盘、或那四项核对有一项没交代，机器都会 400 拒收并点名缺哪一项，别只交前言。四项判定词与判定口径见 ${mergeTemplatePath}。`,
        '派审计小助手时把 auditScope 里的路径逐条给它（全部章 + 三份约束件 + 落盘路径），报告人自落——**你不转写那份报告**，那正是「全文回流 + 主笔转写」的搬运。',
        '改法一律派修复小助手：只改它点名的那几条，不通读全书、不顺手重写别的章；改完把新发现的点名追加进 audit-cross.md。',
        '重跑优先 `send_message` 唤醒原来那个跨章审计小助手（`list_agents` 按「跨章审计」label 召回），召不回才新派——重读一遍全书很贵。',
      ]
      break
    }
    case 'final': {
      // 票 walkthrough-fixes/32 · ADR-0027：终检改派 5 个小助手分查。**协调员不读正文**（§6.1 硬约束）——
      // 终检是全书体量最大、上下文余量最小的那个时点，让它亲自通读 book.md 等于把最贵的读放在最没余量的地方。
      // 三层归属在这条字符串里必须自洽：协调员**不读正文** / **仍能改点名的条目** / **styleCheck 逐条交代由分报告做**。
      brief.task = `最后检查**分头查，不要自己通读**（口径见 audit-and-testing.md §十「派 5 个小助手分查」那一节）：按那一节派 5 个上下文干净的小助手分查 工作区/book.md，各查各负责的范围（finalScopes 逐路写明了每一路的范围与**它自己该落的那一份报告**，派发时照表填），**派发那一刻你手里一章正文都不许有**，只收 5 份报告。五份**报告人自落**：每一路的小助手把「结论（通过／不通过）＋条目级点名＋落盘路径」写进它自己那一份（finalScopes[].report），**你不转写那份报告**——转写就是「全文回流 + 主笔搬运」，那正是这一层分派要治的病。五份各自出结论，**点名要到条目级**（「第 3 章有问题」不算点名，要指到具体哪一处）。**五份结论不合并、也不互相替代**：机器只拼一份**派生的条目并集**（finalSummary 那一件，只有条目、**它不出通过/不通过**——裁决仍在你手上）；每一份自己的结论与证据仍在它那份原文里，你要核就按汇总件各节「来源」那行去读对应那一份。你**只做汇总裁决**，不逐条回正文复核（核实是写那份报告的助手自己的活）；按点名的那几条**直接改**——只改点名的条目，不通读全书、不顺手重写别的章。改完把五份结论汇成一份自查报告（人话）随 stage-submit（stage=final, report=...）交工。${REPORT_WORDING_RULE}**风格线逐条交代由五份分报告各自做、你不读正文所以不做**：交工时要对**每一条**生效中的风格线（workbench_status 的 styleNotes 里 status 为 active 的那些）都有交代——把五份报告里各自交代的去向合并成一份 styleCheck:[{id, status, note?, chapter?}] 随交工一起交：adopted＝已落实（写清落实在哪章）、conflict＝与哪一章冲突（note 必写一句冲突理由）、superseded＝已不再适用；漏一条机器会拒收（哪一路没交代就唤醒那一路补，别自己凭印象编）。机器硬检查会兜底（乱码/章节数/该有的板块/不该用的词/章名全书唯一/无重复标题，判据来自已拍板的 style-spec/outline；**章名唯一性读大纲的章名，同一章里重名的小节才算重复——每章都有的同名板块（板位）不拦，只在自查报告里说明**）；全过后你在工作台等用户「认可」才算交付。机器还会**逐份点名**缺哪一份分报告——缺了就唤醒那一路补，不许自己凭印象写一份顶上（那正是「自发件不是契约件」）。`
      brief.counts = { chapters: (meta.outline?.chapters ?? []).length, sources: (meta.sources ?? []).length }
      // 票 11：五份分报告的**落点表**（范围 ＋ 逐份路径）——形状先例＝ merge 那一支的 `brief.auditScope`。
      // 路径逐字取自 `finalAuditReportRel`（落盘路径的单一出处，见 `src/domain-rules.js`），
      // 这里与方法论文档、派发模板、拒收文案一律只**引**它——各写一份就是四份会漂的清单。
      brief.finalScopes = FINAL_AUDIT_SCOPES.map(({ n, scope }) => ({ n, scope, report: finalAuditReportRel(n) }))
      // 票 `context-budget/12`：五份齐了之后**机器拼一份派生的条目并集**给协调员读（它不合并结论、
      // 不替代各自结论，也不出裁决）。形状先例＝ merge 的 `brief.auditScope`：一张表，逐字来自
      // `domain-rules`（路径单一持有）。⚠️ 拼装写盘是 `buildStageBrief` 里**唯一**的写副作用，
      // 理由写在 `refreshFinalAuditSummary` 上方：交办说明是协调员**读到汇总件的唯一入口**，
      // 拼在别处它就永远看不见（交工那一刻那次刷新只是保证指针新鲜）。
      const finalSummary = refreshFinalAuditSummary(projectId)
      brief.finalSummary = finalSummary === null
        ? { path: finalAuditSummaryRel(), ready: false, chars: null, unionSize: 0, items: [] }
        : { path: finalSummary.path, ready: true, chars: finalSummary.chars, unionSize: finalSummary.unionSize, items: finalSummary.items }
      brief.methodology = `${mtl('references/delivery-checklist.md')}\n\n${mtl('references/audit-and-testing.md')}`
      brief.outputs = [
        '维护 工作区/progress.md（每章一行：写完/审计/验货）',
        ...FINAL_AUDIT_SCOPES.map(({ n, scope }) => `${finalAuditReportRel(n)} —— 最后检查第 ${n} 路分报告（${scope}）：由那一路的小助手自落，协调员不转写`),
      ]
      // 这一句随五份齐不齐改写（读不到就不出现那半句——与「上下文占用」那句同一纪律）：
      // 齐了 ⇒ 汇总件已在盘上，**读它**；没齐 ⇒ 说清为什么没有，别让协调员去找一个不存在的文件。
      const finalSummaryHint = finalSummary === null
        ? `五份还没齐 ⇒ 机器拼不出那份条目并集（${finalAuditSummaryRel()} 还不在盘上）；五份齐了再领一次任务就能读到，别自己凭印象写一份顶上。`
        : `机器已把五份的**条目并集**拼在 ${finalAuditSummaryRel()}（${finalSummary.unionSize} 条，同一条只出现一次、不丢不重）：**读它**、按点到的条目改就够了，不用把五份全文都搬进上下文。它**只列条目、不出结论**——每份自己的结论与证据在它那份原文里。`
      // 票 32 · ADR-0027 决策 4：上下文余量**解绑**进终检——分派把书摘下去了，但五份报告回流、
      // 汇总、改点名条目仍在协调员身上，余量仍然是它该盯的数（读不到读数就整句不出现，同铺章那一族）。
      brief.hints = ['派完这 5 路之后别断线：五份齐了才进下一步；某一路超载就拆范围（或唤醒原助手补），别硬扛。', '五份报告只信「条目级点名」的那几条——点名不到具体位置的打回重做。', `五份报告的预算与落点：每份最终回复 ≤2K token，收「结论＋条目级点名＋落盘路径」（口径与逐类一档表见 audit-and-testing.md §九「回灌三件套」）——**五份各自落盘**（finalScopes 里逐份写明了路径，由写它的那一路自己落，**你不转写**）；压不进 2K 就按 §10.g 拆范围，或点名不到条目级时打回重做，不许靠把正文贴上来兜（那等于把分派省下的工作量原样搬回你身上）。`, finalSummaryHint]
      {
        const occupancyLine = contextOccupancyBriefLine(meta.session)
        if (occupancyLine !== null) brief.hints.push(occupancyLine)
      }
      // 终检被用户驳回后的修订意见（final-approve approved=false → 原地循环）。
      // 意见在 stage-submit final 通过时才销号（2026-08-27 grill 修订）：领任务改纯读、无副作用，
      // AI 重领任务/机器打回后重领都仍带意见；「重做意见只对本轮生效」语义不变（与 exploreRedoNote/goldRedoNote 同构）。
      if (meta.finalRedoNote != null) {
        brief.userFeedback = meta.finalRedoNote
        brief.hints = [...(brief.hints ?? []), `这是最后检查的修订：用户对整本书的意见是「${meta.finalRedoNote}」。按意见改整本（改 book.md）——仍按 §十「派 5 个小助手分查」那一节的分工：优先**唤醒原来那 5 路**去查改动处，够不着的再派新的干净上下文助手；改完五份齐了再汇总交工，不要自己通读全书。`]
      }
      break
    }
    default:
      brief.task = '（这个阶段的说明还没有补齐，先按状态机提示与用户确认该做什么。）'
  }
  // 票 22：不变量底线只对裁决里那四个阶段/关卡追加（explore / 关卡② / 关卡③ / chapters）。
  attachInvariants(stage)
  // 票 02：注入件集合＝清单里 `disclose` 命中的切片 ＋ 一页纸常驻 ＋ 状态迁移→节 ＋ 指针兜底
  //（**在 attachInvariants 之后**：不变量按 route 选节是票 22 的口径，它的位置与本三层无关）。
  brief.methodology = mountMethodology(
    brief.methodology ?? '',
    meta,
    { gateRejected: gateDecision !== null && gateDecision.status === 'rejected' },
    stepStageState(projectId, meta),
    onepagerLines,
    methodologyDocs,
  )
  // 票 02 第 1 层 · 这一步的几行登记（用户故事 13／19）：**注入件集合＝清单里 `disclose` 命中的切片**。
  // 随 brief 交出去的是结构化事实（路径 ＋ 角色 ＋ 它自己那一档 `disclose`），
  // `test-tool-discipline.mjs` 拿它与 `manifestRowsFor()` 对账，而不用反解 `engine.js` 源码。
  brief.registry = registryRowsFor(methodologyDocs)
  // 票 02 实现决策 11：**派发面也走同一张表**——给「该读的登记行 ＋ 该产出的登记行」，
  // 不再靠派发措辞（实测：explore 交办原文「要求详细摘录」让三份报告全文回灌，而同一机制
  // 另一本书三个精读全落盘——同一个机制、两本书两种表现，全凭自觉）。
  brief.dispatch = dispatchRegistryFor(stage, meta, methodologyDocs)
  // 派发那一半的**交办原文**：把两组登记行写进 hints，让主笔照它原样带给小助手
  // （六份派发模板里的「登记表口径」那一节说的是同一件事——派发时随活一起给它）。
  if (SUBAGENT_DISPATCH_STAGES.has(stage)) {
    const half = (rows, head) => (rows.length === 0 ? `${head}：这一步没有` : `${head}：${rows.map((r) => `${r.path}（${r.role}）`).join('、')}`)
    // ⚠️ 那两行路径是**包内相对路径**，而真正按它们去读的是**小助手**——所以根目录要随活一起发下去。
    // 不发根，小助手拿到 `resources/…` 就等于拿到一个没有基准的相对路径（票 `methodology-root-pointer/01`）。
    brief.hints = [...(brief.hints ?? []), `派小助手时按派发模板的「登记表口径」随活把那两行清单原样给它——**边界以那两行为准，不靠你的措辞**：${half(brief.dispatch.read, '你该读的登记行')}；${half(brief.dispatch.produce, '你该产出的登记行')}。**一并把方法论根目录（本机绝对路径）也给它**：${RESOURCES_DIR}——上面那些 resources/… 路径都相对它拼，小助手那边才读得到（只发相对路径＝它也得去搜盘）。`]
  }
  // 深改注入的重做意见：只交给被改段的那个阶段。
  if (meta.deepRedoNote != null) {
    const segOfStage = { explore: 'explore', gate: `gate-${gate ?? ''}`, outline: 'outline', gold: 'gold', chapters: 'chapters', merge: 'merge', final: 'final' }
    const mySeg = stage === 'gate' ? `gate-${gate}` : segOfStage[stage] ?? null
    // 先快照再消费：首个分支会 delete meta.deepRedoNote，后续分支不能再用它判段。
    const redo = meta.deepRedoNote
    if (mySeg !== null && redo.segment === mySeg) {
      brief.userFeedback = redo.note
      brief.hints = [...(brief.hints ?? []), `这是定点修改后的重做：用户这次的要求是「${redo.note}」。必须照着改；产物从零重做（旧版已留档）。`]
      updateMeta(projectId, (state) => { delete state.deepRedoNote })
    }
    if (mySeg !== null && redo.segment.startsWith('chapter-') && stage === 'chapters') {
      brief.userFeedback = redo.note
      brief.hints = [...(brief.hints ?? []), `定点修改后的重做：用户要求「${redo.note}」，从第 ${redo.segment.slice(8)} 章起重做。`]
      updateMeta(projectId, (state) => { delete state.deepRedoNote })
    }
  }
  const pendingIv = (meta.pendingInterventions ?? []).filter((i) => i.status === 'pending')
  if (pendingIv.length > 0) {
    brief.pendingInterventions = pendingIv.map((i) => ({ text: i.text, target: i.target ?? null, at: i.at }))
    brief.hints = [...(brief.hints ?? []), `有 ${pendingIv.length} 条用户留言要先处理（见 pendingInterventions），处理完用 workbench_act(action=intervene-done, id=...) 逐条销号，再继续手头的活。`]
  }
  // 票 22：随 brief 交出「这一份挂了哪些共用方法论文档」（去重后保序）——
  // 这是把「哪份文档该出现在哪个 brief」变成**可测事实**的那一步，不是给人看的新负担。
  brief.methodologyDocs = [...new Set(methodologyDocs)]
  return brief
}


/** POST /textbook/action 动作分发 */
// ─────────────────────────────────────────────────────────────────────────────
// 动作族 dispatch 表（架构候选 4 · ADR-0003 第二刀）：40 个顶层 case 按 9 个动作族
// 归组为 handler + action→handler 映射表；同文件 banner 分区、不拆物理文件。
// HTTP 层仍是唯一 external seam；族 handler 不对测试导出——现有 mkReq/mkRes fakes
// 即第二个 adapter。族边界 = 未来共享 domain module 的候选挂载点（见议题 01 协调注记）。
// ─────────────────────────────────────────────────────────────────────────────

/** 该关卡**盘上真实存在**的全部版次（`工作区/方案/关卡N-vM.md`，按版次升序）。
 *  判据＝磁盘实况——与 workbench-transitions/23 同一条（不是"最新"、更不是写死的 v1）。
 *  定点修改的归档名单照这条判据走才不会把修订件留在原地（dead-gates/18：留下就会被下一轮同名版次覆盖）。 */
function proposalFilesOnDisk(projectId, gate) {
  let names = []
  try { names = readdirSync(proposalDir(projectId)) } catch { return [] }
  const re = new RegExp(`^关卡${gate}-v(\\d+)\\.md$`)
  return names
    .map((name) => { const m = re.exec(name); return m === null ? null : { rel: `${PROPOSAL_DIR_REL}/${name}`, version: Number(m[1]) } })
    .filter((entry) => entry !== null)
    .sort((a, b) => a.version - b.version)
    .map((entry) => entry.rel)
}


/** 段 -> 深改影响：下游段 keys + 会被归档的产物（相对路径）。上游产物一律保留（GLM 审查 B）。 */
function deepAffected(projectId, meta, segKey) {
  const chapters = meta?.outline?.chapters ?? []
  const gn = goldN(meta)
  const pad = (n) => String(n).padStart(2, '0')
  // ⚠️ 这里的 `files` 是**书夹相对路径**（归档按它逐件 rename）⇒ 正文那一项取 `chapterRel`。
  // `audit-NN.md` 仍是本地的 `pad`——它属 audit 族（见 gold-audit-prompt.md），不是本章正文的形状。
  // ⚠️ 下面 `outlineDown` 里的 `chapter-${i + 1}` 是**段 key**、不补零、也不是路径——**不要**动它。
  //
  // ⚠️ **票 `walkthrough-2026-10/02`：这一章盘上真有的分片也要登记**（扫盘，不凭请求体）。
  // 分片是章正文的**输入**（机器按它拼）：定点修改到本章／金标准段时只归档正文、把分片留在原地，
  // 重做那一路写的若是**另一片**，机器就会把旧内容拼回正文里——旧稿回来了，而账上什么都没说。
  // 这与票 11 给「细目／报告」两族补登记是同一条教训（`archived` 是撤销回移的唯一依据）。
  const chapterFiles = (n) => [chapterRel(n), `工作区/audit-${pad(n)}.md`, ...chapterShardRelsOnDisk(projectId, n)]
  const allChapters = chapters.flatMap((_, i) => chapterFiles(i + 1))
  const goldFiles = ['工作区/style-spec.md', ...chapterFiles(gn)]
  const bookFiles = ['工作区/book.md', '工作区/preface.md']
  // ⚠️ 票 11：细目与报告是**目录族**，份数随材料数／固定五份变，写死清单装不下——
  // 所以这里登**实际盘上有的那一族每一件**（枚举形状与 `deepAffected` 别处的 `proposalFilesOnDisk`
  // 同款：扫盘、按声明形状过滤，不凭请求体）。**不登记的后果**：定点修改到 explore／final 段时，
  // `deep-modify.js` 的 `movable` 只认 `affected.files`，新目录里的件既搬不走、撤销时也回不来——
  // 而那份 `过程/存档/deep/<id>.json` 里的 `archived` 就是撤销回移的唯一依据（它会静默少登记）。
  const okReadingNumbers = okMaterialNumbers(meta.sources)
  const detailFiles = okReadingNumbers
    .map((n) => readingRel(n))
    .filter((rel) => existsSync(join(projectDir(projectId), ...rel.split('/'))))
  const reportFiles = [...FINAL_AUDIT_SCOPES.map(({ n }) => finalAuditReportRel(n)), finalAuditSummaryRel()]
    .filter((rel) => existsSync(join(projectDir(projectId), ...rel.split('/'))))
  const gates = [1, 2, 3]
  const proposals = (from) => gates.filter((g) => g >= from).flatMap((g) => proposalFilesOnDisk(projectId, g))
  const outlineDown = ['outline', 'gold', ...chapters.map((_, i) => `chapter-${i + 1}`), 'chapters-review', 'merge', 'final']
  switch (segKey) {
    case 'explore':
      return { downstream: ['explore', 'gate-1', 'gate-2', 'gate-3', ...outlineDown],
        files: ['工作区/explore.md', '工作区/knowledge-map.json', ...detailFiles, ...proposals(1), '工作区/outline.md', ...goldFiles, ...allChapters, ...bookFiles],
        reset: 'explore' }
    case 'gate-1': case 'gate-2': case 'gate-3': {
      const n = Number(segKey.slice(5))
      return { downstream: [segKey, ...outlineDown],
        files: [...proposals(n), '工作区/outline.md', ...goldFiles, ...allChapters, ...bookFiles],
        reset: 'gate' }
    }
    case 'outline':
      return { downstream: outlineDown, files: ['工作区/outline.md', ...goldFiles, ...allChapters, ...bookFiles], reset: 'outline' }
    case 'gold':
      return { downstream: ['gold', ...chapters.map((_, i) => `chapter-${i + 1}`), 'chapters-review', 'merge', 'final'],
        files: [...goldFiles, ...chapters.flatMap((_, i) => (i + 1 === gn ? [] : chapterFiles(i + 1))), ...bookFiles],
        reset: 'gold' }
    case 'merge':
      return { downstream: ['merge', 'final'], files: [...bookFiles, ...reportFiles], reset: 'merge' }
    case 'final':
      // ⚠️ 票 11：终检这一段的 `files` 原本是**空的**（那时还没有任何终检产物）。
      // 五份分报告落盘之后它不再是空的——不然定点修改到终检段时那些报告既不搬走、也回不来。
      return { downstream: ['final'], files: [...reportFiles], reset: 'final' }
    default: {
      const m = /^chapter-(\d+)$/.exec(segKey)
      if (m === null) return null
      const n = Number(m[1])
      return { downstream: [segKey, 'chapters-review', 'merge', 'final'],
        files: [...chapterFiles(n), ...bookFiles], reset: 'chapter' }
    }
  }
}


/** 段工作的首事件序号（事件截断点）：找不到返回 null（不截断，仅归档+重置）。 */
function deepStartSeq(projectId, segKey) {
  const events = readEvents(projectId)
  const m = /^chapter-(\d+)$/.exec(segKey)
  for (let i = 0; i < events.length; i += 1) {
    const e = events[i]
    if (segKey === 'explore' && e.type === 'textbook/phase-start' && e.data?.phase === 2) return e.seq
    if (segKey === 'explore' && e.type === 'textbook/stage-start' && e.data?.stage === 'explore') return e.seq
    if (/^gate-\d$/.test(segKey) && e.type === 'textbook/gate-proposal' && e.data?.gate === segKey.slice(5)) return e.seq
    if (/^gate-\d$/.test(segKey) && e.type === 'textbook/stage-start' && e.data?.stage === 'gate' && String(e.data?.gate) === segKey.slice(5)) return e.seq
    if (segKey === 'outline' && e.type === 'textbook/stage-start' && e.data?.stage === 'outline') return e.seq
    if (segKey === 'gold' && (e.type === 'textbook/stage-start' && e.data?.stage === 'gold')) return e.seq
    if (m !== null && /agent-start|agent-end|progress|review/.test(e.type)
      && String(e.data?.label ?? e.data?.text ?? '').includes(`第${m[1]}章`)) return e.seq
  }
  return null
}


/**
 * 票 13（spec 第 7 条 / 不变量 5「账本与 meta 同源」）：**账本被截断时同步意见集合**。
 *
 * 深改把时间线截断到该段起点之后，被删掉的 `textbook/review` 事件对应的意见必须从 `meta.pendingReviews`
 * 里一起去掉——否则会留下**孤儿意见**：界面点进去一条账本里已经没有对应事件的意见，而且它还会永远拦人
 * （按章交工只拦 `pending`，孤儿意见没人能销号）。
 *
 * 判据：意见 `r` 保留 ⇔ 截断后仍有一条 `textbook/review` 与它对应：
 *  - 带 id 的新账本（票 09 起）：`reviewId` 或 `id` 相等即对应（**同一章的新意见不会顶替旧意见**）；
 *  - 缺 id 的老意见：退化成「同章 ＋ 意见原文相等」。
 *
 * **上游章的意见不许被误删**：只有该章自己的 review 事件被截断、且没有别的对应事件时才移除——
 * 别的章一个都不碰。
 */
function syncPendingReviewsAfterTruncate(meta, events) {
  const reviews = meta?.pendingReviews
  if (!Array.isArray(reviews) || reviews.length === 0) return 0
  const reviewEvents = events.filter((e) => e.type === 'textbook/review')
  const kept = reviews.filter((r) => reviewEvents.some((e) => {
    const eventId = typeof e.data?.reviewId === 'string' ? e.data.reviewId : e.data?.id
    if (typeof eventId === 'string' && eventId !== '') return eventId === r?.id
    return e.data?.chapter === r?.chapter && String(e.data?.comment ?? '') === String(r?.comment ?? '')
  }))
  const dropped = reviews.length - kept.length
  meta.pendingReviews = kept
  return dropped
}

export {
  PROJECT_ID_RE,
  assertSessionOwned,
  goldN,
  paragraphReviewText,
  WAIVER_ITEMS,
  PHASE_LABELS,
  GATE_LABELS,
  STAGE_LABELS,
  stageLabel,
  // 这三个随 labels 簇一起搬走（票 depth-review-2026-10/10）。前两个是「这条路走完了」的人读
  // 提示，第三个是「写作规范里哪几项不许写」的硬约束——**都不是界面词的副本**：
  // `test-wording-invariants.mjs` 与 `test-contract-gap.mjs` 按名从 engine 取它们。
  EXPLORE_DONE_HINT,
  FINAL_CHECK_DONE_HINT,
  REPORT_WORDING_RULE,
  dshHome,
  projectsRoot,
  registryPath,
  readRegistry,
  writeRegistry,
  registerProject,
  sessionWorkspace,
  sanitizeFolderName,
  freeBookDir,
  projectDir,
  timelinePath,
  metaPath,
  processLogPath,
  logEntryText,
  readMeta,
  flushMeta,
  // ⚠️ writeMeta / metaCache / metaDirty / metaFlushHandle **刻意不导出**（ADR-0016 决策 2）。
  // ⚠️ 边界在拆子模块后**不再是「engine 之外」**，而是「**store 子模块之外，且持有 appendEvent
  // 的那个模块之外**」——appendEvent 是账高与最后动静时刻的唯一写入者，它至今仍住在 engine.js，
  // 必须够得着底层写入口。测试按**名字搜出**那个模块，不手写清单；appendEvent 日后搬进
  // engine/ledger.js 时这条判据不用改。
  //   两半都要占：store.js **导出** writeMeta（engine.js 要 import 它），而 engine 的**导出面**
  //   **不列**它——`test-ledger-seq-integrity.mjs` 的 `key in engine` 正是钉这一条。
  // 四个写入入口＝updateMeta（读→改→写）、createMeta（建档）、
  // appendEvent（记一笔：账高与最后动静时刻的唯一写入者）、rollbackLedger（合法回退的账本重写）。
  // 防回潮断言见 test-ledger-seq-integrity.mjs。
  updateMeta,
  createMeta,
  rollbackLedger,
  waived,
  announceText,
  announceToSession,
  noticeMessage,
  appendEvent,
  readEvents,
  listProjects,
  removeTree,
  trashProject,
  snapshotsDir,
  writeSnapshot,
  restoreSnapshot,
  foldGate,
  workDir,
  // 票 `context-budget/11`：细目目录与报告目录**同样只经 `./engine/paths.js` 解析**，
  // 再从这里再导出给动作层——动作层要的是「绝对路径 + 越界守卫已在那一层」，
  // 而 brief／文案要的**书夹相对**形状归 `domain-rules` 的 `readingRel`／`finalAuditReportRel`。
  // ⚠️ 这两个目录下的件**不在工作区根**，所以 `workFile(project, name)` 对它们无效（那会拼成
  // `工作区/<name>`）；要绝对路径一律 `join(detailDir(project), <基名>)`。
  detailDir,
  reportDir,
  // 票 `context-budget/13` 改名：四个旧段名逐字落地成 `工作区/`／`工作区/方案/`／`过程/存档/`／
  // `材料/转换稿/`（旧名的逐字清单见 ADR-0031 的「改名补记」与票 13 落地记录），
  // 解析函数同样只此一份、从这里再导出。
  // ⚠️ `deep-modify` 那一族原先**手写**了 `join(projectDir(p), <存档段名>, 'deep')`（两处），
  // 那正是「定义点之外的第二份」的典型——不改就会把深改存档写到旧目录、撤销时找不到那份存档。
  proposalDir,
  processDir,
  archiveDir,
  materialDir,
  convertedDir,
  // 老书读侧兜底（票 `context-budget/13` 的取舍已被维护者推翻，见 `.scratch` 票面第 3 节的改写）：
  // ① `bookRelOnDisk` ＝「规范形状 → 盘上真落点」，读通道与交办说明的指针都要它
  //    （`brief.references` 逐字写的是规范形状，而老书盘上是老名那一份）；
  // ② `legacyDirConflicts` ＝「两套名同时存在」的逐条点名——**新名优先的那一半不许静默**。
  bookRelOnDisk,
  legacyDirConflicts,
  workFile,
  writeWork,
  customPatternsDir,
  listCustomPatterns,
  updateStyleLineMirror,
  sealGoldStandard,
  sourcesDir,
  runners,
  gateWaiters,
  wakeMainAI,
  handoff,
  handoffAndDrive,
  chapterArtifacts,
  chapterDone,
  chapterHasSubmitEvent,
  chapterGateMiss,
  bindAnnounce,
  bindContextOccupancy,
  contextOccupancyBriefLine,
  disposeParent,
  getParent,
  projectRuntime,
  writeProposalDoc,
  proposeGate,
  proposeRevision,
  proposalFilesOnDisk,
  advance,
  resolveGateDecision,
  isRunning,
  runPhase1,
  runPhase2,
  countRejections,
  countProposals,
  gateApproved,
  runGate,
  runPhase3,
  runPhase5,
  scanScaffolding,
  stripLoaderRegion,
  specFingerprint,
  noteStyleSpecChange,
  parseStyleSpecList,
  styleSpecDeclaresNoExercises,
  runQualityChecks,
  recordAgentError,
  runLoop,
  kick,
  buildStageBrief,
  deepAffected,
  deepStartSeq,
  syncPendingReviewsAfterTruncate,
}
