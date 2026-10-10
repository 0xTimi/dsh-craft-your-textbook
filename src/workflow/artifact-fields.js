/**
 * 账本事件的产物字段映射（workbench-transitions/22）。
 *
 * 读取侧的三层判据不在这里：本模块只把「这一笔事件自己产出的那一个文件」
 * 归一成 appendEvent 的 data 片段。路径与阶段页 / `/textbook/work` 共用书夹相对形状。
 */

// 章正文路径的构造只此一份（票 `depth-review-2026-10/05`）：住在 `src/domain-rules.js`，
// 与识别侧（`NUMBERED_CHAPTER_FILE_RE` / `productOpenMode`）同居，两端不再各拼一份。
// ⚠️ 要**基名**（`chapter-NN.md`）的调用点取 `chapterName`，不是这个——给它们塞相对路径会拼出
// `工作区/工作区/chapter-01.md`，真的把文件写坏或读坏。
import { chapterRel } from '../domain-rules.js'

/** 章正文路径（两位序号是产物契约）。 */
export function artifactDataForChapter(chapter) {
  const n = Number(chapter)
  if (!Number.isSafeInteger(n) || n < 1) return {}
  return { path: chapterRel(n), chapter: n }
}

/** 拍板提案路径；v1 与修订件 vM 同形。 */
export function artifactDataForGate(gate, version) {
  const g = String(gate ?? '').trim()
  const v = Number(version)
  if (!/^[1-9]\d*$/.test(g) || !Number.isSafeInteger(v) || v < 1) return {}
  return { path: `工作区/方案/关卡${g}-v${v}.md` }
}

/**
 * 真实通道的 stage-start 交办：记「将要产出」的那一份。
 * chapters 一次要写 N 章，没有单文件，故不记 path/chapter。
 */
export function artifactDataForStage(stage, gate, goldChapter = 1) {
  switch (String(stage ?? '')) {
    case 'explore':
      return { path: '工作区/explore.md' }
    case 'gate':
      return artifactDataForGate(gate, 1)
    case 'outline':
      return { path: '工作区/outline.md' }
    case 'gold':
      return artifactDataForChapter(goldChapter)
    case 'merge':
    case 'final':
      return { path: '工作区/book.md' }
    default:
      return {}
  }
}

/**
 * 演示通道的 agent-start/agent-end：按机器 label 分派到同一份产物字段。
 * 未登记的 label（包括材料转换与 audit JSON）返回空对象，不凭空造入口。
 */
export function artifactDataForLabel(label, goldChapter = 1) {
  const text = String(label ?? '')
  if (text.startsWith('源探查')) return { path: '工作区/explore.md' }
  if (text.includes('章节骨架') || text.includes('章节安排')) return { path: '工作区/outline.md' }
  if (text.includes('最佳范例章')) return artifactDataForChapter(goldChapter)
  if (text.startsWith('合并成书') || text.startsWith('最后检查')) return { path: '工作区/book.md' }

  const write = /写第\s*(\d+)\s*章/.exec(text)
  if (write !== null) return artifactDataForChapter(Number(write[1]))

  const gate = /设计提案·(?:第\s*(\d+)\s*关|关卡\s*(\d+))(?:·修订\s*v\s*(\d+))?/.exec(text)
  if (gate !== null) return artifactDataForGate(gate[1] ?? gate[2], gate[3] === undefined ? 1 : Number(gate[3]))

  return {}
}
