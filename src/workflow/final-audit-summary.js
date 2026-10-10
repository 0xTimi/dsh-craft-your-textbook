/**
 * 终检五份分报告的**机器无损拼装**（票 `.scratch/context-budget/issues/12` · ADR-0030 决策 18–20）。
 *
 * ## 它做什么／不做什么（这一段就是本模块的边界，别在别处另写一句）
 *
 * - **做**：把五份分报告里的**逐条点名条目**取出来，按**并集（去重）**排成一份固定形状的文件，
 *   落在 `工作区/报告/final-summary.md`（路径契约单一持有：`domain-rules.finalAuditSummaryRel`）。
 *   汇总件**是五份的确定函数**——同一份输入必然逐字同一份输出，且能被 {@link parseFinalAuditSummary} 读回来。
 * - **不做**：**不出裁决**。全文没有「通过／不通过」，五份各自的结论一份都不合并、不替代
 *   （这正是 ADR-0027 决策 2 被本票**收紧**后的口径：收紧为「不合并结论、不替代各自结论」，
 *   落一份**派生**汇总件不算合成——记账见 `docs/adr/0027-终检改派五个小助手分查.md` 的 Amendment）。
 *
 * ## 这一层只断接线与形状（判据声称的强度＝实现强度）
 *
 * {@link judgeFinalAuditSummary} 断的是「这份汇总件是不是那五份的确定函数、条目有没有丢或重、
 * 有没有混进机器裁决」——**不证**五份查得准不准、也不证点名属实（真机层，票 `context-budget/10`）。
 *
 * ## 为什么判据长这样
 *
 * · **条目＝报告里的列表项**（`- …` / `* …` / `+ …`，与跨章审计那道门同一份形状），
 *   报告形状由方法论文档 §10.b 定（结论＋逐条问题＋每条给证据＋分级）。
 *   带「结论／判定／裁决」前缀的行**不算条目**——机器不搬运结论。
 * · **去重按条目正文逐字相同**（先 trim）。逐字相同才合并，措辞不同的两条各算一条——
 *   宁可多列一条让人看，也不让机器猜「这两句是不是同一件事」；猜错就是静默丢条目。
 * · **一条只印在第一次提到它的那一路节里**，标签 `【第 1、4 路】` 列全部提到它的路：
 *   去重要**可见**（「不丢不重」不是空话），而**出处必须留住**（这一条是哪几路查出来的）。
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { FINAL_AUDIT_SCOPES, finalAuditReportName, finalAuditReportRel, finalAuditSummaryName, finalAuditSummaryRel } from '../domain-rules.js'
import { reportDir } from './engine/paths.js'

// ── 形状常量（判据与拼装共用这一份：判据按内容定位，不许另抄一份文件名）──────────

/** 首行标题（逐字是形状的一部分）。 */
const TITLE = '# 最后检查五份分报告 · 机器汇总'

/**
 * 标题下面的三句口径声明（逐字是形状的一部分）。
 * ⚠️ 这三句里**一个字都不许出现「通过／不通过」**——它们是声明，不是裁决；
 * 判据 {@link judgeFinalAuditSummary} 的裁决行检查逐行扫，声明句自己先要过得了那一关。
 */
const PREAMBLE = Object.freeze([
  '> 本文件由机器按固定形状**无损拼装**：条目＝五份分报告里逐条点名条目的**并集**（同一条只出现一次，不丢不重）。',
  '> **机器不出裁决**：每一路自己的结论与证据都在它那份原文里，这一份只列条目。',
  '> 协调员**只改下面点名到的条目**，不通读全书；要全文按各节「来源」那行去读对应那一份。',
])

/** 节标题（逐字是形状的一部分）。 */
function sectionHeading(row) {
  return `## 第 ${row.n} 路 · ${row.scope}`
}

/** 每节的来源行（路径逐字取自 `domain-rules.finalAuditReportRel`——判据与这里读的是同一份）。 */
function sourceLine(n, count) {
  return `来源：\`${finalAuditReportRel(n)}\`｜本路点名 ${count} 条`
}

/** 一份报告里的点名条目：一条一行列表项（与 `cross-audit.js` 的 `BULLET_RE` 同一份形状）。 */
const BULLET_RE = /^[ \t]*[-*+][ \t]+(\S.*?)\s*$/

/**
 * 「结论／判定／裁决」行——**不算点名条目**（机器不搬运结论）。
 * ⚠️ 必须**锚在行首**（可带列表符与 `**` 记号）：条目正文里提到「结论：」是常事
 * （`- 第 1 章的「结论：不对」`），不锚住就会把一条真条目判成裁决行。
 */
const VERDICT_LINE_RE = /^[ \t]*(?:[-*+][ \t]+)?(?:\*\*)?(?:结论|判定|裁决|检查结果)(?:\*\*)?[ \t]*[:：]/

/** 整行就是一个裁决词（`- 通过` / `**不通过**。`）——同样不是点名条目。 */
const BARE_VERDICT_RE = /^[ \t]*(?:[-*+][ \t]+)?\*{0,2}(?:不通过|未通过|通过)\*{0,2}[ \t]*[。.!！]?$/

/** 汇总件里的条目行：`- 【第 1、4 路】条目正文`（路号在前、正文在后 ⇒ 正文可以含几乎任何字符）。 */
const ITEM_LINE_RE = /^[ \t]*-[ \t]+【第\s*([\d、]+)\s*路】[ \t]*(\S.*?)\s*$/

/** 「本路没有点名条目」那一行（逐字是形状的一部分）。 */
const EMPTY_SECTION_LINE = '（本路没有点名条目。）'

/** 一段文字（可带 `> ` 引用记号）像不像一条**机器裁决**。 */
function looksLikeVerdict(text) {
  const line = String(text ?? '').replace(/^[ \t]*>[ \t]?/, '').trim()
  return VERDICT_LINE_RE.test(line) || BARE_VERDICT_RE.test(line)
}

// ── 拼装（纯函数：五份 → 一份，逐字确定；无时钟、无随机、无环境）──────────────

/**
 * 一份分报告里的**点名条目**（逐字、保持原顺序；去首尾空白，空条目丢弃）。
 * @param {string} text 一份 `工作区/报告/final-NN.md` 的全文
 * @returns {string[]}
 */
export function finalAuditItemsOf(text) {
  const out = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = BULLET_RE.exec(line)
    if (m === null) continue
    if (looksLikeVerdict(m[1])) continue
    out.push(m[1])
  }
  return out
}

/**
 * 五份 → 「应该是那样」的**结构**（拼装与判据共用它，于是判据不是另写一份「相似的量法」）。
 *
 * @param {ReadonlyArray<{n: number, text: string}>} reports 五份，按 `FINAL_AUDIT_SCOPES` 的序号给
 * @returns {{sections: {n: number, scope: string, rel: string, items: {text: string, routes: number[]}[]}[],
 *            unionSize: number, perReport: number[]}}
 */
export function expectedSummary(reports) {
  const list = Array.isArray(reports) ? reports : []
  const sections = []
  const perReport = []
  const firstSeen = new Map() // 条目正文 → 那一份 {text, routes, section}
  for (const row of FINAL_AUDIT_SCOPES) {
    const items = finalAuditItemsOf(list.find((r) => r.n === row.n)?.text)
    perReport.push(items.length)
    const mine = []
    for (const text of items) {
      const at = firstSeen.get(text)
      if (at === undefined) {
        const entry = { text, routes: [row.n], section: row.n }
        firstSeen.set(text, entry)
        mine.push(entry)
      } else {
        at.routes.push(row.n)
      }
    }
    sections.push({
      n: row.n,
      scope: row.scope,
      rel: finalAuditReportRel(row.n),
      items: mine,
    })
  }
  return { sections, unionSize: firstSeen.size, perReport }
}

/** 由「应该是那样」的结构渲染出全文（**拼装与判据的形状核对走同一个渲染器**）。 */
function renderSummary(expected) {
  const lines = [TITLE, '', ...PREAMBLE, '']
  for (const section of expected.sections) {
    lines.push(sectionHeading(section), '', sourceLine(section.n, section.items.length), '')
    if (section.items.length === 0) {
      lines.push(EMPTY_SECTION_LINE, '')
      continue
    }
    for (const item of section.items) lines.push(`- 【第 ${item.routes.join('、')} 路】${item.text}`)
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * 五份分报告 → 一份派生汇总件的全文。**同输入同输出**。
 * @param {ReadonlyArray<{n: number, text: string}>} reports
 * @returns {string}
 */
export function assembleFinalAuditSummary(reports) {
  return renderSummary(expectedSummary(reports))
}

// ── 读回（可解析：汇总件必须能被机器读成结构，才谈得上「确定函数」）──────────────

/**
 * 把汇总件读回结构。
 *
 * @param {string} text 汇总件全文
 * @returns {{title: string, preamble: string[], sections: {heading: string, source: string,
 *            items: {routes: number[], text: string}[], stray: string[]}[]}}
 *   `sections[].heading` 是**整行**（含 `## `），好让判据拿它与 `sectionHeading()` 逐字相等。
 */
export function parseFinalAuditSummary(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const out = { title: lines[0] ?? '', preamble: [], sections: [] }
  let current = null
  for (const line of lines.slice(1)) {
    if (line.trim() === '') continue
    const heading = /^##\s+\S/.test(line)
    if (heading) {
      // ⚠️ 存**整行**（含 `## `）：节标题的逐字形状由 `sectionHeading()` 那一份给出，
      // 判据按内容比对时两边必须能直接相等，少剥一次前缀就会让「五节逐字」这条恒不成立。
      current = { heading: line, source: '', items: [], stray: [] }
      out.sections.push(current)
      continue
    }
    if (current === null) { out.preamble.push(line); continue }
    if (current.source === '' && line.startsWith('来源：')) { current.source = line; continue }
    const item = ITEM_LINE_RE.exec(line)
    if (item !== null) {
      current.items.push({
        routes: item[1].split('、').map((v) => Number(v.trim())).filter((v) => Number.isSafeInteger(v)),
        text: item[2],
      })
      continue
    }
    if (line === EMPTY_SECTION_LINE) continue
    current.stray.push(line)
  }
  return out
}

// ── 判据（那把尺子；反证喂进**同一段**它，不另写一份「相似的量法」）──────────────

/**
 * 判一份汇总件是不是**那五份的确定函数**。返回问题清单，空数组＝站得住。
 *
 * ⚠️ **扫面非空下限**（防空跑）：五份零条目 ⇒ 并集为空 ⇒「并集＝期望」这句话恒真。
 * 所以这里断三个下限——「五份各存在且非空」「并集非空」「并集 ≥ 五份各自条目数的最大值」——
 * 各自点名；反证正是把「五份零条目」那个形状喂回**这一段**。
 *
 * @param {string} summaryText 汇总件全文（盘上那一份）
 * @param {ReadonlyArray<{n: number, text: string}>} reports 五份分报告的全文
 * @returns {string[]} 逐条点名的问题
 */
export function judgeFinalAuditSummary(summaryText, reports) {
  const problems = []
  const list = Array.isArray(reports) ? reports : []

  // ① 扫面非空：五份各存在且非空（输入空 ⇒ 后面全是恒真）。
  if (list.length !== FINAL_AUDIT_SCOPES.length) {
    problems.push(`输入的分报告只有 ${list.length} 份，不是 ${FINAL_AUDIT_SCOPES.length} 份（判据扫面非空：五份没齐就没得拼）`)
  }
  for (const row of FINAL_AUDIT_SCOPES) {
    const found = list.find((r) => r.n === row.n)
    if (found === undefined) problems.push(`第 ${row.n} 路分报告没进来（判据扫面非空）`)
    else if (String(found.text ?? '').trim() === '') problems.push(`第 ${row.n} 路分报告是空的（判据扫面非空）`)
  }
  if (problems.length > 0) return problems

  // ② 并集非空 ＋ 下限：并集条数 ≥ 五份各自条目数的最大值。
  const expected = expectedSummary(list)
  const maxPerReport = Math.max(...expected.perReport)
  if (expected.unionSize === 0) {
    problems.push('五份分报告一条点名都没有 ⇒ 并集为空：「汇总件＝五份的确定函数」这句话会恒真（防空跑）')
  }
  if (expected.unionSize < maxPerReport) {
    problems.push(`并集只有 ${expected.unionSize} 条，比五份里条目最多的那一份（${maxPerReport} 条）还少（去重把条目丢了）`)
  }

  // ③ 形状：标题、口径声明、五节逐字（文档写了形状，判据就断那个形状）。
  const got = parseFinalAuditSummary(summaryText)
  if (got.title !== TITLE) problems.push(`首行标题不是「${TITLE}」（实为「${got.title}」）`)
  if (got.preamble.length !== PREAMBLE.length) {
    problems.push(`口径声明有 ${got.preamble.length} 行，应为 ${PREAMBLE.length} 行（多出来的行不是机器拼装形状的一部分）`)
  }
  for (const [i, line] of PREAMBLE.entries()) {
    if (got.preamble[i] !== line) problems.push(`口径声明第 ${i + 1} 行与机器拼装的那份不一致（实为「${got.preamble[i] ?? '(缺)'}」）`)
  }
  if (got.sections.length !== expected.sections.length) {
    problems.push(`汇总件里有 ${got.sections.length} 个分路小节，应为 ${expected.sections.length} 个（五份逐路各一节）`)
  }

  // ④ 逐节对账：节标题、来源行、条目**逐条**点名（丢／重／改／多各自一句，不合并）。
  for (const want of expected.sections) {
    const have = got.sections.find((s) => s.heading === sectionHeading(want)) ?? null
    if (have === null) {
      problems.push(`缺第 ${want.n} 路那一节（要写的是「${sectionHeading(want)}」）`)
      continue
    }
    if (have.source !== sourceLine(want.n, want.items.length)) {
      problems.push(`第 ${want.n} 路的来源行不是「${sourceLine(want.n, want.items.length)}」（实为「${have.source || '(缺)'}」）`)
    }
    const wantByText = new Map(want.items.map((entry) => [entry.text, entry.routes]))
    const seen = new Map()
    for (const item of have.items) seen.set(item.text, (seen.get(item.text) ?? 0) + 1)
    for (const [text, times] of seen) {
      const routes = wantByText.get(text)
      if (routes === undefined) {
        const kind = looksLikeVerdict(text)
          ? '机器不许出裁决：这一条是裁决，不是点名条目'
          : '并集里没有这一条（汇总件多出一条）'
        problems.push(`第 ${want.n} 路里「${text}」${times > 1 ? `出现了 ${times} 次` : ''}——${kind}`)
        continue
      }
      if (times > 1) {
        problems.push(`第 ${want.n} 路里「${text}」出现了 ${times} 次（去重失效：同一条只能出现一次）`)
        continue
      }
      const item = have.items.find((i) => i.text === text)
      if (item.routes.join('、') !== routes.join('、')) {
        problems.push(`「${text}」的路号标签是「第 ${item.routes.join('、')} 路」，并集里它是「第 ${routes.join('、')} 路」（出处标签与并集不符）`)
      }
    }
    for (const [text] of wantByText) {
      if (!seen.has(text)) problems.push(`第 ${want.n} 路少了一条「${text}」（并集里有、汇总件里没有——主笔会少改一条）`)
    }
    for (const line of have.stray) {
      problems.push(`第 ${want.n} 路里多出一行不是拼装形状的内容：「${line}」`)
    }
  }

  // ⑤ 机器不出裁决：逐行扫裁决行（声明句自己先要过得了这一关，见 PREAMBLE 上面的注记）。
  for (const [i, line] of String(summaryText ?? '').split(/\r?\n/).entries()) {
    if (looksLikeVerdict(line)) problems.push(`第 ${i + 1} 行是一条机器裁决：「${line.trim()}」——裁决仍归主笔 AI`)
  }
  return problems
}

// ── 落盘（唯一写汇总件的地方）────────────────────────────────────────────────

/**
 * 读齐五份 → 拼装 → 写 `工作区/报告/final-summary.md`。
 *
 * ⚠️ **五份不齐就不写**（返回 `null`）：拼一份空的汇总件会让状态返回的指针指到一份
 * 「并集为空」的件上，而空并集正是本模块判据防空跑的那一档。宁可不指针。
 *
 * @param {string} projectId
 * @returns {{path: string, chars: number, unionSize: number, items: number[]}|null}
 */
export function refreshFinalAuditSummary(projectId) {
  const dir = reportDir(projectId)
  const reports = []
  for (const row of FINAL_AUDIT_SCOPES) {
    const abs = join(dir, finalAuditReportName(row.n))
    if (!existsSync(abs)) return null
    let text = ''
    try { text = readFileSync(abs, 'utf8') } catch { return null }
    if (text.trim() === '') return null
    reports.push({ n: row.n, text })
  }
  const expected = expectedSummary(reports)
  const text = assembleFinalAuditSummary(reports)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, finalAuditSummaryName()), text, 'utf8')
  return {
    path: finalAuditSummaryRel(),
    chars: text.length,
    unionSize: expected.unionSize,
    items: expected.perReport,
  }
}