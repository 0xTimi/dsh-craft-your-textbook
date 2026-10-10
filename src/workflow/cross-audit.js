/**
 * 合并前跨章审计（票 `.scratch/context-budget/issues/05` · ADR-0030 决策 2 · 改派第一刀 · merge 段）
 * 的**机器侧形状判据**：四项核对逐项有交代才放行合并。
 *
 * ## 这一层只断接线与形状（判据声称的强度＝实现强度）
 *
 * 它断的是「那四节在不在、每节有没有交代」——**不证明审计小助手真读了章**
 * （行号／引文是否真实，属真机层，票 07）。所以这里的名字、措辞与文档都按「形状」写。
 *
 * ## 四项判定词只有一处出处：派发模板
 *
 * 判定词与判定口径住在 `resources/references/subagent-prompts/cross-audit-prompt.md`
 * 的「四项核对判定表」一节里，**本模块从那份文件解析**。别处（brief 交办说明、
 * `audit-and-testing.md` §十·第二轮、拒收文案、人设）一律只**引**它——各写一份
 * 就是四份会漂的平行清单，而漂了以后机器判的和 AI 读到的会是两件事。
 *
 * ⚠️ 模板读不出来（缺文件 / 那一节被改没了）时**不许放行**：`wiringBroken` 走的是
 * 「机器自己的接线坏了」这一档，拒收文案直说那是仓内问题、不是这本书的问题——
 * 静默放行等于把一道闸门悄悄关掉，而没人会知道为什么。
 */
import { resourceText } from '../content-lib.js'

/** 跨章审计派发模板在 resources/ 下的相对路径（**单一出处**：判定词、判定口径、回灌结构都在那儿）。 */
export const CROSS_AUDIT_TEMPLATE_REL = 'references/subagent-prompts/cross-audit-prompt.md'

/** 模板里那张判定表的节标题——解析从它开始，到下一个同级 `##` 为止。 */
const ITEMS_HEADING = '## 四项核对判定表'

/** 一节里的结论行：`结论：通过` / `结论：不通过`。 */
const VERDICT_RE = /结论\s*[:：]\s*(通过|不通过)/

/** 判「通过」那一支的交代句：**无问题也要写它**，否则「没交代」与「交代了没问题」在盘上长得一样。 */
export const CROSS_AUDIT_PASS_MARK = '已核，未见'

/** 点名条目：每条一行列表项（`- …` / `* …` / `+ …`）。 */
const BULLET_RE = /^[ \t]*[-*+][ \t]+\S/

/** 审计报告的落盘件（书夹相对路径）。 */
export const CROSS_AUDIT_REPORT_REL = '工作区/audit-cross.md'

/** 除全部章之外，跨章审计还要读的三份约束件（**纯路径**，不带正文）。 */
export const CROSS_AUDIT_CONSTRAINTS = Object.freeze(['工作区/outline.md', '工作区/knowledge-map.json', '工作区/style-spec.md'])

/**
 * 从派发模板解析出四项判定词（模板的「四项核对判定表」里第一列）。
 *
 * ⚠️ 解析不到就返回**空数组**，由调用方判红——本模块不自带一份兜底清单：
 * 兜底清单就是第二处出处，正是这个模块要治的病。
 *
 * @param {string} [text] 模板全文（默认现读 `resources/` 那份）
 * @returns {string[]} 判定词，逐字、顺序与模板一致
 */
export function crossAuditItemLabels(text = resourceText(CROSS_AUDIT_TEMPLATE_REL)) {
  const source = String(text ?? '')
  const from = source.indexOf(ITEMS_HEADING)
  if (from < 0) return []
  const rest = source.slice(from + ITEMS_HEADING.length)
  const nextAt = rest.search(/\n##\s/)
  const section = nextAt >= 0 ? rest.slice(0, nextAt) : rest
  const labels = []
  for (const line of section.split(/\r?\n/)) {
    // 表行形状：`| 1 | 判定词 | … |`——只认带序号的行，免得把表头/分隔行也吃进来。
    const m = /^\|\s*\d+\s*\|\s*([^|]+?)\s*\|/.exec(line)
    if (m !== null && m[1] !== '') labels.push(m[1])
  }
  return labels
}

/** Markdown 标题行（`#`…`######`），供分节用。 */
const HEADING_RE = /^(#{1,6})\s+(.*)$/

/**
 * 判一份 `audit-cross.md` 的形状：四项核对**逐项**有交代才放行。
 *
 * 每项的判定口径见派发模板；机器这一层只认三条**可解析的形状**：
 *   ① 有一个小标题含该项判定词（`## 1. 术语统一` 也认）；
 *   ② 那一节里有一行 `结论：通过` 或 `结论：不通过`；
 *   ③ 判「通过」必须写 `已核，未见`（**空节与「没问题」在盘上长得一样**，靠这一行分开）；
 *      判「不通过」必须至少有一条点名条目（每条一行列表项）。
 *
 * 机器**不**判断结论对不对、不判断点名是否属实、不判断四项之外的东西——
 * 那是真机层（票 07）。
 *
 * @param {string} reportText `工作区/audit-cross.md` 的全文
 * @param {string[]} [labels] 判定词（默认从派发模板解析）
 * @returns {{wiringBroken: boolean, missing: {label: string, why: string}[]}}
 */
export function judgeCrossAuditReport(reportText, labels = crossAuditItemLabels()) {
  if (labels.length === 0) return { wiringBroken: true, missing: [] }
  const lines = String(reportText ?? '').split(/\r?\n/)
  const headings = []
  for (const [index, line] of lines.entries()) {
    const m = HEADING_RE.exec(line)
    if (m !== null) headings.push({ level: m[1].length, title: m[2], index })
  }
  const missing = []
  for (const label of labels) {
    const head = headings.find((h) => h.title.includes(label))
    if (head === undefined) {
      missing.push({ label, why: '没有这一项的小标题' })
      continue
    }
    // 本节 = 标题行之后、到**下一个同级或更高级**标题为止（`###` 子标题归它所有）。
    const end = headings.find((h) => h.index > head.index && h.level <= head.level)?.index ?? lines.length
    const body = lines.slice(head.index + 1, end)
    const verdict = body.map((line) => VERDICT_RE.exec(line)).find((m) => m !== null)
    if (verdict === undefined) {
      missing.push({ label, why: '有这一节，但没写「结论：通过／不通过」' })
      continue
    }
    if (verdict[1] === '通过') {
      if (!body.some((line) => line.includes(CROSS_AUDIT_PASS_MARK))) {
        missing.push({ label, why: `结论写了「通过」，但没写「${CROSS_AUDIT_PASS_MARK}」——没交代等于没查` })
      }
      continue
    }
    if (!body.some((line) => BULLET_RE.test(line))) {
      missing.push({ label, why: '结论写了「不通过」，但一条点名都没有（每条一行「- …」，指到章／位置／原文）' })
    }
  }
  return { wiringBroken: false, missing }
}

/**
 * 缺项时的拒收文案：**点名缺哪一项、为什么**，并把派发/判定口径指回那一份模板。
 *
 * ⚠️ 这里**不许**把四项列一遍——那正是本模块要治的「四份平行清单」。
 * 文案里出现的是**运行时算出来的**缺项，不是抄在代码里的清单。
 *
 * @param {{wiringBroken: boolean, missing: {label: string, why: string}[]}} verdict
 * @returns {string} 一句人话（会落到账本事件的 reason 上）
 */
export function crossAuditRejectReason(verdict) {
  const template = `resources/${CROSS_AUDIT_TEMPLATE_REL}`
  if (verdict.wiringBroken) {
    return `机器读不到跨章审计的判定词清单：派发模板 ${template} 缺失，或它的「${ITEMS_HEADING}」一节没解析出条目。这是仓内接线坏了，不是这本书的问题；四项判定词只住在那一份模板里，机器与 AI 读的是同一份。`
  }
  const names = verdict.missing.map((item) => item.label).join('、')
  const why = verdict.missing.map((item) => `${item.label}——${item.why}`).join('；')
  return `合并前跨章审计记录 ${CROSS_AUDIT_REPORT_REL} 有 ${verdict.missing.length} 项没有交代：${names}（${why}）。派发与判定口径见 ${template}——四项判定词只住在那一份里，别处不另写清单。每一项一个小标题（标题含判定词）＋一行「结论：通过／不通过」：判「通过」要写「${CROSS_AUDIT_PASS_MARK}」，判「不通过」要逐条点名（每条一行「- …」，指到章／位置／原文）。`
}