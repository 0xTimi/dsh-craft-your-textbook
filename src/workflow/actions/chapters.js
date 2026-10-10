/**
 * 动作族模块（架构评审候选 3，2026-09-01 拆分）：actChapters
 * 从 src/workflow.js 平移（架构评审候选 3，2026-09-01）。
 *
 * ⚠️ 票 `workflow-seams/03`：interface 已收窄成**一个请求对象**
 * （`{ ctx, action, sessionId, project, body }`）并返回 `{status, json}`——
 * `_req` 与 `res` 两个传输参数都已从 interface 上消失（`res` 由 `handleAction` 那一次
 * `sendJson` 写出，落盘边界随它）。
 *
 * ⚠️ **本文件不许删、不许合、不许改名**：动作族 id ≡ 本文件名这一点被
 * `test-contract-action-catalog.mjs` 从**源码文本**锚定（它正则抠 `workflow.js` 的
 * `HANDLER_OF_FAMILY` 字面量表并要求 handler 绑定名匹配 `act[A-Z]\w*`）；
 * 另有 `test-context-vocabulary.mjs` 把「探查」钉在 `gates.js`、
 * `test-gate-write-points.mjs` 点名读本目录下的族文件。
 * ⇒ 改完之后本文件会变得**近乎空壳**——**那是承重件不是忘了删**。
 * 共享工具来自 ../engine.js。
 */
import {
  assertSessionOwned,
  // 票 `premature-announce/01`：源探查「盘上产物齐没齐」的唯一一份判据（置态/放行/交工三处共用）。
  exploreArtifactProblems,
  goldN,
  stageLabel,
  projectDir,
  readMeta,
  updateMeta,
  waived,
  appendEvent,
  workFile,
  writeWork,
  detailDir,
  reportDir,
  updateStyleLineMirror,
  sealGoldStandard,
  // ⚠️ 本文件**不再**直接调 `handoff`（票 `demo-flow-fidelity/05` 之后两处都走 `handoffAndDrive`）。
  //    `handoff` 不是不能用，而是这两处都属「交办之后得有人推」那一族——真书由被唤醒的主 AI 推，
  //    演示书没有主 AI，漏了补 kick 就停死在 `running`。判据与理由只在 engine 的 `handoffAndDrive` 一处。
  handoffAndDrive,
  chapterArtifacts,
  chapterDone,
  noteStyleSpecChange,
  writeSnapshot,
  proposeGate,
  proposeRevision,
  advance,
  countProposals,
  scanScaffolding,
  scaffoldResidue,
  stripLoaderRegion,
  stripChapterTitleHeading,
  specFingerprint,
  styleSpecDeclaresNoExercises,
  runQualityChecks,
  EXPLORE_DONE_HINT,
  FINAL_CHECK_DONE_HINT,
  kick,
  buildStageBrief,
} from '../engine.js'
import { familyOf, reject, accept } from '../action-runner.js'
// payload 字段词汇层（票 `deep-module-scan/18` 层一）。⚠️ 本文件三处「理由类」字段
//   （`volumeReason` / `goldChapterReason` / 抽查意见处置 `how`）**共用 `CHAPTER_SIDE_REASON_MAX`**——
//   它们真的是同一个「人读理由句」那一档；而 `label` / `detail` / 撤销备注各自是另一档。
import {
  textField,
  textFieldRaw,
  textCoerced,
  CHAPTER_SIDE_REASON_MAX,
  OUTLINE_POINTS_MAX,
  PROGRESS_LABEL_MAX,
  PROGRESS_DETAIL_MAX,
  STYLE_NOTE_REVOKE_NOTE_MAX,
} from './payload-fields.js'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { CHAPTER_PROGRESS_STAGES, normalizeTeachingFocus, normalizeKnowledgePointDifficulties, outlinePointsCoverage, chapterRel, chapterName, okMaterialNumbers, standingGate, knowledgeShardRel, knowledgeShardName, readingRel, readingName, FINAL_AUDIT_SCOPES, finalAuditReportName, finalAuditReportRel, placeholderWordingHits, exploreDepthTier, CHAPTER_SUGGESTION_MIN, CHAPTER_SUGGESTION_MAX, rawValueText } from '../../domain-rules.js'
import { artifactDataForChapter, artifactDataForGate, artifactDataForStage } from '../artifact-fields.js'
// 票 `walkthrough-2026-10/02`：章正文由机器从分片拼（机器是唯一写者）——拼装与拒收文案都只此一份。
import { assembleChapter, verifyChapterAtSubmit, chapterAssemblyReject } from '../chapter-assembly.js'
import { CROSS_AUDIT_TEMPLATE_REL, crossAuditRejectReason, judgeCrossAuditReport } from '../cross-audit.js'
import { refreshFinalAuditSummary } from '../final-audit-summary.js'
import { expectedKnowledgeMap, renderKnowledgeMap, shardShapeProblems } from '../knowledge-map-assembly.js'


/** 范例章审计文件名（NN 两位补零；机器身份词，勿改）。 */
function goldAuditName(n) {
  return `audit-${String(n).padStart(2, '0')}.md`
}


/** 票 `pipeline-wiring-gaps/13`：「机器改写了什么」提示里的**原值**展示——引号/JSON 化/截断
 *  与难度归一化消费 `domain-rules.rawValueText` 的**同一实现**（不各写一份「同一口径」）；
 *  本语境下 undefined 叫「没交」。 */
function describeRawValue(v) {
  return rawValueText(v, '没交')
}


/** 票 `pipeline-wiring-gaps/13`：一条机器改写记录 → 人读一行（账本 hint 用）。
 *  书级条目（goldChapter 族，`chapter: null`）不带章前缀。 */
function renderMachineEdit(edit) {
  return edit.chapter === null ? edit.detail : `第${edit.chapter}章：${edit.detail}`
}


/** 章审计 JSON 的唯一解析点；读取侧、交工验货与过程图谱摘要都从这里走。 */
function parseAuditJson(raw) {
  try {
    return { audit: JSON.parse(raw), error: null }
  } catch (error) {
    return { audit: null, error }
  }
}


/**
 * 读取一章的审计记录。文件不存在、读不到或 JSON 不合法时一律 null——
 * 调用方据真实形状决定拒收或「还没有检查结论」，不在这里猜。
 */
export function readChapterAudit(project, n) {
  try {
    const raw = readFileSync(chapterArtifacts(project, n).auditPath, 'utf8')
    return parseAuditJson(raw).audit
  } catch {
    return null
  }
}


/**
 * `/textbook/process` 下发的人读结论摘要，不把机器审计 JSON（含 matrix）整份搬出去。
 *
 * `issues[].text` 的产出契约已经要求用大白话写清「哪里、什么问题、为什么、怎么改」
 * （见 audit-agent/gold-audit prompt），而具体问题与改法是开放文本，无法用有限词表无损翻译；
 * 这里保留这句话本身，只裁成 `{ level, text }`，避免词典化后丢掉真正让用户判断的细节。
 * 老记录没有文件、形状不足、JSON 损坏，或用户已用 `audit-skip` 豁免本章检查时，一律 null。
 */
export function readChapterAuditSummary(project, n) {
  if (waived(project, 'audit-skip')) return null
  const audit = readChapterAudit(project, n)
  if (audit === null || typeof audit !== 'object' || Array.isArray(audit)
      || typeof audit.passed !== 'boolean' || !Array.isArray(audit.issues)) return null
  const issues = []
  for (const issue of audit.issues) {
    if (issue === null || typeof issue !== 'object' || Array.isArray(issue)
        || typeof issue.level !== 'string' || issue.level.trim() === ''
        || typeof issue.text !== 'string' || issue.text.trim() === '') return null
    issues.push({ level: issue.level, text: issue.text })
  }
  return { passed: audit.passed, issueCount: issues.length, issues }
}


/** 范例章审计「必读文档矩阵」固定的 5 个必读文件（书夹相对路径）。这份清单的**唯一出处**是
 *  `resources/references/subagent-prompts/gold-audit-prompt.md`（那儿另注明 `工作区/style-line.md` 不进矩阵）；
 *  这里只是它的机器判据，本票不许在别处再抄一份契约。
 *
 *  ⚠️ 矩阵里的 `file` 是**书夹相对路径**（`工作区/…`），且要与那份 prompt 里逐字列的示例对账 ⇒
 *  取 `chapterRel`（相对路径那一个），不是 `chapterName`。 */
function goldAuditFiles(n) {
  return [
    '工作区/explore.md',
    '工作区/knowledge-map.json',
    '工作区/outline.md',
    '工作区/style-spec.md',
    chapterRel(n),
  ]
}


/** 范例章审计被拒时的**可行动报错**（票 audit-matrix-contract/01 (a)）：一次说清三件事——
 *  ① 机器实际解析到的行（行键＋样例）② 契约要求的行形状与 5 个必读文件 ③ 哪一项不对（由 `detail` 说）。
 *  写入侧 `audit-submit` 与读取侧 `stage-submit(gold)` 共用这一个铸造点：两处不会各写一套说法。 */
function goldAuditError(n, detail, matrix) {
  const rows = Array.isArray(matrix) ? matrix : []
  const keys = []
  rows.forEach((row, index) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      keys.push(`第 ${index + 1} 行是 ${row === null ? 'null' : (Array.isArray(row) ? '数组' : typeof row)}`)
      return
    }
    for (const key of Object.keys(row)) if (!keys.includes(key)) keys.push(key)
  })
  const samples = []
  for (const row of rows.slice(0, 2)) {
    try { samples.push(JSON.stringify(row).slice(0, 160)) } catch { /* 序列化不了的行只报行键 */ }
  }
  const got = Array.isArray(matrix)
    ? `机器解析到 ${rows.length} 行，行键：${keys.length > 0 ? keys.join('、') : '（无）'}；样例：${samples.length > 0 ? samples.join(' ') : '（无）'}`
    : '机器没能解析出 matrix（整份文件不是合法 JSON，或顶层没有 matrix 键）'
  return `范例章审计不合格（${detail}）。① ${got}。② 契约要求 工作区/${goldAuditName(n)} 是严格 JSON：matrix 对 5 个必读文件各正好一行——${goldAuditFiles(n).join('、')}；每行形状 {file, quote}，quote 必须从对应文件里逐字复制一行原文。`
}


/** 范例章审计结论的机器判据——**写入侧与读取侧唯一的一份判据与报错**（票 01 (b)）。
 *  返回 `{ passed, rows, error }`：`error !== null` ＝ 拒收，两处都用它当那一条 400 文案。
 *  `passed !== true` 与普通章那支同口径：`audit-skip` 豁免可跳过；`gold-skip` 跳过的是「等用户拍板」
 *  那一步，不是验货豁免（三方一致的口径写在 `CONTEXT.md`「验货」）。
 *
 *  ⚠️ **为什么 export 出来**（票 `demo-flow-fidelity/07` 的影子对账）：它是 gold 那一关生产验货的
 *  **唯一实现**（`stage-submit(gold)` 与 `audit-submit` 两处都调它），而影子对账要把演示书盘上那份
 *  `工作区/audit-NN.md` 喂进**同一段**判据——在判据里另抄一份「看起来一样」的量法，正是
 *  `docs/测试信任边界.md` 总纲第 2 条点名「不算反证」的那种写法。先例：`handoffAndDrive` 就是为
 *  G4 那道门导出给判据用的。**导出不改任何一条判定的结果**（本文件行为一字未动，只是可见性）。 */
export function checkGoldAudit(project, n, raw) {
  const parsed = parseAuditJson(raw)
  if (parsed.error !== null) {
    return {
      passed: false,
      rows: 0,
      error: goldAuditError(n, `工作区/${goldAuditName(n)} 不是合法 JSON（${String(parsed.error instanceof Error ? parsed.error.message : parsed.error)}）`, null),
    }
  }
  const audit = parsed.audit
  const matrix = Array.isArray(audit?.matrix) ? audit.matrix : []
  if (matrix.length === 0) {
    return { passed: false, rows: 0, error: goldAuditError(n, '缺文档矩阵（matrix 缺失、为空或不是数组）', matrix) }
  }
  for (const rel of goldAuditFiles(n)) {
    const row = matrix.find((m) => m !== null && typeof m === 'object' && m.file === rel)
    if (row === undefined) {
      return { passed: false, rows: matrix.length, error: goldAuditError(n, `matrix 里没有「${rel}」那一行（每行要用 file 键写文件相对路径）`, matrix) }
    }
    const full = join(projectDir(project), rel)
    if (!existsSync(full)) {
      return { passed: false, rows: matrix.length, error: goldAuditError(n, `必读文件 ${rel} 还没写出来（先把它写出来，再验审计矩阵）`, matrix) }
    }
    const text = readFileSync(full, 'utf8')
    if (typeof row.quote !== 'string' || row.quote.trim() === '' || !text.includes(row.quote)) {
      return { passed: false, rows: matrix.length, error: goldAuditError(n, `「${rel}」那一行的 quote 对不上（quote 必须从该文件里逐字复制一行原文）`, matrix) }
    }
  }
  if (audit.passed !== true && !waived(project, 'audit-skip')) {
    return { passed: false, rows: matrix.length, error: goldAuditError(n, 'passed 不是 true（该章审计还有没解决的问题：先按审计意见修订、重新审计）', matrix) }
  }
  return { passed: audit.passed === true, rows: matrix.length, error: null }
}


/** 动作族 · 章节执行与审阅：'audit-submit' / 'review' / 'stage-submit' / 'stage-brief' / 'progress'。 */
export const actChapters = familyOf('chapters', async ({ ctx: ctx, action: action, sessionId: sessionId, project: project, body: body }) => {
  /** 拒收入账（票 01 (d)，票 02 铺满交工类）：**交工被机器拒收**时一律落一条账本事件（含 stage 与原因）——
   *  账本与工作台读得到「交工被拒：<原因>」，不再只活在对话轨迹里。
   *  票 02 的范围：这一族（A 类 · 业务事实）＝ `stage-submit` 各阶段分支里判「这一阶段该交出来的东西」
   *  的那 20 处 + 票 01 落下的 gold 5 处，一律走这个助手（`stage` 实参取 canonical 阶段词）。
   *  参数校验那一族（B 类 · 调用方自己把请求写错：章节号/意见正文/`body.chapter` 范围/未知阶段）照旧裸
   * `reject(400, …)`（**不落这条账**）——把它们记成「交工被拒」会让工作台事件行说假话。
   *
   * ⚠️ 票 03 第 2 步：**25 个调用点全部带 `return`**。这在 helper 内部直接写响应时不是必需的
   * （隐式契约：helper 自己回），改成返回回包后每个调用点都必须显式 return，否则拒收路径不回包。
   * 改这个 helper 之前先数调用点。 */
  const rejectSubmit = (stage, reason) => {
    appendEvent(project, 'textbook/submit-rejected', { stage, reason })
    return reject(400, reason)
  }
  switch (action) {
    case 'review': {
      // 用户抽查提意见（铺章阶段）：记录 → 主 AI 处理。
      assertSessionOwned(project, sessionId)
      const rvMeta = readMeta(project)
      if (rvMeta === null) throw new Error(`unknown project ${JSON.stringify(project)}`)
      const n = Number(body.chapter)
      const chapters = rvMeta.outline?.chapters ?? []
      const comment = typeof body.comment === 'string' ? body.comment.trim() : ''
      if (!Number.isSafeInteger(n) || n < 1 || n > chapters.length) {
        return reject(400, '章节号不合法')
      }
      if (comment === '') {
        return reject(400, '请写下你的意见')
      }
      if (rvMeta.phase !== 5) {
        return reject(409, '现在不在写完整本的阶段，没法直接在章节卡写意见；可以在对话里告诉 AI，它会帮你安排')
      }
      // 票 09：入账必须自带身份与「待处置」——没有 id 就没有可点名/可撤销的对象，
      // 没有 status='pending' 就没有「未处置」这个机器判据认得的态（id 造型照 gold.js 的既有做法）。
      const opinionId = `pr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      // 意见入账 + 置态一次收进改法（当场新读）：原先拿请求开头那份状态整份写回，会把中途
      // 「记一笔」刚推进的账高带回旧值（票 02 的形状）。`inChaptersReview` / `pendingAfter` 取改法里的值。
      let inChaptersReview = false
      let pendingAfter = null
      updateMeta(project, (state) => {
        const reviews = Array.isArray(state.pendingReviews) ? state.pendingReviews : []
        reviews.push({
          id: opinionId,
          chapter: n, comment, at: Date.now(), status: 'pending',
        })
        state.pendingReviews = reviews
        // 过目态下提意见：转回 running 并交办修订（改完回来继续过目）。
        inChaptersReview = state.status === 'awaiting-chapters-review'
        state.status = 'running'
        if (inChaptersReview) {
          state.pendingStage = null
          state.chaptersReviewed = false
        }
        pendingAfter = state.pendingStage
      })
      const title = chapters[n - 1]?.title ?? `第${n}章`
      // 事件带 `reviewId`（与 meta.pendingReviews 的 id 同源）：深改截断账本时要按它把被删事件对应的
      // 意见一并去掉（票 13，engine 的 syncPendingReviewsAfterTruncate），没有这个字段就只能靠
      // 「同章 + 原文」猜，同一章提两次一样的意见就会误留孤儿。
      appendEvent(project, 'textbook/review', { reviewId: opinionId, chapter: n, title, comment })
      if (inChaptersReview) {
        // 过目态提意见＝把书从「等你过目」翻回「我正在做」并交办修订。**这一处原先漏了演示书那一半**：
        // `handoff` 对 demo 书恒返回「没叫醒」（`wakeMainAI` 对 `meta.demo === true` 早退），
        // 而 demo **没有主 AI 可唤醒** ⇒ 书停在 `running` ＋ `pendingStage='chapters'`，谁都不推，
        // 直到用户自己猜到再点一次「继续／重试」（那条路走 `convert.js` 的 `handoffAndDrive`，
        // 所以能恢复，但那不是用户猜得到的一步）。改走引擎那一处（票 `demo-flow-fidelity/05`）：
        // 真书照旧「只唤醒、不额外 kick」（判据是 `woke === false && meta.demo === true`），
        // demo 书补一趟 kick，由演示占位通道自己把下一步做出来。
        handoffAndDrive(ctx, project, 'chapters')
      } else {
        const pending = pendingAfter
        if (pending === null || pending === undefined || pending === 'chapters') {
          // 机器空闲或正在铺章：唤醒/让主 AI 接着处理意见（交工前必查意见）。
          // ⚠️ 只有**机器空闲**（`pending` 为空）这一支才交办——`pending === 'chapters'` 说明铺章
          // 已经交办过（主 AI 接工时会查意见），再交一次就是重复唤醒。
          // 这一支与上面同族：交办之后同样得有人推，所以同样走 `handoffAndDrive`。
          // 可达性（本票实施时逐条读过，票面 Answer 记了依据）：`convert.js` 的「重新推状态机」
          // 那一支会留下 `status='running'` ＋ `pendingStage=null`；此刻用户在章节卡写意见就走这里
          //（章卡那颗「✍️ 写意见」只按「这一章有产物 ＋ 书有骨架」渲染，不按 `status`）。
          if (pending === null || pending === undefined) handoffAndDrive(ctx, project, 'chapters')
        }
      }
      // 若正在合并/终检：不打断；主 AI 交工前会查 workbench_status 里的抽查意见并先处理。
      return accept({ project, chapter: n, queued: true })
    }
    case 'review-revoke': {
      // 票 09（4）+ 票 10 的前置：用户翻案——把一条已被处置的抽查意见退回「未处置」。
      // 写回 'pending'（**不是** 'revoked'）：pending 是机器按章交工唯一拦的那个态，
      // 退回 pending 才谈得上「书被重新拦回」；写 revoked 等于把这条意见永久作废，翻案就成了空话。
      assertSessionOwned(project, sessionId)
      const rkMeta = readMeta(project)
      if (rkMeta === null) throw new Error(`unknown project ${JSON.stringify(project)}`)
      const review = (Array.isArray(rkMeta.pendingReviews) ? rkMeta.pendingReviews : [])
        .find((r) => r.id === body.reviewId)
      if (review === undefined) {
        return reject(404, '没有这条抽查意见')
      }
      // 翻案只改这一条意见，走单一入口在**当场新读**的状态上改。原先这里还自己写了一次
      // `updatedAt`——「最后动静时刻」只归「记一笔」所有（ADR-0016 决策 1）；本动作不记事件，故不动它。
      let revoked = null
      updateMeta(project, (state) => {
        revoked = (Array.isArray(state.pendingReviews) ? state.pendingReviews : [])
          .find((r) => r.id === review.id)
        if (revoked === undefined) return
        revoked.status = 'pending'
        delete revoked.how // 翻案即撤销「怎么处置的」这句交代，重新处置时再写一条新的
      })
      if (revoked === undefined || revoked === null) {
        return reject(404, '没有这条抽查意见')
      }
      return accept({ project, reviewId: revoked.id, chapter: revoked.chapter, review: revoked })
    }
    case 'chapter-assemble': {
      // 票 `walkthrough-2026-10/02`（走查 A10「同一文件多写者」的裁决）：**机器拼章正文**。
      //
      // 协议（交办说明与派发模板都照这一段说）：写作小助手**只落分片** `工作区/分片/chapter-NN-MM.md`
      // （一路一个号，谁也不碰别人的分片）；分片落齐之后主笔叫**这一步**，机器按分片号升序拼出
      // `工作区/chapter-NN.md`；审计小助手读的就是机器拼出来的那一份。
      //
      // ⚠️ 为什么必须由主笔显式叫一次（而不是只在交工那一刻拼）：审计小助手在**交工之前**就要读正文，
      // 而票 22 的新鲜度闸门比的是正文与检查记录的 mtime——晚拼一步，检查记录就当场变成「审的是旧稿」。
      // 所以「拼」与「验收」是两步：这一步只管把正文做出来（盘上那份若不是拼装件就覆盖它，
      // 因为它的职责不是验收），验收在 `stage-submit`。
      assertSessionOwned(project, sessionId)
      const caMeta = readMeta(project)
      if (caMeta === null) throw new Error(`unknown project ${JSON.stringify(project)}`)
      const caN = Number(body.chapter)
      const caChapters = caMeta.outline?.chapters ?? []
      if (!Number.isSafeInteger(caN) || caN < 1 || caN > caChapters.length) {
        return reject(400, 'chapter 参数不合法（需要第几章的编号）')
      }
      if (caMeta.pause !== null && caMeta.pause !== undefined) {
        return reject(409, '已在暂停，请先点继续（▶）再拼章正文')
      }
      const ca = assembleChapter(project, caN)
      if (ca.status !== 'ok') {
        return rejectSubmit('chapters', chapterAssemblyReject(ca, caN))
      }
      // 票 `walkthrough-2026-10/02` · **账上要有痕**（code-review 规格轴 C2）：这一步会写掉
      // `工作区/chapter-NN.md`，而它的 **mtime 是票 22 那道新鲜度闸门的输入**——「审的是旧稿」
      // 这类事后追问必须能在账本里查到「什么时候、机器把哪一章重拼了一次」。
      // ⚠️ **只有真写了才落账**（`ca.wrote`）：内容逐字相同时这一步一个字节都不动，
      // 那时落一条「机器拼了」的账就是假话（同一份分片被主笔来回叫几次就会刷出一串假动作）。
      // ⚠️ **复用 `textbook/hint` 这个碎语通道，不新立事件类型**：与 B69（宿主提问卡作答）、
      // B71／B72（材料的删除／补传）同一条既有惯例——「新增事件类型要同动 EVENT_TYPES /
      // EVENT_META / logEntryText 三处」，而这件事实就是一句留痕。结构化事实一并进 `data`，
      // `timeline.jsonl` 里查得到（`machine` 那一枚同时在 `engine.js` 的 `announceText` 里
      // 让这一条**不播报**：主笔自己叫的一步，不值得在对话里再回一遍）。
      if (ca.wrote === true) {
        appendEvent(project, 'textbook/hint', {
          machine: 'chapter-assemble',
          chapter: caN,
          path: ca.rel,
          shards: ca.shards,
          wrote: true,
          overwroteExternalWrite: ca.overwroteExternalWrite === true,
          text: ca.overwroteExternalWrite === true
            ? `🧩 第 ${caN} 章正文由机器从 ${ca.shards} 片分片拼出（${ca.rel}）——盘上原本那一份不是拼装件，已由机器覆盖（机器之外有人在写这份文件）`
            : `🧩 第 ${caN} 章正文由机器从 ${ca.shards} 片分片拼出（${ca.rel}）`,
        })
      }
      return accept({ project, chapter: caN, path: ca.rel, shards: ca.shards, wrote: ca.wrote, overwroteExternalWrite: ca.overwroteExternalWrite })
    }
    case 'audit-submit': {
      // 写入侧校验（票 01 (b)）：主笔 AI 拿到范例章审计结论后**先交这里**，机器当场用与交工路径
      // **同一份**判据验形状（5 个必读文件各一行 `{file, quote}`、`quote` 逐字、`passed` 判定），
      // 不合格立刻把可行动报错给回去（并入账）——不拖到「这一关交工」那一刻。
      assertSessionOwned(project, sessionId)
      const asMeta = readMeta(project)
      if (asMeta === null) throw new Error(`unknown project ${JSON.stringify(project)}`)
      const asN = goldN(asMeta)
      const asName = goldAuditName(asN)
      const inline = typeof body.auditJson === 'string' && body.auditJson.trim() !== ''
      const asPath = workFile(project, asName)
      const asRaw = inline
        ? body.auditJson
        : (existsSync(asPath) ? readFileSync(asPath, 'utf8') : '')
      if (asRaw.trim() === '') {
        return rejectSubmit('gold', `没拿到范例章审计结论：工作区/${asName} 不在或为空，也没带 auditJson 正文——先让审计小助手把结论落盘（或把 JSON 正文带来）再提交`)
      }
      const asVerdict = checkGoldAudit(project, asN, asRaw)
      if (asVerdict.error !== null) {
        return rejectSubmit('gold', asVerdict.error)
      }
      // 带了正文就由机器落盘：验过的就是落盘的那一份（写入侧的唯一写入者），中间不再经手。
      if (inline) writeWork(project, asName, asRaw)
      return accept({ project, chapter: asN, rows: asVerdict.rows, passed: asVerdict.passed })
    }
    case 'stage-submit': {
      // 主 AI 交工：逐阶段验货，验过才放行（AI 说做了不算，机器验过才算）。
      assertSessionOwned(project, sessionId)
      const subMeta = readMeta(project)
      if (subMeta === null) throw new Error(`unknown project ${JSON.stringify(project)}`)
      if (subMeta.pause !== null && subMeta.pause !== undefined) {
        return reject(409, '已在暂停，请先点继续（▶）再交工')
      }
      const stage = String(body.stage ?? '')
      if (subMeta.pendingStage !== stage) {
        return reject(409, `机器现在等的是「${stageLabel(subMeta.pendingStage, subMeta.pendingGate ?? null) ?? '无'}」，不是「${stage}」`)
      }
      switch (stage) {
        case 'explore': {
          // ── 盘上产物那一面**不再是本文件自己的一套检查**（票 `premature-announce/01`）──────
          // 它与「置态」「放行」两处共用 `engine.exploreArtifactProblems`：判据只有一份、报错措辞
          // 也只有一份（下面这条 400 的文案逐字取自那一处，`test-explore-handoff-content.mjs` 锚着它）。
          // 本文件在这里只做**交工那一刻才有答案**的那几件：书级两件、章数区间、合并件的知识点、材料分量。
          const { problems: artifactProblems, shards } = exploreArtifactProblems(project, subMeta, { atSubmit: true })
          if (artifactProblems.length > 0) return rejectSubmit('explore', artifactProblems[0])
          // 书级两件只能由主笔产出（机器不替它编）。teachingFocus 契约是 [string]，AI 偶发写对象
          // 数组——在这里归一化成纯字符串再拼（落盘 / 摘要 / 页面三处看到的都是同一份干净形状，
          // 2026-09 修复 [object Object] 的那条口径照旧）。
          // ⚠️ `teachingFocus` 的**在场检查是新事、不是「照旧」**：旧代码只验 knowledgePoints 与
          // chapterSuggestion，从未验过它（票面 Comments 2026-10-06 第 2 条点名了这处不一致）。
          const teachingFocus = normalizeTeachingFocus(body.teachingFocus)
          if (teachingFocus.length === 0) {
            return rejectSubmit('explore',
              '没拿到 teachingFocus：书级的教学重点/难点只能由你产出（纯字符串一条一句，如「重点：分数运算」），交工时带 teachingFocus 参数。')
          }
          const chapterSuggestion = Array.isArray(body.chapterSuggestion) ? body.chapterSuggestion : []
          if (chapterSuggestion.length === 0) {
            return rejectSubmit('explore',
              '没拿到 chapterSuggestion：书级的章节建议只能由你产出（非空数组，4-10 章），交工时带 chapterSuggestion 参数。')
          }
          // 票 07 · pipeline-wiring-gaps：章数契约区间此前只写在交办里（「4-10 章」），机器从不查——
          // 现在超区间即拒。区间常量在 `domain-rules`（交办说明与这里同一份，不各抄一份「4-10」）。
          if (chapterSuggestion.length < CHAPTER_SUGGESTION_MIN || chapterSuggestion.length > CHAPTER_SUGGESTION_MAX) {
            return rejectSubmit('explore',
              `chapterSuggestion 章数超出契约区间：${chapterSuggestion.length} 章（契约 ${CHAPTER_SUGGESTION_MIN}-${CHAPTER_SUGGESTION_MAX} 章）——把章节建议收敛到 ${CHAPTER_SUGGESTION_MIN}-${CHAPTER_SUGGESTION_MAX} 章再交工。`)
          }
          const merged = expectedKnowledgeMap(shards, { teachingFocus, chapterSuggestion })
          // 合并件缺 knowledgePoints：今天只可能来自**分片**（合并件已不是主笔交的输入）——
          // 有片就必须有知识点，缺了要点名是哪几片。零片（**零源旧书**没有材料；演示书也走这一路，
          // 但它有 1 份转换完成的源、只是没有分片——票 08 ③ 订正过的旧措辞）时不要求：
          // 那时没有分片可拼，凭空要求一份知识点等于要一份不存在的东西（与「不能凭空要片」同一口径）。
          if (shards.length > 0 && merged.knowledgePoints.length === 0) {
            return rejectSubmit('explore',
              `机器按分片拼出来的知识地图没有 knowledgePoints（每份转换完成的材料那一片都要带这一份的知识点）：${shards.map((shard) => knowledgeShardRel(shard.n)).join('、')}`)
          }
          // ── 票 17 · pipeline-wiring-gaps · ADR-0023：**材料分量**（standing）逐源表态 ──
          // 「这份材料在什么问题上说了算、在什么问题上不算数」由主笔 AI 逐源写一句声明，落
          // 各分片 materials[].standing（结构化字段是唯一出口——gate/gold 两关读不到 explore.md
          // 散文，交办里散文那份「权威层级」要求已退役）。四条闸门（G1 逐源非空 / G2 单源豁免 /
          // G3 去重不足只记 hint / G4 真题源必须表态有无配套答案与评分标准——机器只验「表态了
          // 没有」不验「带没带」，能力上限写在那份判据的注释里）的判据与反例口径都在
          // `domain-rules.standingGate` 单点，这里只接线：rejects 拒收、hints 账本告知。
          const standing = standingGate(subMeta.sources, merged.materials)
          if (standing.rejects.length > 0) {
            return rejectSubmit('explore', standing.rejects.join('；'))
          }
          // 机器是合并件的**唯一写入者**：它在这一刻才诞生（主笔预先留在盘上的那一份不是输入——
          // 「同一份内容搬两遍」正是本票要收口的那件事）。
          // ── 票 06 · pipeline-wiring-gaps：knowledgePoints[].difficulty **出域值归一化写回** ──
          // 与上面 teachingFocus 归一化同一先例（同文件、同一段交工）：那份契约写了形状所以能归一化，
          // 这份此前没有。取值域与别名表只在 `domain-rules`（登记单点）；机器只动 difficulty 一键，
          // 认不出的没收成「无难度」（合法形状）、其余字段照旧只搬不写。**不阻断**（难度是初判
          // 展示档位，不是内容真伪），但件件告知：回包带 `difficultyEdits` 全量、非空另发一条账本
          // hint（用户在探查确认卡拍板之前看得到）——口径照票 13 的 machineEdits/hint 先例，
          // 不另造第二套「机器改了什么」的呈现。
          // ⚠️ 这一步之后合并件＝分片 ＋ 书级两键 ＋ **difficulty 归一化**的确定函数；票 17 那条
          // 「重拼逐字相同」的判据其夹具难度都在域内，归一化不咬它（窄处已在判据夹具注明）。
          const { points: mergedPoints, edits: difficultyEdits } = normalizeKnowledgePointDifficulties(merged.knowledgePoints)
          merged.knowledgePoints = mergedPoints
          writeWork(project, 'knowledge-map.json', renderKnowledgeMap(merged))
          updateMeta(project, (state) => {
            state.pendingStage = null
            state.pendingGate = null
            state.status = 'awaiting-explore'
            delete state.exploreRedoNote // 重做意见只对本轮探查生效
          })
          appendEvent(project, 'textbook/agent-end', { label: '源探查', outcome: 'ok', ...artifactDataForStage('explore') })
          if (difficultyEdits.length > 0) {
            appendEvent(project, 'textbook/hint', {
              text: `🧭 知识点难度有出域值，机器已按取值域（基础/重点/难点/进阶）归一化并写回 工作区/knowledge-map.json：${difficultyEdits.map((e) => e.detail).join('；')}`,
            })
          }
          // 票 17 · G3 的放行告知：去重不足不拒交，但用户在探查确认卡拍板之前要看得见
          //（口径照票 13 的 hint 先例，不另造呈现）。
          if (standing.hints.length > 0) {
            appendEvent(project, 'textbook/hint', {
              text: `⚖️ 材料分量提醒：${standing.hints.join('；')}`,
            })
          }
          appendEvent(project, 'textbook/hint', {
            text: EXPLORE_DONE_HINT,
          })
          return accept({ project, stage: 'explore', difficultyEdits, standingHints: standing.hints })
        }
        case 'gate': {
          const gate = subMeta.pendingGate ?? '1'
          const title = typeof body.title === 'string' ? body.title.trim() : ''
          const summary = typeof body.summary === 'string' ? body.summary.trim() : ''
          let detail = typeof body.detail === 'string' ? body.detail.trim() : ''
          if (title === '' || summary === '' || detail === '') {
            return rejectSubmit('gate', '方案不完整（需要 title 标题 / summary 人话摘要 / detail 完整方案）')
          }
          // 票 `walkthrough-2026-10/06` 现象一（2026-10-03 清单 A3）：**非空还不够**——
          // 那一次三个字段都非空，内容却是「测试标题／测试摘要。／测试正文是否可提交（稍后重发完整版）」，
          // 一张要用户拍板的正式卡上摆了占位件。所以这里再咬一口**内容真实性**：
          // 正式拍板卡的入参来自真实方案，命中测试/占位词表就打回。
          //
          // ⚠️ 判的是 **AI 交上来的那三段原文**（排在指针内联**之前**）：内联进来的文件正文是机器读的，
          // 而「AI 自己写了什么」才是这条纪律的对象；顺序反了会让「交一句指针、正文里全是占位」
          // 逃过闸门（内联发生在下面）。
          // ⚠️ 打回要**可行动**（票面 `:22`）：逐条点名「哪个词、在哪个字段」，只说「方案不合法」
          // 等于让 AI 去猜。词表只此一份（`domain-rules.PLACEHOLDER_WORDING`），这里一个字都不手抄。
          const placeholderHits = placeholderWordingHits({ title, summary, detail })
          if (placeholderHits.length > 0) {
            const named = placeholderHits.map((h) => `${h.field}命中「${h.word}」`).join('、')
            return rejectSubmit('gate',
              `方案里有测试/占位文本（${named}）——正式拍板卡的入参来自真实方案，不许出现测试/占位字样。把这几处写成真内容再交。`)
          }
          // 指针内联：AI 偶尔会把完整方案写进自选文件、detail 只留一句「见文件」。
          // 用户不该去文件夹翻文件——机器检测到指针样 detail 就把被指文件正文内联进来。
          const pointer = /(?:见|详见)[^。\n]{0,20}?((?:工作区\/)?proposal-[\w.-]+\.md)/.exec(detail)
          if (pointer !== null) {
            const rel = pointer[1].startsWith('工作区/') ? pointer[1] : `工作区/${pointer[1]}`
            const full = workFile(project, rel.replace(/^工作区\//, ''))
            if (existsSync(full)) {
              const fileText = readFileSync(full, 'utf8').trim()
              if (fileText !== '') detail = `${fileText}\n\n---\n（原摘要：${summary}）`
            }
          }
          const version = countProposals(project, gate) + 1
          updateMeta(project, (state) => {
            state.pendingStage = null
            state.pendingGate = null
          })
          appendEvent(project, 'textbook/agent-end', {
            label: `设计提案·第${gate}关${version > 1 ? `·修订v${version}` : ''}`, outcome: 'ok',
            ...artifactDataForGate(gate, version),
          })
          if (version === 1) proposeGate(project, gate, title, summary, detail)
          else proposeRevision(project, gate, version, title, summary, detail)
          return accept({ project, stage: 'gate', gate, version })
        }
        case 'outline': {
          let chapters = Array.isArray(body.chapters) ? body.chapters : null
          if (chapters === null && typeof body.chaptersJson === 'string' && body.chaptersJson.trim() !== '') {
            try { chapters = JSON.parse(body.chaptersJson) } catch { chapters = null }
          }
          if (chapters === null || !Array.isArray(chapters) || chapters.length === 0) {
            return rejectSubmit('outline', '章节骨架不能为空（需要 chapters 数组或 chaptersJson JSON 字符串）')
          }
          // ── 票 `pipeline-wiring-gaps/13`：outline 交工的机器改写不再静默 ──
          // 证据（verification.md 第 7 条）：下面每个字段的归一化原先都是「机器放行、用户无感」——
          // 字数不足静默补 6000、points 超上限/强转/空白项静默丢弃、goldChapter 越界静默回落并清空理由。
          // 口径按票 `01`（points 口径裁决，2026-09-29 用户拍板）：**缺失放行、失配「放行并记一条
          // 人话提示」、不阻断**——所以这里照旧归一化（入账值与旧口径逐字一致），但每一处改动都记进
          // `machineEdits`：交工回包带全量（提交结果能看出这一章被机器改过什么），非空时另发一条
          // 账本 hint（用户在确认骨架之前看得到）。
          // ⚠️ **不算改写、不记录**的两种：①字段**缺失**落空缺省（票 01 裁决「缺失放行」，`points`
          // 的 `?? []` 更是 2026-08-19 契约里有意写的）；②归一化后与原值严格相等（没改东西就不是改写）。
          const machineEdits = []
          const cleaned = []
          for (let i = 0; i < chapters.length; i += 1) {
            const chapter = chapters[i]
            const title = String(chapter?.title ?? '').trim()
            if (title === '') { return rejectSubmit('outline', '章节缺少 title') }
            const chapterNo = i + 1
            // ① targetWords（票 13）：不是 ≥500 的数字时补 6000——照样补，但告知补成了什么。
            const rawWords = chapter?.targetWords
            const wordsNum = Number(rawWords)
            let targetWords
            if (Number.isFinite(wordsNum) && wordsNum >= 500) {
              targetWords = Math.round(wordsNum)
              if (targetWords !== rawWords) {
                machineEdits.push({ chapter: chapterNo, field: 'targetWords', detail: `目标字数 ${describeRawValue(rawWords)} 被按 ${targetWords} 收下` })
              }
            } else {
              targetWords = 6000
              machineEdits.push({ chapter: chapterNo, field: 'targetWords', detail: `目标字数 ${describeRawValue(rawWords)} 不是不小于 500 的数字，机器按 6000 收下` })
            }
            // ② points（票 13②④；超上限的处置按票 01 裁决）：非数组落 `[]`（缺失放行；**交了但
            //    形状不对**要告知）、非字符串强转、空白项丢弃、超上限截断——件件告知。
            const rawPoints = chapter?.points
            let points
            if (!Array.isArray(rawPoints)) {
              points = []
              if (rawPoints !== undefined && rawPoints !== null) {
                machineEdits.push({ chapter: chapterNo, field: 'points', detail: `points ${describeRawValue(rawPoints)} 不是数组，机器按「无知识点」收下` })
              }
            } else {
              const nonStringCount = rawPoints.filter((pt) => pt !== null && pt !== undefined && typeof pt !== 'string').length
              let pts = rawPoints.map((pt) => String(pt ?? '').trim())
              const blankCount = pts.filter((pt) => pt === '').length
              pts = pts.filter((pt) => pt !== '')
              if (nonStringCount > 0) {
                machineEdits.push({ chapter: chapterNo, field: 'points', detail: `有 ${nonStringCount} 条知识点不是文本，机器已按文本收下` })
              }
              if (blankCount > 0) {
                machineEdits.push({ chapter: chapterNo, field: 'points', detail: `有 ${blankCount} 条知识点是空白，机器已丢弃` })
              }
              if (pts.length > OUTLINE_POINTS_MAX) {
                const dropped = pts.slice(OUTLINE_POINTS_MAX)
                pts = pts.slice(0, OUTLINE_POINTS_MAX)
                machineEdits.push({ chapter: chapterNo, field: 'points', detail: `知识点 ${pts.length + dropped.length} 条超过上限 ${OUTLINE_POINTS_MAX}，机器丢弃 ${dropped.length} 条：「${dropped.join('」「')}」` })
              }
              points = pts
            }
            // ③ outline / source 的 String() 强转（票 01 点名的第 5-8 处）：缺省落 `''` 按「缺失放行」
            //    不告知；交了非文本被强转要告知。
            const rawOutline = chapter?.outline
            if (rawOutline !== undefined && rawOutline !== null && typeof rawOutline !== 'string') {
              machineEdits.push({ chapter: chapterNo, field: 'outline', detail: `outline ${describeRawValue(rawOutline)} 不是文本，机器已按文本收下` })
            }
            const rawSource = chapter?.source
            if (rawSource !== undefined && rawSource !== null && typeof rawSource !== 'string') {
              machineEdits.push({ chapter: chapterNo, field: 'source', detail: `source ${describeRawValue(rawSource)} 不是文本，机器已按文本收下` })
            }
            // ④ volumeReason 的 slice(0, 200)（票 01 点名的第 5-8 处）：截断要告知，且只记真的发生了截断。
            const rawVolumeReason = chapter?.volumeReason
            const volumeReason = textCoerced(rawVolumeReason, CHAPTER_SIDE_REASON_MAX)
            if (typeof rawVolumeReason === 'string' && rawVolumeReason.length > CHAPTER_SIDE_REASON_MAX) {
              machineEdits.push({ chapter: chapterNo, field: 'volumeReason', detail: `体量依据 ${rawVolumeReason.length} 字超过 ${CHAPTER_SIDE_REASON_MAX} 字上限，机器截到 ${CHAPTER_SIDE_REASON_MAX} 字` })
            } else if (rawVolumeReason !== undefined && rawVolumeReason !== null && typeof rawVolumeReason !== 'string') {
              machineEdits.push({ chapter: chapterNo, field: 'volumeReason', detail: `体量依据 ${describeRawValue(rawVolumeReason)} 不是文本，机器已按文本收下` })
            }
            cleaned.push({
              title,
              outline: String(rawOutline ?? ''),
              source: String(rawSource ?? ''),
              targetWords,
              points,
              volumeReason,
            })
          }
          // ── 票 `pipeline-wiring-gaps/12` · 知识点覆盖闸门 ──
          // 证据（verification.md 第 8、11 条）：知识地图的 knowledgePoints 与骨架 points 之间
          // 没有任何机器约束，「每个知识点都要有章节认领」全靠 AI 自查或用户人眼，14 项质量门
          // 无一项触碰这两个字段。现在两头都查：知识地图里每条知识点都要在某一章的 points 里
          // 找到归属；points 里出现知识地图没有的条目同样拒——各自点名。
          // 口径按票 `01`（2026-09-29 用户拍板）：**title 单键**、比对前**先规范化**
          // （去尾部括注/trim/全半角——真书 54 条里唯一的失配就是尾部括注）、id 不进比对环；
          // 口径单点在 `domain-rules.outlinePointsCoverage`（交办/闸门/界面三面同一份）。
          // 豁免出口与 chapters 交工的 scaffold-keep/other 那两格同口径：**`other`**（用户手输原因、
          // AI 调 waive）——豁免时**不放静默行**：漏了哪些照样发一条账本 hint 点名（票 01 裁决的
          // 「人话提示」那一半，用户马上要在 awaiting-outline 拍板，看得到）。
          // ⚠️ **枚举面比现实窄在哪里**：无源书的知识点清单本就是空的（关卡③交办明写骨架那一列
          // 改写「锚定的源任务或概念」），书没有转换完成的源时这门闸**没有可比对的面**，不判——
          // 凭空要求一份不存在的东西与 explore 分片那格「零片不要求」同一口径。有转换完成的源
          // 却读不出知识地图是流水线破坏（探查交工时机器必落盘这一份），当场拒并点名，不当静默放行。
          const outlineMeta = readMeta(project)
          if (okMaterialNumbers(outlineMeta?.sources).length > 0) {
            let knowledgeMap = null
            try { knowledgeMap = JSON.parse(readFileSync(workFile(project, 'knowledge-map.json'), 'utf8')) } catch { knowledgeMap = null }
            if (knowledgeMap === null || !Array.isArray(knowledgeMap.knowledgePoints) || knowledgeMap.knowledgePoints.length === 0) {
              return rejectSubmit('outline',
                '读不出 工作区/knowledge-map.json（文件不在、不是 JSON 或没有 knowledgePoints）：本书有转换完成的源，知识地图是知识点覆盖判定的对照面（探查交工时机器落盘这一份）。先补探查交工；确要跳过，经用户同意后豁免「其他」再交工。')
            }
            const coverage = outlinePointsCoverage(knowledgeMap.knowledgePoints, cleaned)
            const coverageMisses = [
              ...coverage.unclaimed.map((t) => `知识点「${t}」还没有任何一章认领`),
              ...coverage.foreign.map((f) => `第${f.chapter}章 points 里的「${f.title}」不在知识地图里`),
            ]
            if (coverageMisses.length > 0) {
              const named = coverageMisses.slice(0, 5).join('；')
              const more = coverageMisses.length > 5 ? `……共 ${coverageMisses.length} 处` : ''
              if (!waived(project, 'other')) {
                return rejectSubmit('outline',
                  `知识点覆盖不完整：${named}${more}。知识地图里每条知识点都要在某一章的 points 里找到归属，points 也不能写知识地图没有的条目（title 口径，比对前机器先规范化：去尾部括注/trim/全半角）。把漏的认领进章节、或删掉地图外的条目再交工；确要保留，经用户同意后豁免「其他」再交工。`)
              }
              appendEvent(project, 'textbook/hint', {
                text: `⚠️ 知识点覆盖不完整，已按你的豁免放行：${named}${more}。这些知识点还没有章节归属，后续派章时记得交代去向。`,
              })
            }
          }
          // ⑤ goldChapter（票 13）：越界/非法静默回落 1 并清空理由——回落与「理由没收」都告知；
          //    理由超长被截（票 01 点名的第 5-8 处）只在理由真的被用上时记「截断」（被丢弃时记在⑤里）。
          const rawGold = body.goldChapter
          const goldNum = Number(rawGold)
          const goldReason = textCoerced(body.goldChapterReason, CHAPTER_SIDE_REASON_MAX)
          const goldValid = Number.isSafeInteger(goldNum) && goldNum >= 1 && goldNum <= cleaned.length
          if (!goldValid) {
            const why = rawGold === undefined || rawGold === null
              ? '没交建议范例章'
              : `建议范例章 ${describeRawValue(rawGold)} 越界（共 ${cleaned.length} 章）`
            const reasonGiven = body.goldChapterReason !== undefined && body.goldChapterReason !== null
              && String(body.goldChapterReason).trim() !== ''
            machineEdits.push({
              chapter: null,
              field: 'goldChapter',
              detail: `${why}，机器回落第 1 章${reasonGiven ? '；交来的理由没有收' : ''}`,
            })
          } else if (typeof body.goldChapterReason === 'string' && body.goldChapterReason.length > CHAPTER_SIDE_REASON_MAX) {
            machineEdits.push({ chapter: null, field: 'goldChapterReason', detail: `范例章理由 ${body.goldChapterReason.length} 字超过 ${CHAPTER_SIDE_REASON_MAX} 字上限，机器截到 ${CHAPTER_SIDE_REASON_MAX} 字` })
          }
          updateMeta(project, (state) => {
            if (goldValid) {
              state.goldChapter = goldNum
              state.goldChapterReason = goldReason
            } else {
              state.goldChapter = 1
              state.goldChapterReason = ''
            }
            state.outline = { chapters: cleaned }
            state.pendingStage = null
            state.pendingGate = null
          })
          // ⚠️ 这个文件**内容是 JSON**（票 pipeline-wiring-gaps/09）：所以
          // `domain-rules.productOpenMode` 判它 `'inline'`、不开右栏预览——与 `工作区/audit-NN.md`
          // 同一条理由。人读形态：章节安排确认卡（拍板前就在屏上）与阶段页第 3 阶段的就地折叠
          // 清单（`chapters-map.foldOutline`）。演示模式（`engine.js` 那一行）落同一份 JSON，口径相同。
          writeWork(project, 'outline.md', JSON.stringify({ chapters: cleaned }, null, 2))
          appendEvent(project, 'textbook/agent-end', { label: '整理章节骨架', outcome: 'ok', ...artifactDataForStage('outline') })
          // 票 13：机器改写了交上来的骨架就发一条账本 hint——用户马上要在 awaiting-outline 拍板，
          // 提示就落在这之前（豁免 outline-skip 时用户不过目，但交工回包里照样带全量 machineEdits）。
          if (machineEdits.length > 0) {
            appendEvent(project, 'textbook/hint', {
              text: `机器改写了交上来的骨架，请过目再确认：${machineEdits.map(renderMachineEdit).join('；')}`,
            })
          }
          if (waived(project, 'outline-skip')) {
            advance(project, 3, 4)
            void kick(ctx, project)
          } else {
            updateMeta(project, (state) => { state.status = 'awaiting-outline' })
            appendEvent(project, 'textbook/hint', {
              text: '📐 章节安排出来了，请在工作台查看：满意点「✅ 通过」，不满意点「🔁 提改进方向」让 AI 修订。',
            })
          }
          return accept({ project, stage: 'outline', chapters: cleaned.length, machineEdits })
        }
        case 'gold': {
          const gN = goldN(subMeta)
          const auditName = goldAuditName(gN)
          // 票 `walkthrough-2026-10/02`：范例章正文与普通章同口径——**由机器从分片拼**，机器是唯一写者。
          // 交工这一格验的是「盘上那份正文就是那几片分片的拼装件」；机器还没拼过（文件不在）时它补拼。
          // ⚠️ demo 书不受这一格约束：演示通道**不派真小助手**，那一章的正文本来就由机器写
          // （`demoWriteChapters` / `runPhase4` 的演示支），「同一文件多写者」在那里结构上不存在。
          if (subMeta.demo !== true) {
            const assembled = verifyChapterAtSubmit(project, gN)
            if (assembled.status !== 'ok') {
              return rejectSubmit('gold', chapterAssemblyReject(assembled, gN))
            }
          }
          // ⚠️ 这三个名字**都是基名**（`workFile` 自己拼 `工作区/`，喂相对路径会变成 `工作区/工作区/…`），
          // 而且它们还要原样进 `missing.join('、')` 那句人话——同一条消息里三个词得是同一族。
          const missing = [chapterName(gN), 'style-spec.md', auditName].filter((name) => {
            const target = workFile(project, name)
            return !existsSync(target) || readFileSync(target, 'utf8').trim() === ''
          })
          if (missing.length > 0) {
            return rejectSubmit('gold', `范例章文件缺失或为空：${missing.join('、')}`)
          }
          // style-spec 节标题软验（真实模式）：写作规范十九项契约要求节标题齐全，缺了就拦下让 AI 补全。
          // ⚠️ 票 20 已知失效路径：这是**软验**（查节标题在不在），**不查列表内容合不合理**——
          // AI 写一个 30 字的长标题照样过。所以「宽声明 → 误报 → 用户 waive 一次 → 硬编码地板被永久关掉」
          // 这条路径没有被机器堵死，处置写在票 20 的 `## Comments`（人工边界）。
          // demo 模式的占位 style-spec 没有节标题，不拦。
          if (subMeta.demo !== true) {
            const spec = readFileSync(workFile(project, 'style-spec.md'), 'utf8')
            // 票 20：加「脚手架标题列表」这一项——**否则「AI 被要求写」和「机器查它写了」之间还是同一根断线**。
            // 其余三个标题是既有判据，一个没动。
            // ⚠️ 第四项的词**必须与契约第 10 项逐字一致**（两边一个写「列表」一个写「清单」时，
            // 契约说该写、机器验另一个词 ⇒ 范例章交工恒被拒）。`test-scaffold-declaration.mjs`
            // 从契约文本里**解析**出那个词来比，不在本文件里硬编码第二份。
            // 票 26：加第五项「多源同级声明」——契约第 17 项同票改成**无条件节**（单源书也要写
            // 「本书无并行权威源，不存在同级冲突」），机器这才配得上无条件查；两步必须同时落，
            // 只加数组不改契约就是把一条合规行为判成违规。第五项的词同样**必须与契约第 17 项
            // 节标题逐字一致**，派生比对也在 `test-scaffold-declaration.mjs`。
            const missingSections = ['模式选型', '板块语法', '深度四维承诺', '脚手架标题列表', '多源同级声明'].filter((h) => !spec.includes(h))
            if (missingSections.length > 0) {
              return rejectSubmit('gold', `style-spec 缺节标题：${missingSections.join('、')}（写作规范十九项契约见任务说明）`)
            }
          }
          // 干净审计（真实模式）：范例章交工前 audit 必须带机器可逐条核对的文档矩阵（必读清单逐份摘录原文），
          // 且 `passed === true`（票 01 (e)：范例章与普通章同口径，`audit-skip` 豁免可跳过 passed 判定；
          // `gold-skip` 跳过的是「等用户拍板」，不是验货豁免）。判据与报错跟写入侧 `audit-submit` 共用同一份。
          if (subMeta.demo !== true) {
            const auditText = readFileSync(workFile(project, auditName), 'utf8')
            const verdict = checkGoldAudit(project, gN, auditText)
            if (verdict.error !== null) {
              return rejectSubmit('gold', verdict.error)
            }
          }
          let handledThisRound = 0
          updateMeta(project, (state) => {
            state.pendingStage = null
            state.pendingGate = null
            state.status = 'awaiting-gold'
            delete state.goldRedoNote // 重做意见只对本轮生效
            // style-spec 指纹定格（Q9）：终检交工时对账，spec 变了而报告未声明 → 打回（契约修改必须留痕）。
            try { state.styleSpecHash = specFingerprint(project) } catch { /* spec 读不到时不记账（后续对账跳过） */ }
            if (Array.isArray(state.goldOpinions)) {
              for (const o of state.goldOpinions) if (o.status === 'sent') o.status = 'applied'
            }
            // 票 gold-revision-flow/01：交工提示带上**本轮处置**——第一稿与第 N 次修订落同一句，
            // 用户拿不到"你这轮提的意见已经落到新版里了"的任何信号。数的是**本轮真被交办出去的**
            // 那些（sent → applied 这一批），与状态迁移同源、不另记一份账。
            handledThisRound = (subMeta.goldOpinions ?? []).filter((o) => o.status === 'sent').length
          })
          const goldArtifact = artifactDataForChapter(gN)
          appendEvent(project, 'textbook/agent-end', { label: '最佳范例章', outcome: 'ok', path: goldArtifact.path, chapter: goldArtifact.chapter })
          // 票 15④（票 06 的 Answer 第 4 条）：补 `gold-skip` 的读取点——与既有 gate-skip/outline-skip/
          // audit-skip 同构，语义就是「跳过一道已存在的用户确认闸门」（「最佳范例章确认」），
          // 不是新能力、也没有放松任何判据。豁免须由主笔 AI 先得到用户明确同意才调（waive 动作自身的约束）。
          // 金标准定稿沉淀**照走**：意见转风格线 + 记 goldSealed + 落 gold-seal 事件，只跳过「等用户拍板」
          // 那一步（sealGoldStandard 与 gold-approve 共用同一份沉淀逻辑）。
          if (waived(project, 'gold-skip')) {
            sealGoldStandard(project)
            appendEvent(project, 'textbook/hint', { text: '✅ 你已同意跳过范例章确认：范例章照旧定稿沉淀，直接开始写全书。' })
            advance(project, 4, 5)
            void kick(ctx, project)
            return accept({ project, stage: 'gold', skipped: 'gold-confirm' })
          }
          appendEvent(project, 'textbook/hint', {
            text: handledThisRound > 0
              ? `📖 最佳范例章改好了（本轮照着改了 ${handledThisRound} 条意见），请在工作台查看：满意点「✅ 满意，继续写全书」，不满意点「❌ 重写」。`
              : '📖 最佳范例章写好了，请在工作台查看：满意点「✅ 满意，继续写全书」，不满意点「❌ 重写」。',
          })
          return accept({ project, stage: 'gold' })
        }
        case 'chapters': {
          const chapters = subMeta.outline?.chapters ?? []
          const n = Number(body.chapter)
          if (!Number.isSafeInteger(n) || n < 1 || n > chapters.length) {
            return reject(400, 'chapter 参数不合法（需要第几章的编号）')
          }
          const { chapterPath, auditPath } = chapterArtifacts(project, n)
          // 票 `walkthrough-2026-10/02`（走查 A10 的裁决）：**机器是章正文的唯一写者**。
          // 判据不是「文件在不在」（那是**单写者假设**：两个写者先后落盘之后，只要终态齐全它就绿），
          // 而是「盘上那份正文就是这几片分片的拼装件」——分片是子助手的产品、正文是机器的派生件。
          // 三条路各有各的话：① 一片分片都没有 ⇒ 有人（老协议里就是执笔小助手）直写了正文，拒收；
          // ② 盘上那份与拼装件不一致 ⇒ 机器之外有人在写这份文件（同一文件多写者），拒收、**不覆盖**；
          // ③ 机器还没拼过（文件不在）⇒ 机器当场补拼（它本来就是唯一写者）。
          // ⚠️ demo 书不受这一格约束（演示通道不派真小助手，正文本来就由机器写）——判据一个字没放宽。
          if (subMeta.demo !== true) {
            const assembled = verifyChapterAtSubmit(project, n)
            if (assembled.status !== 'ok') {
              return rejectSubmit('chapters', chapterAssemblyReject(assembled, n))
            }
          }
          if (!existsSync(chapterPath) || readFileSync(chapterPath, 'utf8').trim() === '') {
            // ⚠️ 报错文案里给的是**书夹相对路径**（上面 `chapterPath` 是绝对路径，进人话不合适）
            // ⇒ 那一族取 `chapterRel`，与 `:607` 落账的 `path` 逐字同一形状。
            return rejectSubmit('chapters', `第${n}章正文缺失或为空：${chapterRel(n)}`)
          }
          if (!existsSync(auditPath)) {
            return rejectSubmit('chapters', `第${n}章缺少自查记录：工作区/audit-${String(n).padStart(2, '0')}.md`)
          }
          // 章审计机器验货（2026-08-27 用户拍板 Q4'）：每章交工读 audit JSON，passed === true 才放行。
          // 对齐金标准章 matrix 校验同口径；「审计未过但交工」直接拒（audit-skip 豁免可跳过）。
          if (subMeta.demo !== true && !waived(project, 'audit-skip')) {
            const audit = readChapterAudit(project, n)
            if (audit?.passed !== true) {
              return rejectSubmit('chapters', `第${n}章审计未通过（工作区/audit-${String(n).padStart(2, '0')}.md 的 passed 不是 true）：先按审计意见修订并重新审计，或豁免「不要求每章都有独立审查」再交工`)
            }
          }
          // 前置验货（检查点前置）：单章阶段就查脚手架残留与练习/答案，不让问题流到合并后。
          // demo 书走旧通道不受此约束；scaffold-keep / other 豁免可跳过对应项（与终检 runQualityChecks 同口径）。
          if (subMeta.demo !== true) {
            const chapterText = readFileSync(chapterPath, 'utf8')
            if (!waived(project, 'scaffold-keep')) {
              // 票 20：通用残留 + **写作规范声明过的本书标题**两个来源都查（复用 engine 的 `scaffoldResidue`，
              // 与终检 `runQualityChecks` 同一份判据、同一份护栏：escapeRegExp、数量/长度上限、
              // 没声明就整项不追加、读不到 style-spec 就干净退回通用那一条）。
              const residue = scaffoldResidue(project, stripLoaderRegion(chapterText))
              const hits = [...residue.declared, ...residue.generic]
              if (hits.length > 0) {
                const kinds = [residue.declared.length > 0 ? '本书声明过的脚手架标题' : null, residue.generic.length > 0 ? '通用脚手架标记' : null].filter(Boolean).join(' ＋ ')
                return rejectSubmit('chapters', `第${n}章正文残留 ${kinds}：${hits.slice(0, 3).join('；')}。先拆干净再交工（豁免「保留 AI 的笔记不删」可跳过）。`)
              }
            }
            // 契约原则（Q9）：style-spec 声明「本书不设练习」→ 练习/答案检查自动跳过；否则仍要齐全。
            if (!waived(project, 'other') && !styleSpecDeclaresNoExercises(project) && !/练习|答案|习题/.test(chapterText)) {
              // 同上：文案里是**书夹相对路径** ⇒ `chapterRel`（`工作区/audit-NN.md` 那一行是 audit 族，本票不收）。
              return rejectSubmit('chapters', `第${n}章正文没有练习或答案（成品要求练习与答案齐全；若本书设计为不设练习，请在 style-spec 写明「不设练习」）：${chapterRel(n)}`)
            }
            // 用户抽查意见（Q5'，票 09）：先按 handledReviews **点名销号**——机器只给点名的置 applied，
            // 不搞「交工自动全销号」；再只拦显式 status==='pending' 的意见：老账本里缺 status 的意见
            // （undefined）不再永久卡人（spec 不变量 3）。applied / revoked 都不拦。
            const handled = Array.isArray(body.handledReviews) ? body.handledReviews : []
            const reviews = Array.isArray(subMeta.pendingReviews) ? subMeta.pendingReviews : []
            // 未知 id 语义（本票拍板）：不在本书 pendingReviews 里 → 不认识的 id；别章的意见不在本次
            // 交工范围内 → 同样按未知处理（消息里说清是哪个 id）。先整体验明再应用，防半写半退。
            const unknownIds = handled
              .map((entry) => (typeof entry?.id === 'string' ? entry.id : ''))
              .filter((id) => id === '' || !reviews.some((r) => r.id === id && r.chapter === n))
            if (unknownIds.length > 0) {
              return rejectSubmit('chapters', `不认识的抽查意见 id：${unknownIds.join('、')}。只能点名第${n}章还没处置的意见（id 见 workbench_status 的 pendingReviews）。`)
            }
            // 这份 `reviews` 只用来判断：未知 id 已在上方整体验明（防半写半退）；「点名后还有没有没处置的」
            // 按 pending 且未被点名来算（applied 才销号、revoked 是用户收回的，重复点名幂等忽略）。
            const handledIds = new Set(handled
              .filter((entry) => reviews.some((r) => r.id === entry.id && r.chapter === n && r.status === 'pending'))
              .map((entry) => entry.id))
            const pendingForChapter = reviews.filter((r) => r.chapter === n && r.status === 'pending' && !handledIds.has(r.id))
            if (pendingForChapter.length > 0) {
              return rejectSubmit('chapters', `第${n}章还有 ${pendingForChapter.length} 条未处置的抽查意见：先按意见修订、重新审计（audit passed），交工时用 handledReviews 逐条点名（每条 id + 一句怎么处置的）后再交工。`)
            }
            // 销号落账走单一入口（当场新读）。
            updateMeta(project, (state) => {
              const list = Array.isArray(state.pendingReviews) ? state.pendingReviews : []
              for (const entry of handled) {
                const review = list.find((r) => r.id === entry.id && r.chapter === n)
                if (review === undefined || review.status !== 'pending') continue
                review.status = 'applied'
                review.how = textField(entry.how, CHAPTER_SIDE_REASON_MAX)
              }
            })
          }
          const title = chapters[n - 1]?.title ?? `第${n}章`
          appendEvent(project, 'textbook/agent-end', {
             label: `第${n}章《${title}》完成（小助手执笔 + 小助手审计 + 机器验货）`, outcome: 'ok',
             // 落账的 `path` 是**书夹相对路径**（前端拿它读产物、过程图谱与事件行都按这个形状认）⇒ `chapterRel`。
             // 与 `artifactDataForChapter` 那条是同一份形状的两个消费者，不必也不该另拼。
             path: chapterRel(n), chapter: n,
           })
          // 票 05 / P36（2026-09-27 用户拍板「逐章交工各存一次」）：铺章是**一个阶段**
          // （`stage-start {"stage":"chapters"}` 只发生一次），所以整段 40 万字的写作原先只配发一个存档
          // （交办「写完整本」之前那一个）——界面那句「随时能回到最近一次存档」字面为真，回的却是「一章未写」。
          // 这里在**交工成功之后**落一份，于是「最近一次存档」＝**上一章交完的地方**。
          // 排在 agent-end 之后：存档要含这一章的完成事件，回退到它才真的回到「这一章已交工」那一刻。
          writeSnapshot(project, `交工「第 ${n} 章《${title}》」之后`)
          // 原先这里 appendEvent 之后又拿请求开头那份旧状态整份写回（还自己写了一次 `updatedAt`）：
          // 账高被拉回交工前那份（票 02 的形状）。「最后动静时刻」只归「记一笔」所有，改法里不再碰它。
          const allDone = chapters.every((_chapter, index) => chapterDone(project, index + 1))
          if (allDone) {
            updateMeta(project, (state) => {
              state.pendingStage = null
              state.pendingGate = null
            })
            // 全章交齐：不直接交办合并，kick 让 runPhase5 先裁决过目闸门（F18）。
            void kick(ctx, project)
          }
          // 还有章节：pendingStage 保持 'chapters'（主 AI 在同一回合里继续，不重复唤醒）。
          return accept({ project, stage: 'chapters', chapter: n, allDone })
        }
        case 'merge': {
          // 过目闸门硬校验：章节还在等人过目时不许合并（F18；demo 书不会进入此态，不拦 demo）。
          if (subMeta.status === 'awaiting-chapters-review') {
            return reject(409, '章节还在等你过目：先在工作台完成全章过目（或先提意见让 AI 改），再合并。')
          }
          // 合并前跨章审计（Q6，2026-08-27 用户拍板；票 `.scratch/context-budget/issues/05` 扩面）：
          // 这一层是**跨章审计小助手**做的（ADR-0030 决策 2 · 改派第一刀 · merge 段）——
          // 派发模板 `references/subagent-prompts/cross-audit-prompt.md`，报告人自落 audit-cross.md，
          // 主笔只派发、按点名条目派修复小助手、汇总裁决追加进同一份文件。
          //
          // ⚠️ 旧判据只验「文件存在且非空」——实测主笔凭协调记忆写了 2,780 字符即放行
          // （merge 窗口 +0 token，一个章都没读）。所以现在逐项断**那四项核对都有交代**。
          // ⚠️ 这一层只断**接线与形状**（在不在、有没有交代）：「它到底读没读章」是真机层（票 07），
          // 机器判据不许冒充。
          // ⚠️ 四项判定词与判定口径**只住在派发模板**（由 cross-audit.js 从那份模板解析）——
          // 拒收文案里点名的是**运行时算出来的**缺项，不在这里抄一份清单。
          if (subMeta.demo !== true) {
            const crossPath = workFile(project, 'audit-cross.md')
            if (!existsSync(crossPath) || readFileSync(crossPath, 'utf8').trim() === '') {
              return rejectSubmit('merge', `合并前缺跨章审计记录 工作区/audit-cross.md：按 resources/${CROSS_AUDIT_TEMPLATE_REL} 派一个上下文干净的跨章审计小助手读全部章做四项核对，它自己把报告落在这份文件里（四项判定词与判定口径只见那一份模板），补齐再交工合并。`)
            }
            const verdict = judgeCrossAuditReport(readFileSync(crossPath, 'utf8'))
            if (verdict.wiringBroken || verdict.missing.length > 0) {
              return rejectSubmit('merge', crossAuditRejectReason(verdict))
            }
          }
          const preface = typeof body.preface === 'string' ? body.preface.trim() : ''
          if (preface === '') {
            return rejectSubmit('merge', '需要 preface（书的引言/使用说明文本）')
          }
          writeWork(project, 'preface.md', preface)
          const chapters = subMeta.outline?.chapters ?? []
          const parts = [`# ${subMeta.name ?? ''}`, '', preface, '']
          for (let index = 0; index < chapters.length; index += 1) {
            const { chapterPath } = chapterArtifacts(project, index + 1)
            const body2 = existsSync(chapterPath) ? readFileSync(chapterPath, 'utf8').trim() : ''
            const heading = `# 第${index + 1}章 ${chapters[index]?.title ?? ''}`
            // 章节正文若自带章标题则去掉，避免与机器拼的章标题重复（见 stripChapterTitleHeading）。
            const stripped = stripChapterTitleHeading(body2, chapters[index]?.title ?? '').trim()
            parts.push('', '---', '', heading, '', stripped)
          }
          // human 路线：成品顶部给 AI 老师留 loader 装配指令（正文 prose 当素材库用），保留在成品里。
          if (subMeta.route === 'human') {
            parts.splice(1, 0, '', '<!-- loader:begin -->', '给 AI 老师的 loader 指令：正文 prose 是素材库，用自己的话重组教学；章末教学区照问题链走。', '<!-- loader:end -->')
          }
          writeWork(project, 'book.md', parts.join('\n'))
          updateMeta(project, (state) => {
            state.pendingStage = null
            state.pendingGate = null
          })
          appendEvent(project, 'textbook/agent-end', { label: '合并成书（机器拼装 + AI 前言）', outcome: 'ok', ...artifactDataForStage('merge') })
          advance(project, 5, 6)
          void kick(ctx, project)
          return accept({ project, stage: 'merge' })
        }
        case 'final': {
          const report = typeof body.report === 'string' ? body.report.trim() : ''
          if (report === '') {
            return rejectSubmit('final', '需要 report（你的最后检查报告）')
          }
          // 终检门槛（真实模式）：留言必须先销号。
          if (subMeta.demo !== true) {
            const pendingIv = (subMeta.pendingInterventions ?? []).filter((i) => i.status === 'pending')
            if (pendingIv.length > 0) {
              return reject(409, `还有 ${pendingIv.length} 条用户留言没处理：${pendingIv.map((i) => i.text).join('；')}。先处理（intervene-done）再交工。`)
            }
          }
          // 进度账本硬验（真实模式）：交工前 工作区/progress.md 必须在（progress-skip 可豁免）。
          if (subMeta.demo !== true && !waived(project, 'progress-skip') && !existsSync(workFile(project, 'progress.md'))) {
            return rejectSubmit('final', '缺 工作区/progress.md（进度账本）：每章一行（写完/审计/验货），是中途换人/重做的参照。不需要可先豁免「跳过进度账本检查」再交工。')
          }
          // 票 11 · ADR-0030 决策 13：**最后检查五份分报告各自落 `工作区/报告/`**——本票要接的第一个落盘洞。
          // 病是方法论文档 §10.b 逐字写着「这一层是三件套里唯一不落盘的一档」，于是实测 5 份 0 份落盘、
          // 四万多字符回灌没有任何实物可查；`§九 回灌三件套`那张表的「落盘路径」那一件被明令「别编出来」。
          // 票 11 推翻那半句话，把落盘接上（票 `12` 承接另一半：机器无损拼装汇总件）。
          //
          // ⚠️ **报告人自落**：写那份报告的小助手自己落，协调员**不从回灌转写**
          // （用户故事 26）。「产出 ≠ 改被审文件」——这一层仍受「只报告不改文件」那条铁律管。
          // ⚠️ **demo 豁免**：演示书走的是脚本化的全流程、没有真小助手派发，
          // 它连 `工作区/progress.md` 都已豁免——要求五份实物只会让录制回放必红，
          // 而 demo 的五份分报告本来就该由真机那一层产出。
          if (subMeta.demo !== true) {
            const reportMissing = FINAL_AUDIT_SCOPES
              .filter(({ n }) => !existsSync(join(reportDir(project), finalAuditReportName(n))))
              .map(({ n }) => finalAuditReportRel(n))
            if (reportMissing.length > 0) {
              return rejectSubmit('final',
                `分查报告缺失：${reportMissing.join('、')} —— 五路分查每一路都要有一份落盘报告（由写那份报告的小助手自落，协调员不转写），缺 ${reportMissing.length} 份。`)
            }
          }
          // styleCheck 处置契约（真实模式 + 存在 active 风格线时必交）。
          if (subMeta.demo !== true) {
            const active = (subMeta.styleNotes ?? []).filter((n) => n.status === 'active')
            const disposals = Array.isArray(body.styleCheck) ? body.styleCheck : []
            if (active.length > 0 || disposals.length > 0) {
              const byId = new Map(disposals.map((d) => [d.id, d]))
              const missing = active.filter((n) => !byId.has(n.id)).map((n) => n.text)
              if (missing.length > 0) {
                return rejectSubmit('final', `这些风格意见没有处置：${missing.join('；')}。每条都要给出去向（落实在哪章 / 冲突理由 / 已收回）。`)
              }
              for (const d of disposals) {
                if (!['adopted', 'conflict', 'superseded'].includes(d.status)) {
                  return rejectSubmit('final', 'styleCheck 的 status 只能是 adopted / conflict / superseded')
                }
                if (d.status === 'conflict' && (typeof d.note !== 'string' || d.note.trim() === '')) {
                  return rejectSubmit('final', 'conflict（冲突）必须写一句理由，说明向用户确认过')
                }
              }
              // 权威翻转：meta 状态只在这里改。走单一入口（当场新读）——紧接着的镜像读的就是刚写进去的这份
              // （原先靠请求末尾那次整份写回兜着，写回一收窄就露馅）。
              updateMeta(project, (state) => {
                for (const d of disposals) {
                  const note = (state.styleNotes ?? []).find((n) => n.id === d.id)
                  if (note === undefined) continue
                  note.status = d.status
                  note.note = textFieldRaw(d.note, STYLE_NOTE_REVOKE_NOTE_MAX, typeof d.chapter === 'string' ? `落实于${d.chapter}` : note.note)
                }
              })
              updateStyleLineMirror(project)
            }
          }
          // style-spec 对账（Q9，2026-08-27）：范例章定稿后 spec 被改过 → 契约修改必须留痕。
          // 机器只认自查报告里的「style-spec 变更：」声明——没声明就打回，防 AI 静默放宽契约迁就检查。
          // ⚠️ 票 12 · ①：**先补记一笔再对账**——工作台没开过、这一路也没人轮询时，
          // 那一笔就不在账本里；补检让「留痕」不依赖「有人正开着界面」。
          try { noteStyleSpecChange(project) } catch { /* 补记失败不许挡住对账本身 */ }
          let specNow = null
          try { specNow = specFingerprint(project) } catch { /* spec 被删/不可读：视为已变更（堵「删 spec 逃检查」的逃逸口） */ }
          if (subMeta.styleSpecHash != null && specNow !== subMeta.styleSpecHash
            && !report.includes('style-spec 变更')) {
            return rejectSubmit('final', 'style-spec 在范例章定稿后有改动（机器对账发现）：若改动经用户确认，请在 report 末尾写明「style-spec 变更：<改了哪条>」再交工；未经用户确认的改动请改回原样。')
          }
          // 票 `context-budget/12` · ADR-0030 决策 18–20：**机器按固定形状无损拼装一份派生汇总件**，
          // 落 `工作区/报告/final-summary.md`（路径单一持有：`domain-rules.finalAuditSummaryRel`）。
          // 汇总件 = 五份分报告**逐条点名条目的并集（去重）**，同输入同输出；
          // **机器不出裁决**：通过／不通过仍归主笔，五份各自的结论一份都不合并、不替代。
          //
          // ⚠️ **为什么写在这里而不是只在交办说明里写**：`buildStageBrief` 已经拼过一次（主笔读它），
          // 这一处是**交工那一刻的权威刷新**——五份可能在最后一次领任务之后才改过。
          // 两处走的是**同一个** `refreshFinalAuditSummary`，不存在两份拼装口径。
          // ⚠️ demo 豁免那一族（票 11）：演示通道不派真小助手，五份不在盘上 ⇒ 拼不出汇总件
          // （`refreshFinalAuditSummary` 返回 `null`），于是指针是 `path: null` 而不是指向一份空件。
          const summary = refreshFinalAuditSummary(project)
          const finalReportPointer = {
            path: summary === null ? null : summary.path,
            chars: summary === null ? null : summary.chars,
            // 摘要说的是**主笔要拿它干什么**：条目并集在哪、几条、以及「自查报告全文在哪」。
            // ⚠️ 自查报告那一份全文**不落盘**（它随交工上送、逐字进账本事件 `textbook/ai-report`），
            // 所以指针指的是**五份并集**那份，不是自查报告本身——两件事别混。
            summary: summary === null
              ? `最后检查自查报告（${report.length} 字符，随交工上送、全文在账本事件里）；五份分查的点名条目并集尚未拼装（盘上还没有那五份）`
              : `最后检查自查报告（${report.length} 字符，随交工上送、全文在账本事件里）；五份分查的点名条目并集 ${summary.unionSize} 条，落在 ${summary.path}`,
          }
          updateMeta(project, (state) => { state.finalReport = finalReportPointer })
          appendEvent(project, 'textbook/ai-report', { report })
          // 机器硬检查兜底：全过才交付，否则打回主 AI 修。
          const machineChecks = runQualityChecks(project)
          if (machineChecks.every((check) => check.ok === true)) {
            // 终检结果认可闸门（2026-08-26 用户拍板）：硬检查全过也不直接交付——
            // 先落 awaiting-final-approval，把自查报告 + 检查结果展示给用户做「对整本书的最终认可」。
            // demo 与真实共用认可闸门（2026-09-01 全镜像：演示书也走完整确认流程）。
            updateMeta(project, (state) => {
              state.pendingStage = null
              state.pendingGate = null
              state.status = 'awaiting-final-approval'
              state.finalChecks = machineChecks
              state.finalReport = finalReportPointer
              delete state.finalRedoNote // 终检修订意见销号：本轮交工已通过，意见已落实（2026-08-27 grill 修订）
            })
            appendEvent(project, 'textbook/quality', { checks: machineChecks })
            appendEvent(project, 'textbook/agent-end', { label: '最后检查（AI 自查 + 机器兜底）', outcome: 'ok', ...artifactDataForStage('final') })
            appendEvent(project, 'textbook/hint', {
              text: FINAL_CHECK_DONE_HINT,
            })
            return accept({ project, stage: 'final', awaitingApproval: true, checks: machineChecks })
          } else {
            const issues = machineChecks.filter((check) => check.ok !== true)
              .map((check) => `${check.name}：${check.note ?? ''}`)
            appendEvent(project, 'textbook/error', {
              task: '最后检查',
              message: `机器兜底发现 ${issues.length} 项没过：${issues.join('；')}。请 AI 修复后重新交工。`,
            })
            updateMeta(project, (state) => { state.status = 'running' })
            // 不自动再唤醒：问题已随响应返回主 AI，它会在同一回合修复并重交；用户也可点重试。
            return accept({ project, stage: 'final', delivered: false, issues: issues.map((text) => ({ text })) })
          }
          return
        }
        default:
          return reject(400, `未知交工阶段: ${stage}`)
      }
    }
    case 'stage-brief': {
      // 主 AI 领任务：当前 pendingStage 的任务说明 + 方法论文本（全中文）。
      assertSessionOwned(project, sessionId)
      const brief = buildStageBrief(project)
      if (brief === null) {
        return accept({ brief: null, message: '当前没有待办任务（机器没在等你）。' })
      }
      return accept({ brief })
    }
    case 'progress': {
      // 主 AI 上报进度（工作台状态卡实时显示；不需要征求用户同意）。
      assertSessionOwned(project, sessionId)
      const progressMeta = readMeta(project)
      if (progressMeta !== null && progressMeta.pause !== null && progressMeta.pause !== undefined) {
        return reject(409, '已在暂停，请先点继续（▶）再上报进度')
      }
      const label = textFieldRaw(body.label, PROGRESS_LABEL_MAX)
      const detail = textFieldRaw(body.detail, PROGRESS_DETAIL_MAX)
      appendEvent(project, 'textbook/progress', { label, detail })
      // F35（2026-08-20 走查）：主 AI 上报章节流水线阶段（chapter+stage）→ 结构化账本
      // meta.chapterPipeline[n-1]={stage,updatedAt}；demo 豁免；旧账本 ?? [] 兜底。
      // 走单一入口（当场新读）：原先这里还自己写了一次 `updatedAt`（票 02 的形状）；
      // 「最后动静时刻」只归上面那记「记一笔」所有。
      const chapterN = Number.isSafeInteger(body.chapter) && body.chapter >= 1 ? Number(body.chapter) : null
      const stage = CHAPTER_PROGRESS_STAGES.includes(String(body.stage))
        ? String(body.stage)
        : null
      if (chapterN !== null && stage !== null) {
        updateMeta(project, (state) => {
          if (state.demo === true) return
          const pipeline = Array.isArray(state.chapterPipeline) ? state.chapterPipeline.slice() : []
          while (pipeline.length < chapterN) pipeline.push(null)
          pipeline[chapterN - 1] = { stage, updatedAt: Date.now() }
          state.chapterPipeline = pipeline
        })
      }
      // 上报进度后让状态机照账本重推导（幂等，runLoop 会在等待点停下）：
      // 铺章全写完的瞬间在这里停下等人过目（F18）；其它阶段照旧推进。
      void kick(ctx, project)
      return accept({ project })
    }
  }
})
