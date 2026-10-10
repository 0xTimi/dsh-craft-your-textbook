/**
 * explore 合并件（`工作区/knowledge-map.json`）的**机器按键拼装**
 * （票 `.scratch/context-budget/issues/17` · ADR-0030 决策 2 的延续）。
 *
 * ## 它做什么／不做什么（这一段就是本模块的边界，别在别处另写一句）
 *
 * - **做**：把各精读小助手落盘的分片 `工作区/knowledge-map-NN.json` 按**分片序号顺序**按键拼接
 *   （`materials` / `knowledgePoints` 这类数组键首尾相接），再叠上**主笔交来的书级聚合**
 *   （`teachingFocus` / `chapterSuggestion`），拼成一份固定的 JSON 落 `工作区/knowledge-map.json`。
 *   它是**各分片 ＋ 书级两键的确定函数**——同一份输入必然逐字同一份输出（不读时钟、不写随机数）。
 * - **不做**：**不产书级判断**（`teachingFocus` / `chapterSuggestion` 只能由主笔产出，机器一个字都不改），
 *   也**不出裁决**（合并件里多出一个「结论／通过」这类键就是机器越权——判据点名它）。
 *
 * ## 病与先例
 *
 * 实测（`.scratch/context-budget/研究-范例章通过后的注入面.md` 附录 B/C）：主笔为了把一片分片
 * 抄成合并件，`write` 入参 24,025 字符（那一段 write 参数合计的 88%），而两份的差异**只有书级
 * 两个字段**。先例是票 `context-budget/12` 落地的 `final-audit-summary.js`：机器拼一份派生件、
 * 同输入同输出、并集不丢不重、零条目那一路有交代、机器不出裁决。本模块是**同一把刀**用到 explore 段。
 *
 * ## 这一层只断接线与形状（判据声称的强度＝实现强度）
 *
 * {@link judgeKnowledgeMapAssembly} 断的是「盘上那份合并件是不是那几片分片 ＋ 书级两键的确定函数」：
 * 键集合与分片一致、按分片序号拼（**顺序即契约**）、不丢不重、书级字段没被改写、没混进机器裁决。
 * 它**不证**分片内容对不对、也**不证**主笔真读了那份合并件——那两层是真机层（ADR-0005）。
 */
import { knowledgeShardRel } from '../domain-rules.js'

/** 书级聚合两个键：只由主笔产出、机器一个字不改。顺序也是契约（合并件的键序固定）。 */
export const BOOK_LEVEL_KEYS = Object.freeze(['teachingFocus', 'chapterSuggestion'])

/**
 * 分片契约里**每片都必须有**的两个数组键（形状的权威源＝精读派发模板
 * `resources/references/subagent-prompts/close-reading-prompt.md` 的「产出契约二」＋ explore 交办）。
 * ⚠️ 这里再列一遍是**为了零片那一路**：零片时没有任何一片可作依据，合并件仍要交出这两个空数组
 * （把键悄悄省掉等于下游读到的形状变了——那是另一件事，不是「没有内容」）。
 *
 * ⚠️ **我的枚举面比现实窄在哪里**（票 `dev-gate-scan/17` 的纪律）:这份常量只列**今天契约里的两个键**。
 * 一片若带了契约没写的**别的数组键**，它照样会被 {@link expectedKnowledgeMap} 从分片里拼进合并件
 * （那里是按分片实际键走的，不受这份常量限制）——所以「窄」的影响面只有**零片**这一档：
 * 零片时合并件只交这两个键，多出来的键只能来自下游读法变更，不来自这里。
 */
export const SHARD_ARRAY_KEYS = Object.freeze(['materials', 'knowledgePoints'])

/** 分片自己的身份键：不进合并件（它是「这份是第几路」的登记，不是内容）。 */
const SHARD_ID_KEY = 'num'

/** 合并件里**不许**出现的键名——JSON 里的「机器裁决」就是这类多出来的键。
 *
 *  ⚠️ **我的枚举面比现实窄在哪里**（票 `dev-gate-scan/17` 的纪律）:这是一张**固定词表**，
 *  只认得这几种写法。换一个说法的裁决键（如 `result_code`、`machineVerdict`）仍会被判红，
 *  只是文案落在那条更宽的「拼装件只许有分片数组键与书级两键」上、不带「机器裁决」四个字
 *  ——**红是红的**，认不认得出来靠人看那句话。词表不追现实，是因为「哪些键算裁决」本身是判断题。 */
const VERDICT_KEY_RE = /^(?:结论|判定|裁决|检查结果|passed|verdict|result|ok)$/u

// ── 形状（交工验货与判据共用这一段：两处不会各写一套说法）──────────────────────

/**
 * 分片的形状问题（空数组＝能拼）。逐条点名**是第几路**（拼不出来时主笔要知道去补哪一片）。
 *
 * @param {ReadonlyArray<{n: number, map: unknown}>} shards
 * @returns {string[]}
 */
export function shardShapeProblems(shards) {
  const problems = []
  for (const shard of Array.isArray(shards) ? shards : []) {
    const n = shard?.n
    const map = shard?.map
    const where = Number.isSafeInteger(n) ? knowledgeShardRel(n) : '（序号不明的那一片）'
    if (map === null || typeof map !== 'object' || Array.isArray(map)) {
      problems.push(`第 ${n} 路的分片不是 JSON 对象：${where} —— 机器按键拼装需要它是一个对象`)
      continue
    }
    for (const [key, value] of Object.entries(map)) {
      if (key === SHARD_ID_KEY || Array.isArray(value)) continue
      problems.push(`第 ${n} 路的分片里「${key}」不是数组：${where} —— 按键拼接只能拼数组（这一片的形状与精读契约不一致）`)
    }
    if (!Array.isArray(map.knowledgePoints)) {
      problems.push(`第 ${n} 路的分片没有 knowledgePoints 数组：${where} —— 每片都要带这一份的知识点`)
    }
  }
  return problems
}

// ── 拼装（纯函数：分片 ＋ 书级两键 → 一份，逐字确定）──────────────────────────

/**
 * 各分片 ＋ 书级两键 → 「应该是那样」的**结构**（拼装与判据共用它，于是判据不是另写一份量法）。
 *
 * 拼接规则（口径只此一份）：按 `shards` 给的顺序（＝ `okMaterialShards` 的序号顺序）逐片取
 * **数组键**，同名键首尾相接；键序＝该键在分片里**首次出现**的顺序。`num` 不进合并件。
 *
 * @param {ReadonlyArray<{n: number, map: unknown}>} shards
 * @param {{teachingFocus?: unknown, chapterSuggestion?: unknown}} bookLevel 主笔交来的书级两键
 * @returns {Record<string, unknown>}
 */
export function expectedKnowledgeMap(shards, bookLevel) {
  const out = {}
  for (const key of SHARD_ARRAY_KEYS) out[key] = [] // 零片那一路也要交出这两个键（见上面那条注记）
  for (const shard of Array.isArray(shards) ? shards : []) {
    const map = shard?.map
    if (map === null || typeof map !== 'object' || Array.isArray(map)) continue
    for (const [key, value] of Object.entries(map)) {
      if (key === SHARD_ID_KEY || !Array.isArray(value)) continue
      out[key] = Object.hasOwn(out, key) ? [...out[key], ...value] : [...value]
    }
  }
  for (const key of BOOK_LEVEL_KEYS) {
    const value = bookLevel === null || typeof bookLevel !== 'object' ? undefined : bookLevel[key]
    // ⚠️ 主笔没交这一键时**不替它编**（交工验货当场 400）；机器只做搬运。
    if (value !== undefined) out[key] = value
  }
  return out
}

/** 由结构渲染成全文（**生产落盘与判据核对走同一个渲染器**：缩进与键序都不会两处各写一份）。 */
export function renderKnowledgeMap(map) {
  return JSON.stringify(map, null, 2)
}

/**
 * 分片 ＋ 书级两键 → 合并件全文。**同输入同输出**（这是本票判据里那句「重拼逐字相同」的被测面）。
 *
 * @param {ReadonlyArray<{n: number, map: unknown}>} shards
 * @param {{teachingFocus?: unknown, chapterSuggestion?: unknown}} bookLevel
 * @returns {string}
 */
export function assembleKnowledgeMap(shards, bookLevel) {
  return renderKnowledgeMap(expectedKnowledgeMap(shards, bookLevel))
}

// ── 判据（那把尺子；坏形状喂进**同一段**它，不另写一份「相似的量法」）──────────────

/** 一条条目的**可读点名**（id / title 优先，都好让「哪一条」说得出来）。 */
function entryText(value) {
  if (value !== null && typeof value === 'object') {
    const label = value.id ?? value.title ?? value.text
    if (typeof label === 'string' && label.trim() !== '') return label.trim()
    return JSON.stringify(value).slice(0, 60)
  }
  return String(value)
}

/** 条目身份＝逐字相同的 JSON（「同一条」按内容判，不猜语义——猜错就是静默丢条目）。 */
const entryKey = (value) => JSON.stringify(value)

const countOf = (list, entry) => list.filter((value) => entryKey(value) === entryKey(entry)).length

/**
 * 某一个数组键的**顺序与不丢不重**（逐片比）：少一条／多印／多出来／顺序被换，各自点名。
 *
 * @param {string} key
 * @param {unknown[]} got 合并件里那一键
 * @param {ReadonlyArray<{n: number, map: unknown}>} shards
 * @returns {string[]}
 */
function judgeKeySequence(key, got, shards) {
  const problems = []
  const blocks = shards.map((shard) => ({
    n: shard?.n,
    block: Array.isArray(shard?.map?.[key]) ? shard.map[key] : [],
  }))
  const expected = blocks.flatMap(({ block }) => block)
  // ⓐ 少了一条：某片的某条在合并件里一条都没有（点名分片序号 ＋ 那一条）。
  for (const { n, block } of blocks) {
    for (const entry of block) {
      if (countOf(got, entry) === 0) {
        problems.push(`第 ${n} 路分片的「${entryText(entry)}」没出现在合并件的 ${key} 里（少了一条）`)
      }
    }
  }
  // ⓑ 不重：某条出现了比它该有的次数更多（同一片被印了两遍）。
  for (const { n, block } of blocks) {
    for (const entry of block) {
      const times = countOf(got, entry)
      const should = countOf(expected, entry)
      if (times > should) {
        problems.push(`第 ${n} 路分片的「${entryText(entry)}」在合并件的 ${key} 里出现了 ${times} 次（应为 ${should} 次——重复印了同一片的内容）`)
      }
    }
  }
  // ⓒ 多出一条：合并件里有、任何一片都没有（机器自己编的内容）。
  for (const entry of got) {
    if (countOf(expected, entry) === 0) {
      problems.push(`合并件的 ${key} 里多出一条「${entryText(entry)}」——分片里没有这一条（机器不许自己编内容）`)
    }
  }
  // ⓓ 顺序：条数与内容都对得上、但位置不对 ⇒ 拼装顺序是契约，不是随缘。
  const sameMultiset = got.length === expected.length
    && expected.every((entry) => countOf(got, entry) === countOf(expected, entry))
  if (sameMultiset && got.length > 0) {
    const at = got.findIndex((entry, i) => entryKey(entry) !== entryKey(expected[i]))
    if (at >= 0) {
      problems.push(`合并件的 ${key} 顺序与分片序号不一致（第 ${at + 1} 条应是「${entryText(expected[at])}」，实为「${entryText(got[at])}」）——拼装顺序是契约`)
    }
  }
  return problems
}

/**
 * 判一份合并件是不是**那几片分片 ＋ 书级两键的确定函数**。返回问题清单，空数组＝站得住。
 *
 * ⚠️ **扫面非空下限**（防空跑）：零片时「键集合与分片一致」这句话恒真，所以这里先断
 * 「至少有一片」与「主笔真交了书级两键」，各自点名；反证正是把这两个形状喂回**这一段**。
 *
 * @param {string} text 盘上那份 `工作区/knowledge-map.json` 的全文
 * @param {ReadonlyArray<{n: number, map: unknown}>} shards 盘上那几片（按分片序号）
 * @param {{teachingFocus?: unknown, chapterSuggestion?: unknown}} bookLevel 主笔交来的书级两键
 * @returns {string[]} 逐条点名的问题
 */
export function judgeKnowledgeMapAssembly(text, shards, bookLevel) {
  const problems = []
  const list = Array.isArray(shards) ? shards : []

  // ① 扫面非空：一片都没有时，后面的「键集合与分片一致」全是恒真的空转。
  if (list.length === 0) {
    problems.push('输入的分片只有 0 片（防空跑：一片都没有时「合并件＝各分片的确定函数」这句话恒真）')
  }
  // ② 书级两键必须**由主笔交来**（机器不产书级判断，缺了也不许由机器补）。
  for (const key of BOOK_LEVEL_KEYS) {
    const submitted = bookLevel === null || typeof bookLevel !== 'object' ? undefined : bookLevel[key]
    if (!Array.isArray(submitted) || submitted.length === 0) {
      problems.push(`主笔没交「${key}」（书级聚合只能由主笔产出——机器不会替它编一份）`)
    }
  }
  if (problems.length > 0) return problems
  const shapes = shardShapeProblems(list)
  if (shapes.length > 0) return shapes

  // ③ 合并件是机器产物：它的形状就是它的契约（不是严格 JSON 对象就什么都无从谈起）。
  let got = null
  try {
    got = JSON.parse(String(text ?? ''))
  } catch (error) {
    return [`盘上那份合并件不是严格 JSON：${error.message}`]
  }
  if (got === null || typeof got !== 'object' || Array.isArray(got)) {
    return ['盘上那份合并件不是一个 JSON 对象']
  }

  const want = expectedKnowledgeMap(list, bookLevel)
  const wantKeys = Object.keys(want)

  // ④ 键集合：分片数组键的并 ＋ 书级两键，多一个少一个都点名。
  //    「多出来的那个键」若是结论／通过那一类，就是**机器裁决**——那正是本族要挡的那一件。
  for (const key of Object.keys(got)) {
    if (wantKeys.includes(key)) continue
    problems.push(VERDICT_KEY_RE.test(key)
      ? `合并件多出一个键「${key}」——机器裁决：裁决归主笔 AI，合并件只许有分片里的数组键与书级两键`
      : `合并件多出一个键「${key}」——拼装件只许有分片里的数组键与书级两键`)
  }
  for (const key of wantKeys) {
    if (!Object.hasOwn(got, key)) problems.push(`合并件少了键「${key}」——分片或主笔交来的那一份里有、拼装件里没有`)
  }

  // ⑤ 逐键对账：**分片的数组键**按分片序号逐片比（顺序是契约）；**书级两键**逐字相等
  //    （机器不许改写主笔的判断——它们不是「拼接出来的」，所以不走顺序那条路）。
  for (const key of wantKeys) {
    if (!Object.hasOwn(got, key)) continue
    if (BOOK_LEVEL_KEYS.includes(key)) {
      if (entryKey(got[key]) !== entryKey(want[key])) {
        problems.push(`合并件的「${key}」与主笔交来的那一份不一致——书级聚合只由主笔产出，机器不许改写（实为「${entryText(got[key])}」）`)
      }
      continue
    }
    problems.push(...judgeKeySequence(key, Array.isArray(got[key]) ? got[key] : [], list))
  }
  return problems
}
