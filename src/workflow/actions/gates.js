/**
 * 动作族模块（架构评审候选 3，2026-09-01 拆分）：actGates
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
// 章节正文路径的构造只此一份（票 `depth-review-2026-10/05`）：住在 `src/domain-rules.js`，
// 与识别侧（`NUMBERED_CHAPTER_FILE_RE` / `productOpenMode`）同居。
import { chapterRel, readingName, knowledgeShardName, WORK_DIR_NAME, DETAIL_DIR_REL } from '../../domain-rules.js'
import {
  assertSessionOwned,
  // 票 `premature-announce/01`：源探查「盘上产物齐没齐」的唯一一份判据（置态/放行/交工三处共用）。
  exploreArtifactProblems,
  // 同票：章节骨架那一段的就绪判据（比探查那份窄，窄处写在它自己的注释里）。
  outlineArtifactProblems,
  // 同票：交付不可撤回 ⇒ 放行那一刻当场重算一次硬检查（不拿账上那份快照当现状）。
  runQualityChecks,
  // 同票：`countRunningSubagents` 搬进了 engine（暂停与「重做/归档前」两处共用同一份实现）。
  countRunningSubagents,
  readMeta,
  updateMeta,
  appendEvent,
  writeSnapshot,
  restoreSnapshot,
  foldGate,
  workDir,
  workFile,
  projectDir,
  chapterGateMiss,
  resolveGateDecision,
  handoffAndDrive,
  advance,
  kick,
} from '../engine.js'
// payload 字段词汇层（票 `deep-module-scan/18` 层一）。本文件三个 case（拍板 / 两条重做）
// 读的是**同一个** `note` 字段、同一个 500 字上限 ⇒ 共用 `GATE_NOTE_MAX` 一个常量。
import { textField, GATE_NOTE_MAX } from './payload-fields.js'
import { familyOf, reject, accept } from '../action-runner.js'
import { mkdirSync, existsSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'


/**
 * 拍板动作的两条校验报错（错误条 / 回给主 AI 的话都算界面词，判定线①③；界面不叫「关卡」）。
 * 导出以便用词不变量断言直调**真实报错文本**（票 01），不在测试里复制文案。
 */

/** 提案对不上号（gate/version 不匹配，或压根没有待拍板的提案）。 */
export function gateMismatchError(current) {
  return `拍板状态不匹配（当前: ${current === null ? '无' : `${current.gate} v${current.version} ${current.status}`}）`
}

/** 该次拍板已经拍过了（不能重复拍板）。 */
export function gateAlreadyDecidedError(current) {
  return `第 ${current.gate} 次拍板已${current.status === 'approved' ? '通过' : '驳回'}，不能重复拍板`
}


/**
 * 探查重做要归档的两件产物（归档与清点都只认这一份清单，不在别处再抄一遍文件名）。
 * `knowledge-map.json` 可能压根没生成（那一版探查没写知识地图），循环里按存在性跳过。
 *
 * ⚠️ 票 03 之后它只管**两份固定名**的件；精读派发按材料落下的 `reading-NN.md` /
 * `knowledge-map-NN.json` 由 {@link exploreRedoArtifactNames} 现场枚举（份数随材料数变，
 * 写死清单装不下）——重做那一圈两份都不搬的话，新旧分片会混在同一本书的 `工作区/` 里。
 */
const EXPLORE_REDO_ARTIFACTS = Object.freeze(['explore.md', 'knowledge-map.json'])

/**
 * 票 03 · ADR-0030 决策 2：精读派发落下的两族**按材料分号**的产物（`NN` = 材料序号，两位）。
 * 这一条正则同时认两种形状：`工作区/` 原位的裸件、`_旧版产物/` 里带 base36 时间戳的归档件。
 *
 * ⚠️ **形状从 `domain-rules` 的两个出口派生**（`readingName` / `knowledgeShardName`），不另写一份
 * （code-review S2）：这里原先手抄 `reading-\d{2}\.md|knowledge-map-\d{2}\.json`，于是
 * 「改名」变成**静默失配**——生产者（brief 的 `parallelReads`）已经按新名写了，认领这一族
 * 归档的正则却还认旧名，重做时 `工作区/` 原位那几片搬不走、`_旧版产物/` 里那几片清不掉，
 * 而新旧的混账一直长胖。派生的做法把这一族钉回它的单一出处：
 * **改 `domain-rules` 那两个函数就同时改了这里**。
 *
 * 派生方式：基名逐字转义后，把那个**两位序号**换成 `\d{2}`——序号位可匹配，其余一个字都不动。
 * （`escapeRegExp` 不转义数字，所以转义后的字符串里 `01` 仍以原样出现。）
 */
function escapeRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\-]/g, (c) => `\\${c}`)
}
const shardNameShape = (name) => escapeRegExp(name).replace(/\d{2}/g, String.raw`\d{2}`)
const EXPLORE_SHARD_ARTIFACT_RE = new RegExp(
  `^(?:${shardNameShape(readingName('01'))}|${shardNameShape(knowledgeShardName('01'))})(?:\\.[0-9a-z]+)?$`,
)

/**
 * 本次探查重做要归档的产物全集 = 两份固定件 ∪ 盘上现存的精读分片件／细目件。
 *
 * ⚠️ **票 11：精读细目换家了**（工作区根 → `工作区/细目/`），所以这一族现在**跨两个目录**，
 * 只扫 `工作区/` 会让细目留在原位、和新一轮混在同一本书里——而 `stage-submit(explore)`
 * 的细目存在性断言会把上一轮的旧细目当这一轮的交账（正是探查笔记 §6.9 说的那个静默失配）。
 * 于是这里扫**两个源目录**，并把每一件的**书夹相对路径**一起交出去（`rel`）：
 * 动作层若靠 `workFile(project, name)` 反推，它只会拼工作区根、对细目恒 miss。
 *
 * 三处各答一个问题：
 * - `work`：这一轮留下什么（要搬走的正是这些）；
 * - `detail`：细目那一族（票 11 起在子目录里）；
 * - `archive`：清理策略认得哪些产物名（某一轮材料比现在多时，早先搬走的那几片照样归
 *   `ARCHIVE_KEEP` 管，否则 `_旧版产物/` 会随着材料数单调长胖——那正是这族当初「只进不出」的病）。
 *
 * 归档件那边的名字要**还原成基名**（`精读-01.md.m3fk2` → `精读-01.md`）：归档件的真名
 * 是「基名 + 时间戳」，直接把整个 entry 当产物名会让 {@link trimExploreArchive} 的
 * `<名>.<时间戳>` 匹配对不上（等于没纳入清理）。
 *
 * @param {string} work 该书的 `工作区/` 目录
 * @param {string} archive `工作区/_旧版产物/` 目录（可与 `work` 同一个，默认如此）
 * @returns {Array<{name: string, rel: string}>} 文件名（不含目录）＋ 它的书夹相对路径
 */
export function exploreRedoArtifactEntries(work, archive = work) {
  const detail = join(work, ...DETAIL_DIR_REL.split('/').slice(1))
  // 键＝产物基名（清理策略按它归堆），值＝那一件在书夹里的相对路径（动作层按它搬）。
  const out = new Map(EXPLORE_REDO_ARTIFACTS.map((name) => [name, `${WORK_DIR_NAME}/${name}`]))
  for (const [dir, relDir, inArchive] of [
    [work, `${WORK_DIR_NAME}`, false],
    [detail, DETAIL_DIR_REL, false],
    [archive, `${WORK_DIR_NAME}/_旧版产物`, true],
  ]) {
    let entries = []
    try { entries = readdirSync(dir) } catch { continue }
    for (const entry of entries) {
      if (!EXPLORE_SHARD_ARTIFACT_RE.test(entry)) continue
      const name = inArchive ? entry.slice(0, entry.lastIndexOf('.')) : entry
      if (!out.has(name)) out.set(name, `${relDir}/${name}`)
    }
  }
  return [...out].map(([name, rel]) => ({ name, rel }))
}

/**
 * 本次探查重做要归档的**文件名**全集——{@link exploreRedoArtifactEntries} 的一份投影
 * （`trimExploreArchive` 与判据要的只是名字；动作层要的是来处，那份用 entries）。
 *
 * ⚠️ 签名保持 `(work, archive = work)`：它是判据直调的那一个出口，别为了加第三个参数改形状。
 *
 * @param {string} work 该书的 `工作区/` 目录
 * @param {string} archive `工作区/_旧版产物/` 目录（可与 `work` 同一个，默认如此）
 * @returns {string[]} 文件名（不含目录）
 */
export function exploreRedoArtifactNames(work, archive = work) {
  return exploreRedoArtifactEntries(work, archive).map((entry) => entry.name)
}

/**
 * 归档保留份数：每种产物只留**最近这么多份**归档，更早的在下一次归档时清掉
 * （票 pipeline-wiring-gaps/08 的「归档件不再只进不出」）。取 10 是「够回看、又不至于让 工作区/ 无界长胖」的折中：
 * 一次驳回只多两件，用户真要回看十份之前的报告，回退（快照）那条路才是正经去处。
 */
const ARCHIVE_KEEP = 10


/**
 * 归档清理的越界守卫（也是删除点唯一的放行判据）：只认 `工作区/_旧版产物/` **直接**底下、
 * 形如 `<产物名>.<base36 毫秒时间戳>` 的**文件**。定点修改写下的 `深改-<id>/` 目录、
 * 别的族（最佳范例章/章节安排/重置重做）写下的归档，以及 `工作区/` 原位的产物都不在射程内。
 */
function assertArchiveEntry(name, entry, archive) {
  if (entry === '.' || entry === '..') return false
  if (entry.includes('/') || entry.includes('\\') || entry.includes('..')) return false
  if (!entry.startsWith(`${name}.`)) return false
  if (!/^[0-9a-z]+$/.test(entry.slice(name.length + 1))) return false
  const target = join(archive, entry)
  try {
    return dirname(target) === archive && statSync(target).isFile()
  } catch {
    return false
  }
}


/**
 * 归档保留策略：每种产物只留最近 `keep` 份，更早的在**下一次**归档时清掉。
 * 返回 `{ removed, failed }`（清掉几件 / 没清掉几件）——清理失败要能报出来，不能无声吞掉。
 * 导出是为了让测试**直调**这份策略（与 `gateMismatchError` 同一做法：不复制第二份判据）。
 */
export function trimExploreArchive(archive, names, keep) {
  let entries = []
  try { entries = readdirSync(archive) } catch { return { removed: 0, failed: 0 } }
  let removed = 0
  let failed = 0
  for (const name of names) {
    const copies = entries
      .filter((entry) => assertArchiveEntry(name, entry, archive))
      // 时间戳是 base36 的毫秒数：按**数值**排才是时间先后（按字符串排在位数变化时会错）。
      .map((entry) => ({ entry, at: Number.parseInt(entry.slice(name.length + 1), 36) }))
      .sort((a, b) => b.at - a.at)
    for (const copy of copies.slice(keep)) {
      try {
        unlinkSync(join(archive, copy.entry))
        removed += 1
      } catch {
        failed += 1
      }
    }
  }
  return { removed, failed }
}


/** 动作族 · 关卡拍板：'gate-decide' / 'explore-confirm' / 'outline-confirm' / 'chapters-review-confirm' / 'final-approve' / 'rollback'。 */
export const actGates = familyOf('gates', async ({ ctx: ctx, action: action, sessionId: sessionId, project: project, body: body }) => {
  switch (action) {
    case 'gate-decide': {
      const { gate, version, approved, mode, reasons, note } = body
      const gateId = String(gate)
      if ((gateId === '' || gateId === 'undefined') || typeof version !== 'number' || typeof approved !== 'boolean') {
        return reject(400, 'gate-decide 需要 gate/version/approved')
      }
      assertSessionOwned(project, sessionId)
      const current = foldGate(project)
      if (current === null || current.gate !== gateId || current.version !== version) {
        return reject(409, gateMismatchError(current))
      }
      if (current.status !== 'awaiting') {
        return reject(409, gateAlreadyDecidedError(current))
      }
      const event = appendEvent(project, 'textbook/gate-decision', {
        gate: gateId,
        version,
        approved,
        mode: typeof mode === 'string' ? mode : null,
        reasons: Array.isArray(reasons) ? reasons.filter((item) => typeof item === 'string') : [],
        note: typeof note === 'string' ? note : '',
      })
      // 原先这里还「读状态 → meta.updatedAt = event.time → 整份写回」：那个写回纯属多余
      // （appendEvent 已经把 updatedAt 记成 event.time），却会把账高带回读状态那一刻的旧值（票 02）。已删。
      // ⚠️ 票 `deep-module-scan/10`：原先这里直接 `gateWaiters.get(project)`、比对 `gate`/`version`
      // 两个字段、再 `.resolve()`——也就是 `gateWaiters` 的三字段协议**有一半住在这个文件里**。
      // 现在只说「兑现这一次的拍板」，比对与兑现都在 engine 内（`resolveGateDecision`）。
      resolveGateDecision(project, gateId, version)
      void kick(ctx, project)
      return accept({ project, event })
    }
    case 'explore-confirm': {
      // 用户确认探查结果：true → 进设计；false → 归档重做（可带一句"哪里不满意"，重做时 AI 必看）。
      assertSessionOwned(project, sessionId)
      const exMeta = readMeta(project)
      if (exMeta === null || exMeta.status !== 'awaiting-explore') {
        return reject(409, '当前没有等待确认的探查结果')
      }
      const approved = body.approved === true
      if (approved) {
        // ── 票 `premature-announce/01`：**放行那一跳过同一份就绪判据**────────────────────
        // 病（2026-10-10 实跑）：这一段还没做完就点「满意」，原先会 200 并 `advance(2,3)` 把书推过去，
        // 而 `工作区/knowledge-map.json` 只在交工成功支里诞生 ⇒ 它**永久缺位**；回去的路又被
        // `stage-submit` 的 pendingStage 闸焊死（那条 400 指着「先补探查交工」，而那一跳当天走不通）。
        // ⚠️ 判据与置态、交工验货**同一份**（`exploreArtifactProblems`）——⛔ 不许在这里另抄一份枚举。
        // ⚠️ 这不是「调用方把请求写错了」那类 409：是**用户的一次真实动作被系统挡住**，所以照本文件
        //    「归档没生效」那条先例**落一条账再拒收**（`CONTEXT.md`「验货」词条 2026-10-10 的例外条）。
        const notReady = exploreArtifactProblems(project, exMeta).problems
        if (notReady.length > 0) {
          appendEvent(project, 'textbook/hint', {
            text: `⛔ 还不能确认探查结果：${notReady.join('；')}。这几件是机器验过的产物——等它们落齐再确认；要重来就点「🔁 让 AI 重做」。`,
          })
          return reject(409, `还不能确认探查结果：${notReady.join('；')}`)
        }
      }
      if (approved) {
        updateMeta(project, (meta) => {
          meta.exploreConfirmed = true
          meta.status = 'running'
          meta.pendingStage = null
          meta.pendingGate = null
          delete meta.exploreRedoNote
          // 票 pipeline-wiring-gaps/08：这一轮「来回 N 次」到此为止——用户认了这份报告，下一轮再计数。
          delete meta.exploreRedoCount
        })
        appendEvent(project, 'textbook/hint', { text: '✅ 探查结果已确认，开始做教学设计。' })
        advance(project, 2, 3)
        void kick(ctx, project)
        return accept({ project, approved: true })
      } else {
        // ── 票 `premature-announce/01`：**重做前先看还有几个小助手在写**（反向那一支）──────────
        // 病：这一段还在被写的时候点「让 AI 重做」，下面那段归档会把小助手**正在写**的产物一起搬进
        // `_旧版产物/`（搬走的那一份它再也写不回来）。
        // ⚠️ 处置**不是**去收回它们：`ctx.subagents.interrupt` 在本仓是登记过的禁读成员
        //（`dev/host-contract-gate/catalog/web-chat.js` 的 `forbiddenMemberReads`），
        //「收回小助手是主笔 AI 自己的事」——所以这里只**拒收 ＋ 说明**。
        // ⚠️ `null` ＝ 数不出来 ⇒ **不拦人**（「不知道」不是「有人在跑」；同「读不出不判旧」那条口径）。
        const running = await countRunningSubagents(ctx, sessionId)
        if (running !== null && running > 0) {
          appendEvent(project, 'textbook/hint', {
            text: `⛔ 现在还不能重做：还有 ${running} 个小助手在写这一段的产物，这一刻归档会把它们正在写的东西一起搬走。等它们回来再点「让 AI 重做」；想马上重做，先在对话里让 AI 停掉它们。`,
          })
          return reject(409, `还有 ${running} 个小助手在写这一段的产物，现在归档会把它们正在写的东西一起搬走——等它们回来再重做。`)
        }
        // 用户意见（可选）：理由点选 + 一句话，随重做交办带给 AI（重做唯一的改进方向）。
        const reasons = Array.isArray(body.reasons)
          ? body.reasons.filter((r) => typeof r === 'string' && r.trim() !== '').slice(0, 5)
          : []
        const note = textField(body.note, GATE_NOTE_MAX)
        const feedback = [...reasons, note].filter((t) => t !== '')
        const archive = join(workDir(project), '_旧版产物')
        mkdirSync(archive, { recursive: true })
        const stamp = Date.now().toString(36)
        // 票 pipeline-wiring-gaps/08：归档不再「尽力」——逐件记成败，**任一件没搬走就当场回错误**。
        // 旧件留在原位时，下一轮 `runPhase2`（engine.js:1583「产物已存在 → 等人确认」）见到
        // `explore.md` 还在就直接短路返回，于是用户点完「让 AI 重做」看到的还是上一轮那份
        // 一模一样的报告，他写的意见又会在点「满意」时被删掉——那一次重做从来没发生过，
        // 而整条路径全程静默。`mkdirSync` 在 try 之外（它抛就是 500，本来就响）。
        const archiveMisses = []
        // 票 03：清单是**算出来的**（固定两件 + 盘上现存的精读分片件／细目件），不是写死的那两个字面量。
        // 票 11：取 entries 而不是 names——细目在 `工作区/细目/` 子目录里，
        // `workFile(project, name)` 对它恒 miss（那会拼成 `工作区/<name>`），所以来处要一起带上。
        const redoEntries = exploreRedoArtifactEntries(workDir(project), archive)
        // 源这一端按**书夹相对路径**拼（`工作区/…`），不拿扫描目录的绝对路径兜着——
        // 「这一件长在书夹里」由 `projectDir` 那一层（PROJECT_ID_RE 限定）兑现。
        const bookRoot = projectDir(project)
        for (const { name, rel } of redoEntries) {
          const target = join(bookRoot, ...rel.split('/'))
          if (!existsSync(target)) continue
          try {
            renameSync(target, join(archive, `${name}.${stamp}`))
          } catch (error) {
            archiveMisses.push(`${name}（${String(error instanceof Error ? error.message : error)}）`)
          }
        }
        if (archiveMisses.length > 0) {
          // 一件都没交办：既不改状态，也不写 meta.exploreRedoNote——用户点「满意」时
          // 旧报告原样还在，意见没被消费过，也就不该在这里被「用掉」。
          // 意见本身记进账本（hint），所以它不会随这一次失败悄悄消失。
          appendEvent(project, 'textbook/hint', {
            text: `↩️ 探查重做没有生效：旧报告没能归档（${archiveMisses.join('、')}），它还留在原位。`
              + (feedback.length > 0 ? `你的意见（${feedback.join('；')}）已经记在这条账里，不会丢。` : '')
              + '请把正在占用这些文件的程序关掉（编辑器、同步盘、杀毒软件都可能占着）再点一次。',
          })
          return reject(409, `旧报告没能归档（${archiveMisses.join('、')}），这次「让 AI 重做」没有生效：旧报告还留在原位，直接重做会拿它当新结果。请关掉占用这些文件的程序后重试。`)
        }
        const trimmed = trimExploreArchive(archive, redoEntries.map((entry) => entry.name), ARCHIVE_KEEP)
        let redoCount = 0
        updateMeta(project, (meta) => {
          meta.status = 'running'
          meta.pendingStage = null
          meta.pendingGate = null
          meta.exploreRedoNote = feedback.length > 0 ? feedback.join('；') : null
          // 票 pipeline-wiring-gaps/08：探查侧的「来回几次了」（关卡侧是 `countRejections` 从账本折叠出来的，
          // 探查没有 gate-decision 事件，所以这份计数记在账本 meta 上，**唯一写入点就是这一行**）。
          // 记的是「真的重做过几次」：归档被闸门拒掉的那一次不算——那一次重做没有发生。
          meta.exploreRedoCount = (meta.exploreRedoCount ?? 0) + 1
          redoCount = meta.exploreRedoCount
        })
        appendEvent(project, 'textbook/hint', {
          text: feedback.length > 0
            ? `↩️ 探查结果已标记重做，你的意见（${feedback.join('；')}）已带给 AI，它正在重新探查。`
            : '↩️ 探查结果已标记重做（你没写具体意见），AI 会重新仔细通读后再来；想给它方向随时在对话里说。',
        })
        if (trimmed.removed > 0 || trimmed.failed > 0) {
          appendEvent(project, 'textbook/hint', {
            text: `🧹 归档清理：清掉了 ${trimmed.removed} 份更早的旧件（每种产物只留最近 ${ARCHIVE_KEEP} 份）`
              + (trimmed.failed > 0 ? `，另有 ${trimmed.failed} 份没清掉（文件被占用），留着不影响重做。` : '。'),
          })
        }
        // 措辞与关卡那一族一致（`runGate` 每 3 次一条）：反复驳回时提醒用户换思路，
        // 而不是让 AI 一份份地交几乎一样的报告。
        if (redoCount % 3 === 0) {
          appendEvent(project, 'textbook/hint', {
            text: `探查已经来回 ${redoCount} 次了。如果一直不满意，可以在对话里调整目标或换一种思路，或者用「定点修改」回到源探查重新来。`,
          })
        }
        handoffAndDrive(ctx, project, 'explore', null, '驳回探查结果、重做之前')
        return accept({ project, approved: false })
      }
      return
    }
    case 'outline-confirm': {
      assertSessionOwned(project, sessionId)
      const meta = readMeta(project)
      if (meta === null || meta.status !== 'awaiting-outline') {
        return reject(409, '当前没有等待确认的章节安排')
      }
      if (body.approved === true) {
        // ── 票 `premature-announce/01`：放行那一跳过一遍**这一段自己的**就绪判据 ──────────────
        // 与探查那两跳同一条纪律：不拿「状态已经推到 awaiting-outline」当「这一段真做完了」。
        // ⚠️ 这一份判据比探查那份窄（它只断盘上那两件）——窄处写在 `engine.outlineArtifactProblems`
        //    的注释里，别在这里另立一份。
        const notReady = outlineArtifactProblems(project, meta)
        if (notReady.length > 0) {
          appendEvent(project, 'textbook/hint', {
            text: `⛔ 还不能确认章节安排：${notReady.join('；')}。`,
          })
          return reject(409, `还不能确认章节安排：${notReady.join('；')}`)
        }
      }
      const note = textField(body.note, GATE_NOTE_MAX)
      const pick = Number(body.goldChapter)
      // 改选最佳范例章也要改在改法里（当场新读那份状态）：下面两笔事件之间原先夹着一次整份写回，
      // 会把账高带回读状态那一刻的旧值（票 02）。
      let pickedGold = false
      updateMeta(project, (state) => {
        if (body.approved === true && Number.isSafeInteger(pick) && pick >= 1 && pick <= (state.outline?.chapters ?? []).length) {
          if (state.goldChapter !== pick) {
            state.goldChapter = pick
            pickedGold = true
          }
        }
        if (body.approved === true) {
          state.status = 'running'
          delete state.outlineRedoNote
          // 驳回重排时 handoff 记过 pendingStage='outline'；拍板通过必须清掉，
          // 否则 stale 残留到 phase4/5（2026-09-03 实测：UI 误显「AI 干活中·章节骨架」）。
          state.pendingStage = null
          state.pendingGate = null
        } else {
          delete state.outline
          state.status = 'running'
          state.pendingStage = null
          state.pendingGate = null
          if (note !== '') state.outlineRedoNote = note
        }
      })
      if (pickedGold) {
        // 票 10（判定一 #3/#4）：「样例章」是界面词表外的叫法，这条 hint 会渲染到人眼，统一成「最佳范例章」。
        appendEvent(project, 'textbook/hint', { text: `📐 最佳范例章定为第 ${pick} 章。` })
      }
      appendEvent(project, 'textbook/outline-decision', { approved: body.approved === true, note })
      if (body.approved === true) {
        appendEvent(project, 'textbook/hint', { text: '✅ 章节安排已确认，开始写最佳范例章。' })
        advance(project, 3, 4)
        void kick(ctx, project)
      } else {
        const archive = join(workDir(project), '_旧版产物')
        mkdirSync(archive, { recursive: true })
        const stamp = Date.now().toString(36)
        const target = workFile(project, 'outline.md')
        if (existsSync(target)) { try { renameSync(target, join(archive, `outline.md.${stamp}`)) } catch { /* 尽力归档 */ } }
        appendEvent(project, 'textbook/hint', {
          text: note !== ''
            ? `↩️ 章节安排已驳回，你的意见（${note}）已带给 AI，它正在重新安排。`
            : '↩️ 章节安排已驳回（没写具体意见），AI 会重新安排；想给方向随时在对话里说。',
        })
        handoffAndDrive(ctx, project, 'outline')
      }
      return accept({ project, approved: body.approved === true })
    }
    case 'chapters-review-confirm': {
      // 全章过目确认：true → 开始合并；false → 记账 chaptersReviewed=false（可继续改意见，不会并发合并）。
      assertSessionOwned(project, sessionId)
      const meta = readMeta(project)
      if (meta === null || meta.status !== 'awaiting-chapters-review') {
        return reject(409, '当前没有等你过目的章节')
      }
      // 票 10 的服务端收口（死条件收口 · 票 14 的连带）：**确认过目时重验全书 chapterDone**。
      // 原先这里只看 status，于是「用户点翻案（review-revoke 把意见写回 pending）」之后书仍停在
      // awaiting-chapters-review，能直接确认 → 合并 → 交付——票 10「退回去之后这本书重新被这条意见拦住」
      // 就成了空话（真旁路）。判据复用 engine 的同一份 chapterDone / chapterGateMiss，**不写第二份**。
      if (body.approved === true) {
        const chapters = meta.outline?.chapters ?? []
        const misses = chapters
          .map((chapter, index) => ({ n: index + 1, chapter, miss: chapterGateMiss(project, index + 1, meta) }))
          .filter((row) => row.miss !== null)
        if (misses.length > 0) {
          const why = misses.slice(0, 3).map((row) => {
            const title = row.chapter?.title ?? ''
            // 正文那一项取 `chapterRel`（书夹相对路径，票 depth-review-2026-10/05）；
            // `audit-NN.md` 是 audit 族的同款契约、本票不收，仍用本地补零。
            // 两者同属一句人话、同一族词，所以正文用相对路径形（前面带 `工作区/`）。
            const pad = String(row.n).padStart(2, '0')
            const what = row.miss.reason === 'artifact'
              ? `缺产物（${chapterRel(row.n)} / 工作区/audit-${pad}.md）`
              : row.miss.reason === 'stale'
                ? '检查记录比正文旧（正文改过之后没重新审计，那份「审过」是旧稿的）'
                : row.miss.reason === 'review'
                  ? '还有未处置的抽查意见'
                  : '没有机器记下的交工通过（还没按章交工）'
            return `第${row.n}章${title === '' ? '' : `《${title}》`}：${what}`
          })
          return reject(409, `还没到能交工的时候：${why.join('；')}。逐章处置完（改稿 → 重新审计 → 交工点名）机器才会放行过目。`)
        }
      }
      // 过目记账与「开始合并」的置态一次收进改法（原先分两次整份写回，后一次还落在
      // 「记一笔」之后——账高会被带回旧值，票 02）。
      updateMeta(project, (state) => {
        state.chaptersReviewed = body.approved === true
        if (body.approved === true) {
          state.status = 'running'
          state.pendingStage = null
        }
      })
      appendEvent(project, 'textbook/chapters-review', { approved: body.approved === true })
      if (body.approved === true) {
        appendEvent(project, 'textbook/hint', { text: '✅ 全章过目通过，开始合并成书。' })
        handoffAndDrive(ctx, project, 'merge')
      }
      return accept({ project })
    }
    case 'final-approve': {
      // 终检结果认可（2026-08-26 用户拍板）：approved=true → 交付；false + note → 交办终检修订（原地循环）。
      assertSessionOwned(project, sessionId)
      const meta = readMeta(project)
      if (meta === null || meta.status !== 'awaiting-final-approval') {
        return reject(409, '当前没有等你认可的最后检查结果')
      }
      if (body.approved === true) {
        // ── 票 `premature-announce/01`：交付**撤不回**，所以放行那一刻**当场重算**一次硬检查 ──────
        // 原先这一支只判 `meta.status === 'awaiting-final-approval'`，一条产物、一项检查都不验；
        // 而那个状态另有别的写入点（演示支就在不判检查结果的情况下置它）。
        // ⚠️ **演示书是这条闸的分叉**（登记在 `src/demo-exemptions.js` 的 `final-approve-hard-checks`）：
        //    演示通道的 `awaiting-final-approval` 由 `engine.js` 的演示支置下、**有意不判检查结果**
        //    （它跑的是内置回放夹具，硬检查里那几项在它身上没有来源）——这是登记过的结构性到不了，
        //    不是本闸放水；真书一律当场重算。
        // ⚠️ 这里**不列**失败项的名字：检查名的界面译法住在前端（`src/ui/view-rules.js` 的 `CHECK_UI`），
        //    服务端不 import 前端模块；账上那条 hint 只说件数，逐项结论仍由工作台那一屏呈现。
        // ⚠️ **重跑本身会抛**（实测：盘上什么都没有时 `runQualityChecks` 直接 ENOENT）——那也算「不能交付」，
        //    所以这里连异常一起收下：**验不了就不放行**（⛔ 不许因为「检查跑不起来」把书放过去）。
        if (meta?.demo !== true) {
          let failed = null
          try {
            failed = runQualityChecks(project).filter((check) => check.ok !== true)
          } catch (error) {
            const why = error instanceof Error ? error.message : String(error)
            ctx?.logger?.warn?.(`textbook: 交付放行时重跑最后检查出错（按「不能交付」处置）: ${why}`)
            appendEvent(project, 'textbook/hint', {
              text: `⛔ 还不能交付：机器当场重跑最后检查时出错（${why}）——验不了就不放行。`,
            })
            return reject(409, `还不能交付：机器当场重跑最后检查时出错（${why}）——验不了就不放行，先修好再认可。`)
          }
          if (failed.length > 0) {
            appendEvent(project, 'textbook/hint', {
              text: `⛔ 还不能交付：机器当场又核了一遍最后检查，有 ${failed.length} 项没过（工作台那一屏逐项看得到是哪几项）。`,
            })
            return reject(409, `还不能交付：机器当场又核了一遍最后检查，有 ${failed.length} 项没过`)
          }
        }
        const delivered = updateMeta(project, (state) => {
          state.status = 'delivered'
          state.finalApprovedAt = Date.now()
        })
        appendEvent(project, 'textbook/final-approve', { approved: true })
        appendEvent(project, 'textbook/delivery', {
          checks: delivered.finalChecks ?? [],
          note: `交付完成！点「下载《${delivered.name ?? ''}》.md」保存成品。`,
        })
        return accept({ project, delivered: true })
      }
      const note = textField(body.note, GATE_NOTE_MAX)
      if (note === '') {
        return reject(400, '不满意最后检查结果必须写一句改进意见（AI 照着改整本后重新做最后检查）')
      }
      // 原地循环：交办终检修订，AI 按意见改整本 → 重新硬检查 → 再给用户认可。
      updateMeta(project, (state) => {
        state.status = 'running'
        state.pendingStage = null
        state.finalRedoNote = note
      })
      appendEvent(project, 'textbook/final-approve', { approved: false, note })
      appendEvent(project, 'textbook/hint', { text: '🔁 最后检查未获认可，AI 将按你的意见修整本后重新做最后检查。' })
      handoffAndDrive(ctx, project, 'final')
      return accept({ project, redo: true })
    }
    case 'rollback': {
      assertSessionOwned(project, sessionId)
      const { snapshot } = body
      const seq = Number(snapshot)
      if (!Number.isSafeInteger(seq) || seq < 0) {
        return reject(400, 'rollback 需要合法的 snapshot 序号')
      }
      writeSnapshot(project, `回退到快照 ${seq} 之前`)
      const event = restoreSnapshot(project, seq)
      // 回退后清掉交办标记，让状态机根据账本重新推导（文件产物保留，由验货逻辑复用）。
      // 注意走 updateMeta：账本刚被 rollbackLedger 截短、账高已回到笔数，这里不许再整份写回。
      updateMeta(project, (meta) => {
        delete meta.pendingStage
        delete meta.pendingGate
        delete meta.wakeToken
        meta.status = 'running'
      })
      void kick(ctx, project)
      return accept({ project, event })
    }
  }
})
