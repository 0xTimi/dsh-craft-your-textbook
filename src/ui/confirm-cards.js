/**
 * 造书工作台 · 确认卡
 *
 * 两个人审确认点：源探查结果确认（awaiting-explore）与章节安排确认（awaiting-outline）。
 */

import { createElement, useEffect, useState } from "react";
import { defineCardView } from "./card-view.js";
import { S } from "./styles.js";
import { exploreReportBlocks, exploreTeacherUniqueLines } from "./md-render.js";
// 知识地图（`工作区/knowledge-map.json`）的**形状读取**（票 `depth-review-2026-10/03`）：
// 键名与「不是数组就当没有」这条兜底收在中性模块——那份 JSON 今天有两个读者，形状知识分住在
// 两个文件里就等于有两份会漂的读法（收编前这里就是一份内联的 `JSON.parse`）。
// ⚠️ **只收形状，不收措辞**（既有裁决「数据同源、措辞各自成篇」）：下面三块清单的每一句人话
// 仍是这张卡自己写的，与 `foldKnowledgeMap` 那份折叠**逐字不同**，两者服务于两种读法
// （就地折叠的纯文本 vs 一张要拍板的卡）。改文案前先问产品，别当成重复代码清掉。
import { parseKnowledgeMap } from "./machine-product-folds.js";
import {
	KNOWLEDGE_POINT_DIFFICULTY,
	normalizeTeachingFocus,
	// 票 `pipeline-wiring-gaps/12`：知识点覆盖的两头比对——与 outline 交工闸门同一份
	// （`actions/chapters.js` 吃的就是这个函数），界面不另写一套量法。
	// `okMaterialNumbers` 同理：闸门只对「有转换完成的源」的书判覆盖，卡照抄同一口径，
	// 不然无源书会印出「交工会被机器拒」这种机器根本不会做的事。
	okMaterialNumbers,
	outlinePointsCoverage,
} from "../domain-rules.js";

// ── 探查结果确认卡（探源 → 用户看一眼再继续） ───────────────────────────────

// 知识点难度 → 颜色（让清单一眼可扫）。
// 票 06：难度取值域**登记在 `domain-rules.KNOWLEDGE_POINT_DIFFICULTY`**（登记单点，不是这张表）。
// 色表从取值域**派生**（键域＝登记面）：界面不再自设四格、也不再配一把兜底灰把出域值兜成
// 「看不出问题」——出域值已在 explore 交工时由机器归一化写回（`actions/chapters.js` 的
// explore 分支），机器产物落不到缺色格；`DIFF_COLORS[d]` 落空只剩旧书/夹具残值那一格，
// 渲染成默认正文色。登记面加一档而这里没配色的活口由 `test-knowledge-difficulty.mjs`
// 的对账判据咬住（每档必须真有一色）。
const DIFF_TONES = {
	基础: "#1a7f37",
	重点: "#9a6700",
	难点: "#cf222e",
	进阶: "#8250df",
};
export const DIFF_COLORS = Object.fromEntries(
	KNOWLEDGE_POINT_DIFFICULTY.map((d) => [d, DIFF_TONES[d]]),
);
// 重做探查的预置理由（点选即用，不用打字）。
const RE_EXPLORE_REASONS = [
	"有的材料没读全",
	"知识点整理得太粗",
	"章节建议不合理",
	"重点难点判断不对",
];

// 「拍板通过、继续往下走」那颗推进键的可见文案——**唯一出口**。
// 票 20 当初在焦点区底部加过一条吸底决策条，条上那颗同名按钮取的就是这里（两处不许各写一份）。
// ⚠️ 那条已按票 `walkthrough-fixes/18` 的裁决整条删掉（2026-10-04，用户选 B）——**屏上同一颗键
// 渲染了两次**：卡内那颗（对的那次，和「🔁 让 AI 重做」「👀 看完整报告」并排）之外，卡片外面
// 还有一颗右对齐、孤零零挂在右下方的同名键，用户原话「满意的那行位置不对」。
// 现在**这颗键只有卡上这一个出口**；防它回来的判据在 `test-layout-anchors.mjs`（源码级）
// 与 `test-workbench-first-screen.mjs`（渲染级：逐字只出现一次）。
export const EXPLORE_CONFIRM_ACCEPT_LABEL = "✅ 满意，继续设计";

/**
 * 探查确认卡的 props 契约（票 `workbench-card-contract` 02）
 *
 * **这张卡吃什么**：书级只读两件（`exploreSummary` / `knowledgeMapText`）+ 壳级可变的一件（`busy`）
 * + 壳注入的三件（`confirmExplore` / `onViewReport` / `readArtifact`）+ 一个**只由测试注入**的
 * `reportText`。收编前这七项由 `client-entry.js` 的 `case "explore"` 那一整块逐项手抄——「这张卡吃
 * 什么」的知识从此住在**这张卡旁边**：加一个输入不必再去动那个两千多行的壳。
 *
 * ### 必填三项的判据：卡内**没有兜底**，缺了会崩或会让那颗键静默死
 *
 * · `confirmExplore` → 整形成 prop `onConfirm` —— `:461` / `:483` 两处用户点击直接调它，没有 `?.`、
 *   没有 `if` 守卫。缺了 = 用户点「✅ 满意，继续设计」或「🔁 就这样重做」当场 TypeError。
 * · `onViewReport` —— `:505` 直接挂在「👀 看完整报告」的 `onClick` 上。缺了**不崩**，是那颗键点了
 *   什么都不发生——这正是本票要拆的那个形状（spec「问题」第 1 条：UI 回调假设壳会递值却无契约，
 *   漏了只静默降级），所以它必填。
 * · `readArtifact` —— `:182` 在挂载 effect 里**无条件**调。票 03 把「无当前书 ⇒ 不发请求」搬进了
 *   `ui/artifact-read.js`（在那里表现为一次 reject，落进本卡**同一条**降级路径），本卡不再自己判；
 *   缺了它 = effect 内当场 TypeError。
 *
 * ### `book` 的键不许撞名，prop 名由 `derive` 整形（壳那边定的全局规则，不是本卡的特例）
 *
 * `createCardView(book, slots)` 只有**一本扁平的 book**，而各卡的 prop 名域是重叠的：`onConfirm`
 * 这一个名字，本卡指的是壳的 `confirmExplore`，兄弟卡指的是壳的 `confirmOutline`——两个不同的函
 * 数。所以 book 侧取壳里**不撞名**的标识符，prop 名一字不改，由 `derive` 整形一次。
 * ✅ **这一位已经收成一道闸，不是一条纪律**：`.with({ onConfirm: … })` 当场抛 `CardViewError`——
 *   `build` 的 ③ 只认 `fromBook` ∪ `defaults` 里**声明过**的键，**不含** `derive` 产出的键。
 *   **为什么是闸**：整形是 `derive` 的职责，若 `.with` 改得动整形结果，同一个名字就有两处来源——
 *   那正是这张票要消灭的形状。要在调用处覆盖的值必须**声明**在 `fromBook` / `defaults` 里。
 *
 * ### 不列必填的三项：漏了会怎样静默降级（逐项写明，判据是**卡内自己有兜底**，本票一个字不改）
 *
 * · `exploreSummary` —— `:139` 的 `?? {}` 兜底。漏了不崩，但屏上那行会**说假话**：「来源材料 0 份 ·
 *   知识点 0 个 · 建议分 0 章」。⚠️ 这条 `?? {}` **不在**票 01 查实的那 6 处守卫清单里（那 6 处在
 *   `chapters-map.js` 五处，加上 `confirm-cards.js:85` 那处、已在票 03 随 URL 拼装一起收编掉），
 *   不许顺手删。
 * · `knowledgeMapText` —— `:153` 的 `typeof === "string"` 判据兜底：解析失败等同于没有清单，不渲
 *   染知识地图、不阻断确认流程。⚠️ 壳那一份**可以是 `null`**（`client-entry.js:458`
 *   `coreData === null ? null : coreData.knowledgeMap`）——`null` 是显式的「没有」，按缺省三规则
 *   第 2 条原样穿过，绝不被填成别的值。
 * · `busy` —— 全卡只作 `disabled` 用（`:462` / `:484` / `:506`）。漏了 = 按钮永不置灰，AI 干活时
 *   能重复点。它是**壳级可变 UI state**（`BookSessionScope` 的 `ui.busy`），不是书级快照，与其余
 *   11 个 slot 共用同一份。
 *
 * ✅ **死 prop `meta` 不在这份契约里**（票 02 取证：函数体里 `meta` 的唯一命中是 `:129` 那行**自陈
 *   「本卡不使用」的注释本身**，**可执行代码零命中**——判据是可执行引用，不是 grep 的命中数）。
 *   壳那一份随之停传：切走它不需要任何行为论证，因为卡内从头到尾没读过它。`:129` 那行注释也已同步
 *   改成同一句取证结论——**契约与卡体不许留一句与代码矛盾的注释**，所以两边一起改，不留尾巴。
 */
export const exploreConfirmCardView = defineCardView({
	card: "ExploreConfirmCard",
	fromBook: [
		"exploreSummary",
		"knowledgeMapText",
		"readArtifact",
		"confirmExplore",
		"onViewReport",
		"busy",
	],
	required: ["confirmExplore", "onViewReport", "readArtifact"],
	defaults: {
		/**
		 * `reportText` —— **只由测试注入的口子**（`smoke-test.mjs:6020` 的 SSR 那一节：
		 * `renderToStaticMarkup` 跑不了 `useEffect`/fetch，于是把报告经这个 prop 注进去，断言
		 * 「报告区排在摘要行之前」）。
		 *
		 * ⚠️ **壳从不传它**（`client-entry.js` 的 `case "explore"` 那一整块没有这一项）。于是生产恒为
		 * 缺省值 `null`，`:165` 的 `useState` 初值与 `:169-171` 的 effect 早退**每次都不命中**，那个
		 * effect 每次跑都真的去读一次 `readArtifact("工作区/explore.md")`——**这不是 bug**，是那条
		 * 降级路径本来就该走的（票 03 之后 `project`/`session` 已退休，判据归 `artifact-read`）。
		 *
		 * 之所以**登记成 `defaults`、绝不列 `required`**：列了必填就是**逼壳去传它**，那才是行为
		 * 变更（凭空多出一个恒空的 prop，正是 `.scratch/dsh-contract-drift/` 记的那个形状）。
		 * 之所以**不把这个 prop 删掉**：删了会让冒烟那一节的报告置顶断言失真——那条断言证的是
		 * 「报告区早于摘要行」，它需要一条不联网的注入口。**登记比删除更有价值**。
		 *
		 * 缺省取 `null`（不是 `undefined`）：`:165` / `:169` 的判据都是
		 * `typeof … === "string" && … !== ""`，两种取值行为逐字一致，而只有 `null` 能把
		 * 「生产恒无、只此一处注入」这件事**写进契约本身**。
		 */
		reportText: null,
	},
	// 整形：壳里不撞名的 `confirmExplore` → 卡片真正消费的那个 `onConfirm`。理由见上面那一节。
	// ⚠️ `derive` **只拿得到一个参数**（此刻的袋子，`build` 的 ④）：delta 已排在它之前，所以从袋
	// 里读到的就是**最终值**，也是唯一正确的读法（拿不到「原始书切片」，两个读法会打架）。
	// 除此之外没有现算表达式——`onViewReport` 的闭包在壳里，不在这里重写：`viewWork` 不是卡片该
	// 认识的东西，袋里其余每一项都是壳原样递过来的值。
	derive: (bag) => ({ onConfirm: bag.confirmExplore }),
});

export function ExploreConfirmCard(props) {
	// 注：本卡不使用 meta，契约里也没有它（票 02 取证：函数体可执行代码零命中）——不解构以免未用变量。
	const {
		exploreSummary,
		knowledgeMapText,
		readArtifact,
		onConfirm,
		onViewReport,
		busy,
		reportText,
	} = props;
	const sum = exploreSummary ?? {};
	// 契约是 teachingFocus:[string]，但 AI 曾产出对象数组——归一化兜底，
	// 杜绝 `· ${item}` 把对象渲染成 [object Object]（2026-09 修复）。
	const focus = normalizeTeachingFocus(sum.teachingFocus);
	const [showPoints, setShowPoints] = useState(false);
	const [showSections, setShowSections] = useState(false);
	// 票 pipeline-wiring-gaps/11：师生合版独有内容比对（评价标准/教学目标/学情分析/常见错误/
	// 考点提示/深层知识讲解）的折叠口——内容取自已验的那份报告（工作区/explore.md，票 07 的
	// 交工闸门保证它在盘且非空），报告里没有那一节（如单教材书）就整块不渲染。
	const [showTeacherUnique, setShowTeacherUnique] = useState(false);
	const [rejecting, setRejecting] = useState(false);
	const [reasons, setReasons] = useState([]);
	const [rejectNote, setRejectNote] = useState("");
	// 知识地图（工作区/knowledge-map.json）原文由父级随事件一起取回（它随 /textbook/events
	// 下发的 knowledgeMap 字段，见 workflow.js）：这是**机器产物**，`/textbook/file` 按
	// 「给人读的产物」收窄后已拒绝它（票 04）；它的人读形态是这张卡片内联的折叠清单（票 05）。
	// 解析失败等同于没有清单：不渲染知识地图清单、不阻断确认流程。
	// 📌 这份读取住在中性模块（票 `depth-review-2026-10/03`）——**只统一形状，措辞仍在本卡**。
	const km = parseKnowledgeMap(knowledgeMapText);
	// F30（2026-08-20 走查）：源探查报告（工作区/explore.md）默认置顶展示。
	// 有 reportText（父级/测试注入）直接用（含首次渲染）；否则按上面 knowledge-map 的
	// 同一方式拉取，读取失败不抛错、报告为空也不影响卡片其余功能（优雅降级）。
	const [report, setReport] = useState(() =>
		typeof reportText === "string" && reportText !== "" ? reportText : null,
	);
	useEffect(() => {
		let alive = true;
		if (typeof reportText === "string" && reportText !== "") {
			setReport(reportText);
			return undefined;
		}
		setReport(null);
		// 票 03：地址拼装归 `ui/artifact-read.js`（`createArtifactReader(...).readText`），
		// 本卡只给一个 `rel`。`project` / `session` 两个身份 prop 因此**退休**——它们原先只被用来
		// 拼那一条 URL。「无当前书 ⇒ 不发请求」这条判断也一并搬进那个 module：它在这里表现为一次
		// reject，落进下面**同一条**降级路径，不需要本卡再自己判一次。
		//
		// ⚠️ 错误策略**逐字保留**（票 03 收编的两条正当策略之一）：读不到就不显示报告区、
		// **不打断确认流程**。另一条在 `chapters-map.js`（显示错误条）。收敛时**不许把两条统一**——
		// 那是产品决定的收窄，不是重构。
		readArtifact("工作区/explore.md")
			.then((text) => {
				if (alive) setReport(text);
			})
			.catch(() => {
				/* 报告读不到就不显示报告区，不打断确认流程 */
			});
		return () => {
			alive = false;
		};
	}, [readArtifact, reportText]);
	const reportBlocks =
		report !== null && report !== "" ? exploreReportBlocks(report) : [];
	// 票 pipeline-wiring-gaps/11：已验报告里「教师用书独有内容」那一节的正文行——
	// 读不到报告/没有那一节时空（null），折叠块整块不渲染；出现与否跟随报告内容，
	// 不是凭材料构成猜出来的（窄处见 md-render.exploreTeacherUniqueLines 的注）。
	const teacherUniqueLines = exploreTeacherUniqueLines(report);
	// 三份清单由中性模块那份形状读取给出来（`null` 时三份都是空数组，所以下面照旧直接用）。
	const kps = km === null ? [] : km.kps;
	const chapters = km === null ? [] : km.chapters;
	const sections = km === null ? [] : km.materials;
	const sectionTitles = (material) =>
		Array.isArray(material?.sections)
			? material.sections
					.map((s) => String(s?.title ?? ""))
					.filter((t) => t !== "")
			: [];
	// 票 17 · pipeline-wiring-gaps · ADR-0023：材料分量（standing）逐源声明——
	// AI 在各分片里逐源写的一句「这份材料在什么问题上说了算、在什么问题上不算数」，
	// 在材料清单里就地能看见，不是只躺在 JSON 里。旧夹具/单源书（可省）没有这个字段：
	// 不渲染空标签、不阻断确认流程（与上面三份清单同一条降级口径）。
	const standingText = (material) =>
		typeof material?.standing === "string" && material.standing.trim() !== ""
			? material.standing.trim()
			: null;
	const toggleReason = (reason) => {
		setReasons((prev) =>
			prev.includes(reason)
				? prev.filter((item) => item !== reason)
				: [...prev, reason],
		);
	};
	const cancelReject = () => {
		setRejecting(false);
		setReasons([]);
		setRejectNote("");
	};

	return createElement(
		"div",
		{ style: S.focus },
		reportBlocks.length > 0
			? createElement(
					"div",
					{ style: { ...S.card, marginBottom: "10px" } },
					createElement(
						"p",
						{ style: { margin: "0 0 6px", fontSize: "12px", opacity: 0.8 } },
						"📋 读材料报告（AI 通读后的完整记录）：",
					),
					...reportBlocks,
				)
			: null,
		createElement(
			"strong",
			{ style: { fontSize: "14px" } },
			"🔍 材料读完了！",
		),
		createElement(
			"p",
			{ style: { margin: "6px 0" } },
			`AI 已通读你的教材，整理出：来源材料 ${sum.sources ?? 0} 份 · 知识点 ${sum.knowledgePoints ?? 0} 个 · 建议分 ${sum.chapterSuggestion ?? 0} 章。`,
		),
		focus.length > 0
			? createElement(
					"div",
					{
						style: {
							margin: "4px 0 8px",
							padding: "8px 10px",
							background: "var(--dsw-alias-bg-layer-1)",
							borderRadius: "8px",
							border: "1px solid var(--dsw-alias-border-l2)",
						},
					},
					createElement(
						"p",
						{ style: { margin: "0 0 4px", fontSize: "12px", opacity: 0.8 } },
						"AI 判断的重点/难点：",
					),
					focus.map((item, index) =>
						createElement(
							"div",
							{ key: index, style: { fontSize: "12px", margin: "2px 0" } },
							`· ${item}`,
						),
					),
				)
			: null,
		chapters.length > 0
			? createElement(
					"div",
					{
						style: {
							margin: "4px 0 8px",
							padding: "8px 10px",
							background: "var(--dsw-alias-bg-layer-1)",
							borderRadius: "8px",
							border: "1px solid var(--dsw-alias-border-l2)",
						},
					},
					createElement(
						"p",
						{ style: { margin: "0 0 4px", fontSize: "12px", opacity: 0.8 } },
						"📚 AI 建议的章节安排（后续可再调）：",
					),
					chapters.map((chapter, index) =>
						createElement(
							"div",
							{ key: index, style: { fontSize: "12px", margin: "2px 0" } },
							`${index + 1}. ${chapter.title ?? ""}`,
							chapter.source !== undefined &&
								chapter.source !== "" &&
								chapter.source !== null
								? createElement(
										"span",
										{ style: { opacity: 0.6 } },
										`　← ${chapter.source}`,
									)
								: null,
						),
					),
				)
			: null,
		kps.length > 0
			? createElement(
					"div",
					{ style: { margin: "4px 0 8px" } },
					createElement(
						"button",
						{ style: S.smallLink, onClick: () => setShowPoints(!showPoints) },
						showPoints
							? `▾ 收起知识点清单（${kps.length} 个）`
							: `▸ 知识点清单（${kps.length} 个，点开看）`,
					),
					showPoints
						? createElement(
								"div",
								{
									style: {
										marginTop: "6px",
										padding: "8px 10px",
										background: "var(--dsw-alias-bg-layer-1)",
										borderRadius: "8px",
										border: "1px solid var(--dsw-alias-border-l2)",
									},
								},
								kps.map((point, index) =>
									createElement(
										"div",
										{
											key: index,
											style: { fontSize: "12px", margin: "2px 0" },
										},
										`· ${point.title ?? ""}`,
										point.difficulty !== undefined &&
											point.difficulty !== "" &&
											point.difficulty !== null
											? createElement(
													"span",
													{
														style: {
															// 票 06：不配兜底灰——上色从登记取值域派生（见 DIFF_COLORS 上方的注），
															// 出域残值落成默认正文色，不再被「万能灰」兜成看不出问题。
															color: DIFF_COLORS[point.difficulty],
														},
													},
													`（${point.difficulty}）`,
												)
											: null,
										point.source !== undefined &&
											point.source !== "" &&
											point.source !== null
											? createElement(
													"span",
													{ style: { opacity: 0.5 } },
													` ${point.source}`,
												)
											: null,
									),
								),
							)
						: null,
				)
			: null,
		sections.length > 0
			? createElement(
					"div",
					{ style: { margin: "4px 0 8px" } },
					createElement(
						"button",
						{
							style: S.smallLink,
							onClick: () => setShowSections(!showSections),
						},
						// 票 09：量词「份」只管材料，「本」留给「书」——这两句数的是材料。
						showSections
							? "▾ 收起每份材料里读到的小节"
							: "▸ 每份材料里读到的小节（点开看）",
					),
					showSections
						? createElement(
								"div",
								{
									style: {
										marginTop: "6px",
										padding: "8px 10px",
										background: "var(--dsw-alias-bg-layer-1)",
										borderRadius: "8px",
										border: "1px solid var(--dsw-alias-border-l2)",
									},
								},
								sections.map((material, index) => {
									const titles = sectionTitles(material);
									const standing = standingText(material);
									return createElement(
										"div",
										{
											key: index,
											style: { fontSize: "12px", margin: "2px 0" },
										},
										`资料${material?.num ?? index + 1}：`,
										createElement(
											"span",
											{ style: { opacity: 0.8 } },
											titles.join(" / ") || "（未读到小节标题）",
										),
										standing !== null
											? createElement(
													"div",
													{ style: { opacity: 0.75, marginTop: "1px" } },
													`分量声明：${standing}`,
												)
											: null,
									);
								}),
							)
						: null,
					)
				: null,
			// 票 pipeline-wiring-gaps/11：师生合版独有内容比对的折叠块——方法论文档
			// （source-material.md §三）点名的六类比对（评价标准/教学目标/学情分析/常见错误/
			// 考点提示/深层知识讲解）由探查 AI 写进已验报告的「教师用书独有内容」小节，
			// 在这里能直接点开，不必再翻顶部那份默认铺开的长报告。报告里没有那一节
			// （单教材书没有可比对的对象；或 AI 这轮没写）就整块不出现——不摆占位件、
			// 不阻断确认流程（与报告区同一条降级口径）。
			teacherUniqueLines !== null
				? createElement(
						"div",
						{ style: { margin: "4px 0 8px" } },
						createElement(
							"button",
							{
								style: S.smallLink,
								onClick: () => setShowTeacherUnique(!showTeacherUnique),
							},
							showTeacherUnique
								? "▾ 收起师生合版独有内容比对"
								: "▸ 师生合版独有内容比对（点开看）",
						),
						showTeacherUnique
							? createElement(
									"div",
									{
										style: {
											marginTop: "6px",
											padding: "8px 10px",
											background: "var(--dsw-alias-bg-layer-1)",
											borderRadius: "8px",
											border: "1px solid var(--dsw-alias-border-l2)",
										},
									},
									teacherUniqueLines.map((line, index) =>
										createElement(
											"div",
											{
												key: index,
												style: { fontSize: "12px", margin: "2px 0" },
											},
											line,
										),
									),
								)
							: null,
					)
				: null,
			createElement(
				"p",
				{ style: { margin: "0 0 8px", fontSize: "12px", opacity: 0.75 } },
				"这是后面所有设计的基础。满意就继续；不满意点「重做」，勾个理由或写一句哪里不满意，AI 会照着改（不填也能重做）。",
			),
		rejecting
			? createElement(
					"div",
					{
						style: {
							marginTop: "10px",
							borderTop: "1px dashed var(--dsw-alias-border-l2)",
							paddingTop: "8px",
						},
					},
					createElement(
						"p",
						{ style: { margin: "0 0 6px", fontWeight: 600 } },
						// 票 14（承诺账 D「说不清」第 7 条）：「10 秒」估的是用户自己的操作成本、
						// 不是系统耗时，代码里断不了真假——收掉这个数字（点选或写一句本身已经够短）。
						"哪里不满意？（点选或写一句）",
					),
					createElement(
						"div",
						{ style: { margin: "6px 0" } },
						RE_EXPLORE_REASONS.map((reason) =>
							createElement(
								"label",
								{ key: reason, style: S.checkItem },
								createElement("input", {
									type: "checkbox",
									checked: reasons.includes(reason),
									onChange: () => toggleReason(reason),
								}),
								` ${reason}`,
							),
						),
					),
					createElement("textarea", {
						style: S.textarea,
						placeholder: "想多说一句？在这里写（可选）",
						value: rejectNote,
						onChange: (e) => setRejectNote(e.target.value),
					}),
					createElement(
						"div",
						{ style: { marginTop: "8px", display: "flex", gap: "8px" } },
						createElement(
							"button",
							{
								style: S.bigBtn(false),
								onClick: () => onConfirm(false, { reasons, note: rejectNote }),
								disabled: busy,
							},
							"🔁 就这样重做",
						),
						createElement(
							"button",
							{
								style: { ...S.smallLink, textDecoration: "none" },
								onClick: cancelReject,
							},
							"取消",
						),
					),
				)
			: createElement(
					"div",
					{ style: { display: "flex", gap: "8px", flexWrap: "wrap" } },
					createElement(
						"button",
						{
							style: S.bigBtn(true),
							onClick: () => onConfirm(true),
							disabled: busy,
						},
						EXPLORE_CONFIRM_ACCEPT_LABEL,
					),
					createElement(
						"button",
						{
							style: {
								...S.bigBtn(true),
								background: "transparent",
								color: "var(--dsw-alias-state-error-primary)",
							},
							onClick: () => setRejecting(true),
							disabled: busy,
						},
						"🔁 让 AI 重做",
					),
					createElement(
						"button",
						{
							style: { ...S.smallLink, textDecoration: "none" },
							onClick: onViewReport,
							disabled: busy,
						},
						"👀 看完整报告",
					),
				),
	);
}

// ── 章节安排确认卡（D1 人审：awaiting-outline 时的焦点区） ─────────────────────

/**
 * 章节安排确认卡的 props 契约（票 `workbench-card-contract` 02）
 *
 * **这张卡吃什么**：四件，全是「书 + 壳」直接递过来的——`meta`（书级只读）、`knowledgeMapText`
 * （书级只读，知识地图原文——票 `pipeline-wiring-gaps/12` 起「必须覆盖 ↔ 已认领」对应关系吃它）、
 * `busy`（壳级可变）、`confirmOutline`（壳注入的回调，整形成 prop `onConfirm`）。收编前由
 * `client-entry.js` 的 `case "outline"` 那一整块逐项手抄。
 *
 * ### 必填两项的判据：卡内**没有兜底**
 *
 * · `meta` —— spec「error modes」写死的一条：**缺 `meta` 就抛**（12 个 slot 在无书时一个都不渲染，
 *   缺 `meta` 是真错）。卡内 `meta?.outline?.chapters ?? []`（`:563`）用 `?.` 让它在 `meta === null`
 *   时渲出一张**空账卡**（「AI 计划把这本书分成 0 章」）——不崩，但那是**屏上对用户说假话**。
 *   ⚠️ `null`（无当前书，壳那一份是 `coreData === null ? null : coreData.meta`）**不算缺**：缺省三
 *   规则第 2 条与本 module 的必填校验都只认 `undefined`。
 * · `confirmOutline` → 整形成 prop `onConfirm` —— `:742` / `:768` 两处用户点击直接调它，无守卫。
 *   缺了 = 点「✅ 通过，开始写最佳范例章」或「🔁 就这样重新安排」当场 TypeError。
 *
 * ### `knowledgeMapText` 不列必填，漏了会怎样
 *
 * `parseKnowledgeMap` 的形状兜底（不是字符串 / 解析失败 → null）让卡退回「没有对照面」那一格：
 * 对应清单**整节不渲染**（不印半份假信息），确认流程照走——与 ExploreConfirmCard 那一份
 * `knowledgeMapText` 同一待遇。注意它与票 12 的服务端闸门是**两回事**：闸门在 outline 交工时
 * 拒交，这里只把同一份比对结果给人看；无源书没有对照面，两边都不判。
 *
 * ### 为什么 prop 名要绕一圈（全局规则，壳那边裁的）
 *
 * 兄弟卡 `exploreConfirmCardView` 的 prop 也叫 `onConfirm`，指的却是壳里另一个函数
 * （`confirmExplore`）。一本扁平的 book 容不下同名两义，所以**book 键取不撞名的那个**，prop 名
 * 一字不改，由 `derive` 整形。✅ 这一位**已经收成一道闸**：`.with({ onConfirm: … })` 当场抛
 * `CardViewError`——`build` 的 ③ 只认 `fromBook` ∪ `defaults` 声明过的键，**不含** `derive` 产出的
 * 键。**为什么是闸不是纪律**：整形是 `derive` 的职责，若 `.with` 改得动整形结果，同一个名字就有两
 * 处来源——正是这张票要消灭的形状。`onConfirm` 只由 `book.confirmOutline` 决定。
 *
 * ### `busy` 不列必填，漏了会怎样
 *
 * 全卡只作 `disabled` 用（`:695` 那个可改选的下拉、`:743` / `:755` / `:769` / `:782` 那几颗键）。
 * 漏了不崩，是**按钮永不置灰**（AI 还在安排时用户能重复点）。它与另外 11 个 slot 共用同一份
 * `BookSessionScope` 的 `ui.busy`——一处漏传全体失守，所以壳那一份只该构造一次。
 */
export const outlineConfirmCardView = defineCardView({
	card: "OutlineConfirmCard",
	fromBook: ["meta", "knowledgeMapText", "busy", "confirmOutline"],
	required: ["meta", "confirmOutline"],
	defaults: {},
	// 整形：壳里不撞名的 `confirmOutline` → 卡片消费的那个 `onConfirm`；「第 N 章」那类派生全在
	// 卡内按 `meta` 现算（`:578-582`），不进这里。⚠️ `derive` 只拿得到一个参数（此刻的袋子，
	// `build` 的 ④）：delta 已排在它之前，从袋里读到的就是最终值。
	derive: (bag) => ({ onConfirm: bag.confirmOutline }),
});

export function OutlineConfirmCard(props) {
	const { meta, knowledgeMapText, busy, onConfirm } = props;
	const [rejecting, setRejecting] = useState(false);
	const [note, setNote] = useState("");
	const chapters = meta?.outline?.chapters ?? [];
	// 票 31 / ADR-0026（grilling Q1 选 B）：第 3 阶段**干脆不印字数**——
	// 全书体量的「已定」性质后置到样章定稿之后（谈判桌上只报那一次）。
	// 「不显示」≠「不产生」：chapters[].targetWords 仍是契约必填，数据一个字没删。
	// 样例章：默认取旧账本兜底 meta.goldChapter ?? 1；用户可改选（只对确认生效）。
	const [goldPick, setGoldPick] = useState(() => {
		const initial = Number(meta?.goldChapter ?? 1);
		return Number.isSafeInteger(initial) &&
			initial >= 1 &&
			initial <= chapters.length
			? initial
			: 1;
	});
	const goldReason =
		typeof meta?.goldChapterReason === "string" ? meta.goldChapterReason : "";
	const safePick =
		Number.isSafeInteger(Number(goldPick)) &&
		Number(goldPick) >= 1 &&
		Number(goldPick) <= chapters.length
			? Number(goldPick)
			: 1;
	// 票 `pipeline-wiring-gaps/12`：「本书必须覆盖的知识点」↔「已认领」的对应关系，拍板前给人看。
	// 比对与 outline 交工的机器闸门是**同一份函数**（`domain-rules.outlinePointsCoverage`：
	// title 口径 ＋ 规范化）——屏上说的和机器判的不许是两套。判定的**门面**也照抄闸门：
	// 只对「有转换完成的源 ＋ 知识地图上有知识点」的书显示（无源书的知识点清单本就是空的，
	// 机器不判、卡也不印——否则卡会替机器说它不做的判断）；没有对照面时整节不渲染：
	// 不印半份假信息，确认流程照走（读不出地图的拒交由闸门在交工时点名）。
	const knowledgeMap = parseKnowledgeMap(knowledgeMapText);
	const coverage =
		okMaterialNumbers(meta?.sources).length > 0 &&
		knowledgeMap !== null &&
		knowledgeMap.kps.length > 0
			? outlinePointsCoverage(knowledgeMap.kps, chapters)
			: null;

	return createElement(
		"div",
		{ style: S.focus },
		createElement(
			"strong",
			{ style: { fontSize: "14px" } },
			"📐 章节安排出来了！",
		),
		createElement(
			"p",
			{ style: { margin: "6px 0" } },
			// 票 31 / ADR-0026（grilling Q1 选 B）：不印「全书大约 X 汉字」，也不印逐章字数。
			// 如实告知它为什么不在这里——等最佳范例章写完、实测之后再定（谈判桌上只报那一次）。
			`AI 计划把这本书分成 ${chapters.length} 章。每章标好了用材料的哪一块、覆盖哪些知识点。每章多少字，等最佳范例章写完、实测之后一起定。满意点「通过」，AI 先把第 ${safePick} 章当最佳范例章写出来给你过目；要调就点「让 AI 重做」。`,
		),
		createElement(
			"div",
			{
				style: {
					margin: "4px 0 8px",
					padding: "8px 10px",
					background: "var(--dsw-alias-bg-layer-1)",
					borderRadius: "8px",
					border: "1px solid var(--dsw-alias-border-l2)",
				},
			},
			chapters.map((chapter, index) => {
				// F38（2026-08-20 走查）：每章源材料索引措辞——「源：」前缀 + 「覆盖知识点 N 个」（N=points 数组长度）。
				const pointsArr = Array.isArray(chapter?.points)
					? chapter.points
							.map((pt) => String(pt ?? "").trim())
							.filter((pt) => pt !== "")
					: [];
				const points = pointsArr.join(" / ");
				const volumeReason =
					typeof chapter?.volumeReason === "string" ? chapter.volumeReason : "";
				return createElement(
					"div",
					{ key: index, style: { fontSize: "12px", margin: "4px 0" } },
					`${index + 1}. ${chapter.title ?? ""}`,
					chapter.outline !== undefined &&
						chapter.outline !== "" &&
						chapter.outline !== null
						? createElement(
								"span",
								{ style: { opacity: 0.6 } },
								`　${chapter.outline}`,
							)
						: null,
					// 票 31 / ADR-0026：逐章那行原来的「约 N 汉字」也一并撤掉
					//（第 3 阶段不假装字数是承诺）；数据仍在 outline.chapters[].targetWords。
					chapter.source !== undefined &&
					chapter.source !== "" &&
					chapter.source !== null
						? createElement(
								"div",
								{ style: { opacity: 0.6, margin: "1px 0 0" } },
								`源：${chapter.source}`,
							)
						: null,
					pointsArr.length > 0
						? createElement(
								"div",
								{ style: { opacity: 0.6, margin: "1px 0 0" } },
								`覆盖知识点 ${pointsArr.length} 个${points !== "" ? `：${points}` : ""}`,
							)
						: null,
					volumeReason !== ""
						? createElement(
								"div",
								{
									style: { opacity: 0.5, fontSize: "11px", margin: "1px 0 0" },
								},
								`体量依据：${volumeReason}`,
								)
							: null,
					);
				}),
		),
		// 票 `pipeline-wiring-gaps/12`：「必须覆盖 ↔ 已认领」对应清单——知识地图里每条知识点
		// 出一行，认领了的标章号，没认领的点名（用户拍板前自己核；漏了交工也会被机器拒并点名）。
		// 骨架里知识地图没有的条目同样点出（反向也是拒交项）。没有对照面时整节不渲染。
		coverage === null
			? null
			: createElement(
					"div",
					{
						style: {
							margin: "0 0 8px",
							padding: "8px 10px",
							background: "var(--dsw-alias-bg-layer-1)",
							borderRadius: "8px",
							border: "1px solid var(--dsw-alias-border-l2)",
							fontSize: "12px",
						},
					},
					createElement(
						"div",
						{ style: { fontWeight: 600, margin: "0 0 4px" } },
						`🧭 本书必须覆盖的知识点（${coverage.claims.length} 个）——每条都要有章节认领：`,
					),
					coverage.claims.map(({ title, chapters: claimedBy }) =>
						createElement(
							"div",
							{
								key: title,
								style: {
									margin: "2px 0",
									color: claimedBy.length > 0 ? undefined : "var(--dsw-alias-state-error-primary)",
								},
							},
							claimedBy.length > 0
								? `✓ ${title} —— 已认领：${claimedBy.map((n) => `第${n}章`).join("、")}`
								: `✗ ${title} —— 还没有章节认领`,
						),
					),
					coverage.foreign.length > 0
						? createElement(
								"div",
								{
									style: {
										margin: "4px 0 0",
										color: "var(--dsw-alias-state-error-primary)",
									},
								},
								`⚠️ 骨架里有知识地图没有的条目（交工会被机器拒）：${coverage.foreign
									.map((f) => `第${f.chapter}章「${f.title}」`)
									.join("、")}`,
							)
						: null,
				),
		createElement(
			"div",
			{
				style: {
					margin: "4px 0 10px",
					display: "flex",
					alignItems: "center",
					gap: "6px",
					flexWrap: "wrap",
				},
			},
			createElement(
				"span",
				{ style: { fontSize: "12px" } },
				// 票 10（判定一 #3）：「样例章」与同一张卡下面按钮上的「最佳范例章」是同一件事两种叫法，
				// 统一取界面词表定的「最佳范例章」（CONTEXT.md「范例章」词条：对外统一为最佳范例章）。
				`📐 AI 建议用第 ${safePick} 章当最佳范例章：${goldReason !== "" ? goldReason : "（未给理由）"}`,
			),
			chapters.length > 1
				? createElement(
						"select",
						{
							style: {
								fontSize: "12px",
								padding: "2px 4px",
								borderRadius: "6px",
								border: "1px solid var(--dsw-alias-border-l2)",
								background: "var(--dsw-alias-bg-layer-1)",
							},
							value: safePick,
							onChange: (e) => setGoldPick(Number(e.target.value)),
							disabled: busy,
						},
						chapters.map((chapter, index) =>
							createElement(
								"option",
								{ key: index, value: index + 1 },
								`${index + 1}. ${chapter.title ?? ""}`,
							),
						),
					)
				: null,
			chapters.length > 1
				? createElement(
						"span",
						{ style: { fontSize: "11px", opacity: 0.6 } },
						"（可改选）",
					)
				: null,
		),
		rejecting
			? createElement(
					"div",
					{
						style: {
							marginTop: "10px",
							borderTop: "1px dashed var(--dsw-alias-border-l2)",
							paddingTop: "8px",
						},
					},
					createElement(
						"p",
						{ style: { margin: "0 0 6px", fontWeight: 600 } },
						"改哪里？写一句（比如：第3章拆成两章 / 每章字数太多）",
					),
					createElement("textarea", {
						style: S.textarea,
						placeholder: "想怎么调，写在这里（可不填，AI 会自己重新安排）",
						value: note,
						onChange: (e) => setNote(e.target.value),
					}),
					createElement(
						"div",
						{ style: { marginTop: "8px", display: "flex", gap: "8px" } },
						createElement(
							"button",
							{
								style: S.bigBtn(false),
								onClick: () => onConfirm(false, note.trim()),
								disabled: busy,
							},
							"🔁 就这样重新安排",
						),
						createElement(
							"button",
							{
								style: { ...S.smallLink, textDecoration: "none" },
								onClick: () => {
									setRejecting(false);
									setNote("");
								},
								disabled: busy,
							},
							"取消",
						),
					),
				)
			: createElement(
					"div",
					{ style: { display: "flex", gap: "8px", flexWrap: "wrap" } },
					createElement(
						"button",
						{
							style: S.bigBtn(true),
							onClick: () => onConfirm(true, note, safePick),
							disabled: busy,
						},
						"✅ 通过，开始写最佳范例章",
					),
					createElement(
						"button",
						{
							style: {
								...S.bigBtn(true),
								background: "transparent",
								color: "var(--dsw-alias-state-error-primary)",
							},
							onClick: () => setRejecting(true),
							disabled: busy,
						},
						// 票 10（判定一 #7）：与另一张确认卡的「🔁 让 AI 重做」是同一动作，统一成这一句
						// （引擎播报里告诉用户点哪个按钮的话也同步改了）。
						"🔁 让 AI 重做",
					),
				),
	);
}
