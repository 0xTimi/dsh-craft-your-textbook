/**
 * 造书工作台 · 最小 markdown 渲染
 *
 * 正文流式阅读用的行内/分块渲染：不引依赖，全用 React.createElement。
 * 服务谈判桌（GoldReader/GoldCompare）、探查报告、章节内联展开等所有「读稿」场景。
 */

import { createElement } from "react";
import { splitParagraphs } from "./rules.js";
// 票 pipeline-wiring-gaps/11：小节名的词面单点在 domain-rules（卡、提取器、测试同一份）。
import { EXPLORE_TEACHER_UNIQUE_SECTION as TEACHER_UNIQUE_SECTION } from "../domain-rules.js";

/**
 * 工作台内「连续正文块」的**量宽上限**——全仓唯一出处（票 `walkthrough-fixes/17`，
 * 2026-10-06 裁决「丙：另设正文测量宽上限」）。
 *
 * · 值 `36em`：`1em` 取**该块自身**的 `font-size` ⇒ **禁写死 px**（裁决原文说换算只作核对：
 *   16px⇒576、17px⇒612；写死 px 就把「跟着块自己的字号走」这件事丢了）。
 * · 为什么是 36em：裁决人给的约定（不是票面事实）——36em 中文约 30–40 汉字/行取中位、
 *   拉丁约 72 字符/行仍在 45–75 区间内；且它只压正文块，**卡盒宽度一点不动**。
 * · 适用范围（裁决约定）：「连续正文块」＝**报告卡正文／章节正文／终检报告正文**。
 *   裁决**排除**的那几类（表格、行号 gutter、折叠清单、代码）住**别的路径**——盘上对应的是
 *   `src/ui/gold-table.js` 左侧那个绝对定位的段号 `span`（gutter）、`src/ui/phase-page.js` 里
 *   知识地图/章节安排那两条折叠清单的 `<pre>`、`src/ui/event-cards.js` 闸门卡详情那个 `<pre>`。
 *   ⚠️ **本模块这条「报告 md」的路只有两个分支**（`exploreReportBlocks` 的 `/^#{1,2}\s+/` 标题支，
 *   与其余走 `READER_PARA_STYLE` 的段支）⇒ 报告 md 里的 ``` 围栏与 `|` 表格行在本路就是**普通文本段**，
 *   **也吃这条 `36em`**（本路不产生 `<table>`／`<pre>` 那一层；本仓 `src/**` 里**没有**任何
 *   markdown→`<table>` 的渲染点，取样：`Get-ChildItem -Recurse src -Include *.js |
 *   Select-String -Pattern '"table"'` ⇒ 零命中）。
 *   **这不是「没套」**：裁决排除的那几类在本路**没有对应物**。这句自陈曾经写成「本路不算」而与
 *   实现不符（收口 review 规范轴 N2，读数与复现命令在票 `walkthrough-fixes/17` 的 `## Answer` 末节）。
 * · ⛔ 它压的是**正文块**，不是卡盒：卡盒宽度归宿主那套变量（票 16 的「工作台＝输入框」
 *   逐字同一式子，见 `src/client-entry.js` 的 `rootStyle`）。为了消白把卡盒改回
 *   「随内容宽」正是票 16 判死的病（维护者原话「页面的宽度在流程进行中老变」）。
 * · 📌 **出处只此一处**：别处要用就 import 它，**不许**再抄一份同样的字面量。
 *   `test-layout-anchors.mjs` 的「正文块量宽只此一处」一节按**次数**咬第二处
 *   （坏形状反证见那一节；这一条与卡盒那条是两回事，别互相顶替）。
 */
export const BODY_MEASURE_MAX_WIDTH = "36em";

// 正文流式排版（F11）：像读书一样一段段往下流，不做卡片框。
// `maxWidth` 取上面那个唯一出处（**报告卡正文**与**章节正文**两条路都走这一份样式：
// 前者经 `exploreReportBlocks`、后者经 `gold-table.js` 的 `GoldReader`/`GoldCompare`）。
export const READER_PARA_STYLE = {
	margin: "0 0 0.75em",
	fontSize: "14px",
	lineHeight: 1.7,
	maxWidth: BODY_MEASURE_MAX_WIDTH,
};

/**
 * 行内最小 markdown 渲染（正文流式阅读用，不引依赖，全用 React.createElement）：
 * - `**加粗**` -> <strong>；
 * - `#`/`##` 开头 -> 加粗标题段；
 * - `- ` 开头 -> 列表行（前面加项目符号）；
 * - 其余原样当纯文本。
 * 恒返回节点数组（文本 + 元素混排），可直接 ... 展开成 createElement 的 children。
 */
export function renderInline(text) {
	const str = String(text ?? "");
	const head = /^(#{1,2})\s+(.+)$/.exec(str);
	if (head !== null)
		return [
			createElement(
				"strong",
				{ style: { fontSize: "16px" } },
				...inlineBold(head[2]),
			),
		];
	const list = /^[-*]\s+(.+)$/.exec(str);
	if (list !== null)
		return [
			createElement(
				"span",
				{ style: { display: "block" } },
				"• ",
				...inlineBold(list[1]),
			),
		];
	return inlineBold(str);
}

/** 把 `**加粗**` 切成 [文本, strong, 文本, ...] 的节点数组：odd 下标是加粗段。 */
function inlineBold(s) {
	const parts = String(s).split(/(\*\*.+?\*\*)/g);
	const nodes = [];
	for (let i = 0; i < parts.length; i += 1) {
		if (parts[i] === "") continue;
		nodes.push(
			i % 2 === 1
				? createElement("strong", { key: i }, parts[i].slice(2, -2))
				: parts[i],
		);
	}
	return nodes;
}

// F30（2026-08-20 走查）：源探查报告（工作区/explore.md）的 md 最小渲染。
// 按空行切段：`## ` 开头当标题（renderInline 自带加粗样式），普通段用正文流式排版
// （READER_PARA_STYLE），`- ` 列表行由 renderInline 转成带项目符号的块。
// 恒返回节点数组，可直接 ... 展开成 createElement 的 children；空/异常输入返回空数组。
//
// 🚩 票 `walkthrough-fixes/17`（2026-10-06 裁决）：**两个分支都要带正文量宽上限**
//   `BODY_MEASURE_MAX_WIDTH`。标题那一支原来是裸 `div`（只有 `margin`），于是它**继承卡自己的
//   `13px`**、宽度铺满卡片内容盒——票 17 的「落地前基线」在真 2K 上量到的
//   **「卡内正文块 3 段、`font-size: 13px`、宽 856.00px ＝ 65.85em」正是这一支**（演示书的
//   explore.md 恰好是 3 个 `##` 小节、没有散文段）。只给下面那一支（`READER_PARA_STYLE`）
//   加上限**改不动那个被验的数**，落地后复量还是 65.85em。⇒ 标题支也吃同一条上限。
//   ⚠️ 1em 取的是**这个块自己**的 font-size（标题支＝继承来的 13px），所以 36em 在这里是
//   468px；`renderInline` 里那个 `<strong fontSize:16px>` 只是块**内容**的字号，不改变量宽。
export function exploreReportBlocks(mdText) {
	const paras = splitParagraphs(mdText);
	const blocks = [];
	for (const para of paras) {
		blocks.push(
			/^#{1,2}\s+/.test(para)
				? createElement(
						"div",
						{
							key: blocks.length,
							style: { margin: "0 0 0.6em", maxWidth: BODY_MEASURE_MAX_WIDTH },
						},
						...renderInline(para),
					)
				: createElement(
						"p",
						{ key: blocks.length, style: READER_PARA_STYLE },
						...renderInline(para),
					),
		);
	}
	return blocks;
}

// 票 pipeline-wiring-gaps/11：师生合版独有内容比对的**提取**——探查确认卡那一颗折叠块
// 从已验的 工作区/explore.md（本 module 渲染的就是它）里把「教师用书独有内容」那一节
// 取出来就地折叠，让顶部那份默认铺开的长报告不再是它的唯一出口。
//
// ⚠️ 判据的窄处（AGENTS.md 纪律）：出现与否认的是**报告里真有那一节**（机器手上的真实数据），
// 不认材料构成——「师生合版 ⇒ AI 照方法学（source-material.md §三，经 brief.methodology 注入）
// 写了那一节」这半段因果机器不验（票 07 有意不把粗比对收进交工拒交词表）。AI 没写时块缺席；
// 缺席 ≠ 没有独有内容，卡不冒充这个判断。单教材书没有可比对的对象，报告里不会有那一节 ⇒ 块不出现。
/**
 * 从探查报告（工作区/explore.md）里取出「教师用书独有内容」那一节的正文行。
 *
 * 小节名从 `domain-rules.EXPLORE_TEACHER_UNIQUE_SECTION` 取（与卡、测试同一份词面）；
 * 标题行认 `#`~`###` 且标题文字以该词开头（AI 写成「教师用书独有内容比对」也认得），
 * 内容取到下一个**同级或更高级**标题为止——节内的 `###` 类目行（评价标准/教学目标/…）
 * 算内容保留。空行丢掉；没有那一节、节是空的、或读不到报告时返回 `null`，
 * 由调用方整块不渲染（与报告区读不到同一条降级口径，不摆占位件）。
 *
 * @param {unknown} mdText 工作区/explore.md 的原文（可为 null/undefined）。
 * @returns {string[]|null} 节内正文行（已去空行）；读不出那一节时 `null`。
 */
export function exploreTeacherUniqueLines(mdText) {
	if (typeof mdText !== "string" || mdText === "") return null;
	const lines = mdText.split(/\r?\n/);
	// 起始行一次匹配同时拿到位置与级别——findIndex 与单独取 level 各扫一遍，找的是同一行。
	let start = -1;
	let level = 0;
	for (let i = 0; i < lines.length; i += 1) {
		const head = /^(#{1,3})\s+(.*)$/.exec(lines[i].trim());
		if (head !== null && head[2].startsWith(TEACHER_UNIQUE_SECTION)) {
			start = i;
			level = head[1].length;
			break;
		}
	}
	if (start === -1) return null;
	const out = [];
	for (let i = start + 1; i < lines.length; i += 1) {
		const head = /^(#{1,6})\s+/.exec(lines[i].trim());
		if (head !== null && head[1].length <= level) break; // 同级或更高级标题：本节到此为止
		const text = lines[i].trim();
		if (text !== "") out.push(text);
	}
	return out.length > 0 ? out : null;
}
