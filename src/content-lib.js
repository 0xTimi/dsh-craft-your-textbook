/**
 * 造书内容生成库（v2 · 主 AI 嵌入工作流）
 *
 * 流水线（源探查/设计提案/章节骨架/范例章/铺章/自查/合并）真实模式已交由
 * 主对话 AI 统筹完成（可亲手做或派小助手；宿主通过 workbench_act 的 stage-brief 派发方法论素材，
 * 不在这里跑子代理）。本库保留：
 *  - demo 模式：演示书的流水线占位产出（明确标注演示内容，仅用于熟悉流程）
 *  - 向导与辅助：选书建议（wizard）、PDF 角色识别（roles）、每章字数建议（words）
 *    —— 这三类仍是宿主侧一次性子代理（快捷建议，非流水线写作）
 *
 * resources/ 方法论文件由 workflow.js 的 buildStageBrief 通过 resourceText 读取，
 * 嵌入交办说明给主 AI。
 */

import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { jsonrepair } from "jsonrepair";
import {
	ROLES,
	guessRoleFromName,
	// 探查报告的**必做小节名**（票 `demo-flow-fidelity/04`）——演示夹具那份 `工作区/explore.md`
	// 必须逐字含这几个词：验货是 `includes` 子串匹配（`src/workflow/actions/chapters.js:447-452`），
	// 这里抄一份字面量就等于第二份会漂的词表（词表改名 → 夹具静默失配 → 演示书第一份报告
	// 按真实口径当场 400）。小节名只此一处，派生面＝下面 `demoExplore()` 的 `index`。
	EXPLORE_ITEM_CODE_TABLE,
	EXPLORE_ITEM_TRUTH_CALIBRATION,
	EXPLORE_ITEM_COMMON_ANCHORS,
} from "./domain-rules.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const RESOURCES_DIR = join(HERE, "..", "resources");

/** 读 vendored 方法论文件；缺失时返回提示。
 *  带 mtime+size 内容缓存（P0-2）：resources/ 是只读静态文件，命中缓存时返回内容与磁盘一致，
 *  不改变产物内容；按文件变更（mtimeMs/size）失效，无陈旧风险。 */
const resourceCache = new Map(); // rel -> { mtimeMs, size, text }
export function resourceText(rel) {
	const p = join(RESOURCES_DIR, rel);
	try {
		const stat = statSync(p);
		const cached = resourceCache.get(rel);
		if (
			cached !== undefined &&
			cached.mtimeMs === stat.mtimeMs &&
			cached.size === stat.size
		) {
			return cached.text;
		}
		const text = readFileSync(p, "utf8");
		resourceCache.set(rel, {
			mtimeMs: stat.mtimeMs,
			size: stat.size,
			text,
		});
		return text;
	} catch {
		return `（方法论文件缺失: ${rel}）`;
	}
}

const DEMO_MARK = "【演示内容 · 仅用于熟悉流程，非真实产出】";

// ── 一次性子代理执行（向导/识别/字数建议等快捷任务用） ─────────────────────

/**
 * 派发一个一次性子代理，返回其最终文本。
 * runtime: { ctx, demo, dir, project, getParent }
 * timeoutMs：单任务硬超时（默认 30 分钟——P2-10 从 15 分钟放宽，避免长章写作被硬超时打断；超时自动报错）。
 */
async function runSubagent(
	runtime,
	label,
	promptText,
	timeoutMs = 30 * 60 * 1000,
) {
	const parent = await runtime.getParent();
	const run = await runtime.ctx.subagents.start("spawn", {
		label,
		prompt: [{ type: "text", text: promptText }],
		parent,
		signal: AbortSignal.timeout(timeoutMs),
	});
	try {
		const result = await run.result;
		if (result.stopReason !== "completed") {
			const tail = result.output
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n")
				.slice(0, 300);
			runtime.ctx.logger.warn(
				`textbook: 子代理「${label}」未完成（${result.stopReason}），输出尾部: ${tail}`,
			);
			throw new Error(`子代理未完成（${result.stopReason}）`);
		}
		const text = (() => {
			const blocks = result.output.filter((block) => block.type === "text");
			// 只取最后一段文本（最终答复）；前面的推理/计划文本不算数。
			return blocks.length > 0 ? blocks[blocks.length - 1].text.trim() : "";
		})();
		if (text === "") throw new Error("子代理没有产出文本");
		return text;
	} finally {
		await run.dispose();
	}
}

/**
 * 宽容 JSON 解析：子代理输出常带解释文字、markdown 代码块、裸控制字符或未转义引号。
 * 依次尝试：直接解析 → 清理控制字符 → jsonrepair 修复 → 提取首个 {…} 片段 → 片段修复。
 */
function parseJsonLoose(raw) {
	const clean = (text) =>
		text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
	const candidates = [raw, clean(raw)];
	for (const candidate of candidates) {
		try {
			return JSON.parse(candidate);
		} catch {
			/* 继续 */
		}
	}
	for (const candidate of candidates) {
		try {
			return JSON.parse(jsonrepair(candidate));
		} catch {
			/* 继续 */
		}
	}
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start >= 0 && end > start) {
		const segment = raw.slice(start, end + 1);
		for (const candidate of [segment, clean(segment)]) {
			try {
				return JSON.parse(candidate);
			} catch {
				/* 继续 */
			}
		}
		try {
			return JSON.parse(jsonrepair(segment));
		} catch {
			/* 继续 */
		}
	}
	throw new Error(
		`AI 输出不是合法 JSON（已尝试全部修复）：${raw.slice(0, 120)}`,
	);
}

// ── 演示模式 · 流水线占位产出（仅 demo 书） ────────────────────────────────

// ── 演示夹具的**叙述口径**（票 demo-flow-fidelity/03、02）────────────────────
//
// ⚠️ 这是**演示夹具的用词／结构口径**，不是产品词表（产品词表在 `src/ui/` 与 `resources/`，
//    界面判定线见 `CONTEXT.md`「界面用词表」）。它只服务这一件事：演示书里几处叙述面
//    本来各写各的字面量，改一处必漏另一处（2026-10-07 只读审计 C3/C4/C7/C8，票 03；
//    以及 C1/C2/C5 的**章数**那一半（C6「低于 4 章下限」那条走登记豁免，见票 08），票 02——
//    见下面 `DEMO_CHAPTERS`）。
//    所以下面每一处字面量都从这几个常量派生，派生面＝demoExplore / demoGateProposal /
//    demoGoldChapter / demoOutline 这四个函数。
//
// 共用判据件的期望值也从这里取（`test-demo-fixtures.mjs` import 本文件），
// 不另抄一份口径。
//
// 票 `demo-flow-fidelity/04` 再补一件：`demoExplore()` 的 `index` 要含**探查必做小节**那三节
// （名字从 `domain-rules.js` 的 `EXPLORE_ITEM_*` import，见文件头的 import 注释）。

/** 演示夹具里材料的叫法。跟**知识地图**那一侧（`materials[]` 是产物、也是给主笔看的交办文本）。 */
export const DEMO_MATERIAL_TERM = "资料";

/** 演示夹具里唯一那份源的编号（与 demoExplore 的 `materials[].num:1` 同一份，票 01 的 Q6＝甲）。 */
export const DEMO_MATERIAL_NUM = 1;

/** 「资料1」/「资料1：数的认识部分」——演示夹具里每一处 source 引用都走这一个出口。 */
export function demoMaterialRef(part) {
	const head = `${DEMO_MATERIAL_TERM}${DEMO_MATERIAL_NUM}`;
	return part === undefined || part === "" ? head : `${head}：${part}`;
}

/** 章节板块链的**唯一**顺序（关卡 2 提案标题／关卡 3 提案摘要／`styleSpec` 三处共用）。 */
export const DEMO_SECTION_STEPS = Object.freeze(["概念", "例题", "易错点", "小练习"]);

/** 板块链的箭头写法（三处逐字相同，判据按子串比对）。 */
export const DEMO_SECTION_CHAIN = DEMO_SECTION_STEPS.join(" → ");

/** 每段的分钟数——和上面同一份 steps 走，`DEMO_CHAPTER_MINUTES` 由它求和派生。 */
export const DEMO_SECTION_MINUTES = Object.freeze({
	概念: 10,
	例题: 10,
	易错点: 5,
	小练习: 15,
});

/** 一章的总时长＝各段之和（**派生**，不手写第二份数）。 */
export const DEMO_CHAPTER_MINUTES = DEMO_SECTION_STEPS.reduce(
	(sum, step) => sum + DEMO_SECTION_MINUTES[step],
	0,
);

/** 「概念（10分钟）→ 例题（10分钟）→ ……」——关卡 3 提案摘要里的分段时长那半句。 */
export function demoSectionMinutesText() {
	return DEMO_SECTION_STEPS.map((step) => `${step}（${DEMO_SECTION_MINUTES[step]}分钟）`).join(" → ");
}

/**
 * 演示书的**章级骨架**——「这本书有几章、各叫什么、各写什么」的**唯一**一份事实
 * （票 `demo-flow-fidelity/02`；2026-10-07 只读审计 C1「四处章数不同」、C2「关卡 3 列的
 * 第 3／4／5 章 乘法／除法／混合运算既不在知识地图、也不在章节安排里」）。
 *
 * 派生面（改这里，下面这几处跟着走，**别在别处再抄一份章名或章数**）：
 *   - `demoOutline().chapters`（章节安排：逐字段；`source` 仍走 `demoMaterialRef()`）
 *   - `demoExplore()` 的 `index`（落成 `工作区/explore.md`，正文那句「共 N 章」）
 *   - `demoExplore()` 的 `knowledgeMap.chapterSuggestion`（条数与章名）
 *   - `demoGateProposal(3)` 的标题（「全书 N 章」）与摘要（「第1章 … → 第N章 …」那串，
 *     以及末章自查清单那句的章号——它原先写死「第 6 章」，是同一个数的第五处写法）
 *
 * ⚠️ 有意**不**把知识地图的 `knowledgePoints[].title` 也收到这份骨架里：那是**另一处**事实，
 * `test-collab-replay.mjs` 的 `checkDemoPointsCaliber` 正是拿两边互对（`chapterSuggestion[].points`
 * 逐字命中 `knowledgePoints[].title`）。两边同源＝判据变成自证（`dev-gate-scan/17` 那个病）。
 * 今天两边的字面量恰好相同——那是这条判据要**守着**的，不是要**抹平**的。
 */
export const DEMO_CHAPTERS = Object.freeze([
	Object.freeze({
		title: "数的认识",
		outline: "什么是数、数的读写、大小比较",
		sourcePart: "数的认识部分",
		targetWords: 4000,
	}),
	Object.freeze({
		title: "加减法",
		outline: "不进位/进位加法、不退位/退位减法",
		sourcePart: "加减法部分",
		targetWords: 5000,
	}),
	Object.freeze({
		title: "应用题综合",
		outline: "读懂题意、分步列式、检查答案",
		sourcePart: "应用题部分",
		targetWords: 6000,
	}),
]);

/** 演示书的章数——**派生**自 `DEMO_CHAPTERS`，不手写第二份数（票 01 裁决：骨架维持 3 章）。 */
export const DEMO_CHAPTER_COUNT = DEMO_CHAPTERS.length;

/** 「第1章 数的认识 → 第2章 加减法 → …」——关卡 3 提案摘要里那串章名（派生自 `DEMO_CHAPTERS`）。 */
export function demoChapterChainText() {
	return DEMO_CHAPTERS.map((chapter, index) => `第${index + 1}章 ${chapter.title}`).join(" → ");
}

function demoExplore() {
	return {
		index: `${DEMO_MARK}
# 源材料索引（演示）

## 材料清单
- 《示例教材》全文（由 MinerU 转换的 Markdown）

## ${EXPLORE_ITEM_CODE_TABLE}
- ${String(DEMO_MATERIAL_NUM).padStart(2, "0")} ＝《示例教材》（学生用书）：本报告唯一一份源，正文按"概念 → 例题 → 练习"组织，权威层级最高。

## ${EXPLORE_ITEM_TRUTH_CALIBRATION}
- 本报告是**演示占位**：数值与结论都不作真伪判断，也不代表真翻过源文件。真实书里这一节写的是"哪些说法只是转述、哪些在源里有出处"。

## 结构观察
1. 全书按"概念 → 例题 → 练习"组织，共 ${DEMO_CHAPTER_COUNT} 章。
2. 权威层级：教材正文 > 例题 > 练习。
3. 角色标签：学生用书（正文）、教师用书（讲解提示）。

## 教学线索
- 知识点密度中等，公式较少。
- 每章末有小结与习题，适合直接复用为"自查清单"。

## ${EXPLORE_ITEM_COMMON_ANCHORS}
- 贯穿案例"小明学数学"跨全书各章复用；每章按"${DEMO_SECTION_CHAIN}"四段式组织（板块链与关卡提案同一份口径）。
`,
		knowledgeMap: {
			materials: [
				{
					num: 1,
					sections: [
						{
							title: "数的认识",
							summary: "数与运算的基础概念",
							keywords: ["数", "运算"],
						},
					],
				},
			],
			// 票 pipeline-wiring-gaps/14：`points` 全仓统一按票 01 裁决的 **title 口径**——
			// 每一项逐字命中本夹具 `knowledgePoints[].title`（id 留在 knowledgePoints 上，
			// 但不接进比对环；把 points 写成 id 会被 test-collab-replay 的 points 口径判据点名）。
			knowledgePoints: [
				{
					id: "kp-1",
					title: "数的认识",
					source: demoMaterialRef("数的认识"),
					summary: "数与运算的基础概念",
					// 票 pipeline-wiring-gaps/06：difficulty 有登记取值域（domain-rules
					// .KNOWLEDGE_POINT_DIFFICULTY：基础/重点/难点/进阶）——夹具原写「低」是出域值
					// （只靠界面兜底灰兜着），改成域内值；顺带给「重点」「难点」两格补知识地图语境样本
					//（原先这两格全仓零样本，钉在 test-knowledge-difficulty.mjs）。
					difficulty: "基础",
				},
				{
					id: "kp-2",
					title: "加减法",
					source: demoMaterialRef("加减法"),
					summary: "不进位/进位加法、不退位/退位减法",
					difficulty: "重点",
				},
				{
					id: "kp-3",
					title: "应用题综合",
					source: demoMaterialRef("应用题"),
					summary: "读懂题意、分步列式、检查答案",
					difficulty: "难点",
				},
			],
			teachingFocus: ["重点：概念清晰", "难点：应用题理解"],
			// 票 demo-flow-fidelity/02：原先只有 1 条（审计 C5：知识点 3 条、outline 3 章，
			// 这里只建议 1 章；也低于 CHAPTER_SUGGESTION_MIN=4——那是**另一件事**，见
			// `src/domain-rules.js` 的登记豁免面，本票不做）。补齐到与 `DEMO_CHAPTERS` 同构的
			// 3 条：条数与章名都从那份骨架派生，不再手写第二份章名清单。
			// `points` 走票 01 的 **title 单键口径**——这里写的是 `DEMO_CHAPTERS[].title`，
			// 它是否逐字命中 `knowledgePoints[].title` 由回放测试逐条互对（有意不在这里同源）。
			chapterSuggestion: DEMO_CHAPTERS.map((chapter) => ({
				title: chapter.title,
				source: demoMaterialRef(),
				points: [chapter.title],
			})),
		},
	};
}

function demoGateProposal(_runtime, params) {
	const { gate, version } = params;
	const base = {
		1: {
			title: "AI 提议：先明确这本书要让学习者学会什么",
			summary:
				'这本书的目标是：学完能独立做对教材配套的基础题，并说出每个概念"是什么、为什么、怎么用"。\n最大难点：概念记住了但不会用，例题看得懂、变个形式就不会。',
		},
		2: {
			title: `AI 提议：用"${DEMO_SECTION_CHAIN}"的固定板块`,
			summary:
				'每章按四段式组织：先讲清概念（配生活例子），再给 2-3 个由浅入深的例题，然后专门讲"最容易错的地方"，最后放 5 道小练习（带答案）。\n叙述上用一个"小明学数学"的贯穿案例串起全书，降低理解门槛。',
		},
		3: {
			// 票 demo-flow-fidelity/02：章数与章名串从 `DEMO_CHAPTERS` 派生（原先写死「6 章」＋
			// 「第3／4／5章 乘法／除法／混合运算」六章，而章节安排只有 3 章，审计 C1／C2）。
			title: `AI 提议：全书 ${DEMO_CHAPTER_COUNT} 章、每章约 ${DEMO_CHAPTER_MINUTES} 分钟学完`,
			summary:
				`${demoChapterChainText()}。\n每章内部按「${DEMO_SECTION_CHAIN}」组织，四段时长：${demoSectionMinutesText()}。\n第 ${DEMO_CHAPTER_COUNT} 章末尾附"全书自查清单"。`,
		},
	};
	const entry = base[String(gate)];
	if (entry === undefined) throw new Error(`未知拍板序号: ${gate}`);
	return {
		title: `${entry.title}（演示·v${version}）`,
		summary: entry.summary,
		detail: `${DEMO_MARK}\n完整方案正文（演示）：\n${entry.summary}\n\n章节级细节表格……`,
	};
}

function demoGoldChapter(_runtime, params) {
	// 修订回路演示：把本轮意见要点织进新稿，让「稿间对比」真的看得到变化。
	const redoNote =
		typeof params?.redoNote === "string" ? params.redoNote.trim() : "";
	const redoSection =
		redoNote === ""
			? ""
			: `\n\n## 本稿按你的意见改了（演示）\n\n已照以下意见调整：${redoNote}\n`;
	return {
		styleSpec: `${DEMO_MARK}\n# style-spec（演示）\n板块：${DEMO_SECTION_CHAIN}。叙述口吻：像老师讲课，用"你"。`,
		chapter: `${DEMO_MARK}\n# 第1章 数的认识（最佳范例·演示）\n\n## 概念\n数是用来数东西的符号……\n\n## 例题\n例1 ……\n\n## 易错点\n不要把 0 和"没有"搞混……\n\n## 小练习\n1. ……（答案：……）${redoSection}`,
		audit: {
			passed: true,
			issues: [{ level: "提示", text: "演示章未做真实审计" }],
		},
	};
}

function demoChapterWrite(_runtime, params) {
	const { n, title } = params;
	return `${DEMO_MARK}\n# 第${n}章 ${title}（演示）\n\n## 概念\n（演示内容：${params.outline ?? ""}）\n\n## 例题\n例1 ……\n\n## 易错点\n……\n\n## 小练习\n1. ……`;
}

function demoChapterAudit() {
	return {
		passed: true,
		issues: [{ level: "提示", text: "演示章未做真实审计" }],
	};
}

function demoMergeBook(_runtime, params) {
	const { chapters, title } = params;
	const parts = [
		`# ${title}（演示成品）`,
		"",
		"> 本书由造书工作台演示模式生成，仅用于熟悉流程。",
	];
	for (const [n, { title: chapterTitle, text }] of chapters.entries()) {
		parts.push(
			"",
			`---`,
			"",
			`# 第${n + 1}章 ${chapterTitle}`,
			"",
			(text ?? "").replace(/^# .*$/m, "").trim(),
		);
	}
	return parts.join("\n");
}

function demoOutline() {
	// 票 pipeline-wiring-gaps/14：outline 提交按 engine.js outline 段 brief 带 `points`，
	// 每项按票 01 裁决的 **title 单键口径**（`knowledgePoints[].id` 不接进比对环）。
	// 票 demo-flow-fidelity/02：章名/章数/细目全部从 `DEMO_CHAPTERS` 派生（原先这份清单是
	// 第二处手写的章名事实，与 `explore.md`「共 6 章」、关卡 3 的六章串三处不同口径）。
	// `points` 取的是 `DEMO_CHAPTERS[].title`，与知识地图 `knowledgePoints[].title` 是**两份**
	// 字面量——靠 `test-collab-replay.mjs` 的 `checkDemoPointsCaliber` 逐项互对（缺字段/id 口径即红），
	// 有意不从知识地图派生（同源即自证，理由见 `DEMO_CHAPTERS` 的注释）。
	// `source` 仍走 `demoMaterialRef()`（票 03 收口的引用出口：本书只有 1 份源，票 01 的 Q6＝甲；
	// 原先第 3 章那句「材料2：应用题部分」是凭空来的编号，审计 C3）。
	return {
		chapters: DEMO_CHAPTERS.map((chapter) => ({
			title: chapter.title,
			outline: chapter.outline,
			source: demoMaterialRef(chapter.sourcePart),
			points: [chapter.title],
			targetWords: chapter.targetWords,
		})),
	};
}

// ── 选书向导 / 角色识别 / 字数建议（真实子代理） ──────────────────────────

// 规则兜底 guessRoleFromName 与角色五分类（原 ROLE_LIST）已收编至
// ./domain-rules.js —— 领域规则单一事实来源，前后端共用。

// 书名/目标净化：LLM 偶尔给 name 加「开始：」「书名：」等口水前缀，后端源头剥掉。
// 前端 pickSuggestion（event-cards.js）另有兜底剥离，防其他来源漏网。
const cleanSuggestionText = (s) =>
	typeof s === "string"
		? s.replace(/^\s*(?:开始|书名|建议|题目|目标)[:：]\s*/, "")
		: s;

async function wizardSuggest(runtime, params) {
	const hint =
		typeof params.hint === "string" && params.hint.trim() !== ""
			? params.hint.trim()
			: "";
	if (runtime.demo) {
		return {
			suggestions:
				hint === ""
					? [
							{
								name: "初中数学·有理数",
								goal: "学完能独立做对教材配套的基础题，并说出每个概念是什么、为什么、怎么用",
								science: true,
							},
							{
								name: "小学英语·自然拼读",
								goal: "看到陌生单词能试读出来，听写常见单词不再怕",
								science: false,
							},
							{
								name: "高中物理·力学入门",
								goal: '能用受力分析解典型题，看懂"为什么物体会动"',
								science: true,
							},
						]
					: [
							{
								name: `围绕"${hint.slice(0, 12)}"的入门书`,
								goal: "学完能独立完成对应基础练习，并说出每个概念是什么、为什么、怎么用",
								science: false,
							},
							{
								name: `${hint.slice(0, 12)}：从例子到规律`,
								goal: "能用自己的话讲清楚知识点的来龙去脉，做对配套练习",
								science: false,
							},
							{
								name: `${hint.slice(0, 12)}：查漏补缺版`,
								goal: "找出最薄弱的两三处并逐一攻克，配套练习正确率达到九成",
								science: false,
							},
						],
		};
	}
	const contextBlock =
		hint === ""
			? "用户没有填写背景信息。请给出 3 个覆盖面广的通用建议（不同学科/场景）。"
			: `用户的背景信息：「${hint}」——这是唯一依据，严禁无视它、套用默认模板。`;
	const prompt = `你是"造书工作台"的选书顾问，为想"造一本书"的用户推荐起点。用户是谁、想要什么，完全由下面这条背景信息决定：

${contextBlock}

规则：
1. 背景填写了：先想清楚"这位用户是谁、最急的事是什么"，再推荐对应的书。
   · 背景是成年人/职业/考证（如 PMP、CPA、法考、考研）→ 推荐对应的备考书，书名和 goal 都用成年人的说法。
     例子：name「PMP 备考·项目管理知识体系」goal「学完能掌握五大过程组与十大知识领域，刷题正确率 80% 以上，有信心走进考场」。
   · 背景是学习者/年级/学科（如三年级、古诗）→ 推荐对应的教材书。
2. 背景没填写：给 3 个不同方向的通用建议。
3. 严禁无视背景、一律按"中小学生教材"输出。
4. name 只写书名本身（如「初中数学·有理数」），严禁带「开始：」「书名：」「建议：」等任何前缀；goal 同理，严禁带「目标：」等前缀。

输出严格 JSON（不要解释、不要代码块）：
{"suggestions":[{"name":"书名（具体、贴近教材）","goal":"学完要能做到什么（一句话，具体可检验，措辞贴合用户身份）","science":true或false}]}
三个建议要互相有差异（打基础 / 补短板 / 提兴趣 / 备考冲刺等）。
字符串内部严禁使用英文双引号，引用一律用「」。`;
	const raw = await runSubagent(runtime, "选书建议", prompt);
	const parsed = parseJsonLoose(raw);
	if (Array.isArray(parsed.suggestions) && parsed.suggestions.length > 0) {
		return {
			suggestions: parsed.suggestions.map((sg) => ({
				...sg,
				name: cleanSuggestionText(sg.name),
				goal: cleanSuggestionText(sg.goal),
			})),
		};
	}
	throw new Error("建议格式不对");
}

/**
 * 每个素材角色给识别 AI 的一句判据提示（**注记，不是值集**）。
 *
 * 键是角色名、值是提示语；键**对不上**的角色照样出得来（只是没那句提示），值也永远进不了
 * prompt——因为 prompt 的枚举是按 `ROLES` 逐个渲染的（见 buildRolePrompt）。
 * 换句话说：这张表可以过时（角色改名后旧键变死键），但它**不能**制造一个角色出来。
 */
const ROLE_HINTS = {
	学生用书: "课本正文",
	教师用书: "教师版、教参、教学指导",
	考纲: "考试大纲、课程标准",
	讲义: "补充讲义、教案、课件、笔记",
	真题: "历年试卷、真题集、练习题集",
};

/**
 * 素材角色识别的 prompt（票 pipeline-wiring-gaps/04）。
 *
 * **枚举与「几类」的计数都从 `roles` 派生**（生产调用点传 `ROLES`，见 suggestRoles）。
 * 原先是逐字写死「只能从这 5 类里选 1 个」＋五行角色字面量，而 `ROLES` 只在事后过滤用到——
 * 改 `ROLES` 会让这份 prompt **静默分叉**，没有任何测试会红。
 *
 * 导出是为了让测试能拿**合成的角色集合**跑一遍（证明枚举是入参的函数、不是常量）；
 * 生产代码自己只走 `buildRolePrompt(listText, ROLES)` 那一处。
 *
 * @param {string} listText 已编号的文件名清单
 * @param {readonly string[]} roles 候选角色（值集的唯一来源）
 * @returns {string} 交给识别子代理的 prompt 全文
 */
export function buildRolePrompt(listText, roles) {
	const choices = roles
		.map((role) => {
			const hint = ROLE_HINTS[role];
			return hint === undefined ? `- ${role}` : `- ${role}：${hint}`;
		})
		.join("\n");
	// 票 09：这段是发给识别子代理的**界面措辞**——退役「教材 PDF」，数材料说「份」。
	return `你是教材分类助手。用户一次性上传了几份材料，请根据"文件名"判断每份属于哪一类，只能从这 ${roles.length} 类里选 1 个：
${choices}

文件名列表：
${listText}

输出严格 JSON（不要解释、不要代码块）：
{"roles":[{"file":"文件名（原样照抄）","role":"类别"}]}
每个文件都要有；拿不准的按文件名猜一个最像的。字符串内部严禁使用英文双引号。`;
}

async function suggestRoles(runtime, params) {
	const files = Array.isArray(params.files) ? params.files.slice(0, 20) : [];
	if (files.length === 0) return { roles: [] };
	if (runtime.demo) {
		return {
			roles: files.map((file) => ({ file, role: guessRoleFromName(file) })),
		};
	}
	const listText = files
		.map((file, index) => `${index + 1}. ${file}`)
		.join("\n");
	const prompt = buildRolePrompt(listText, ROLES);
	const raw = await runSubagent(runtime, "识别角色", prompt);
	const parsed = parseJsonLoose(raw);
	if (!Array.isArray(parsed.roles) || parsed.roles.length === 0)
		throw new Error("角色格式不对");
	// 按原始文件名对齐，缺的用规则补。
	const byFile = new Map(parsed.roles.map((item) => [item.file, item.role]));
	const roles = files.map((file) => ({
		file,
		role: ROLES.includes(byFile.get(file))
			? byFile.get(file)
			: guessRoleFromName(file),
	}));
	return { roles };
}

async function suggestWords(runtime, params) {
	const goal = typeof params.goal === "string" ? params.goal : "";
	const route =
		params.route === "human"
			? "给人直接读的教材"
			: "给 AI 老师上课用的教学蓝本";
	const science = params.science === true;
	const chapterCount =
		Number.isFinite(Number(params.chapterCount)) &&
		Number(params.chapterCount) > 0
			? Number(params.chapterCount)
			: 7;
	const currentTargets = Array.isArray(params.currentTargets) ? params.currentTargets : [];
	const goldChapter = Number.isSafeInteger(params.goldChapter) ? params.goldChapter : 1;
	const goldMeasuredHanzi = Number.isFinite(params.goldMeasuredHanzi)
		? Math.round(params.goldMeasuredHanzi)
		: null;
	const fallbackPerChapter = currentTargets.map((chapter) => ({
		n: chapter.n,
		targetWords: Number.isFinite(chapter.targetWords) ? chapter.targetWords : 6000,
		reason: chapter.reason ?? "",
	}));
	if (runtime.demo) {
		return {
			suggested: 6000,
			range: "5000-7000",
			reason: "（演示建议）按内容密度给每章约 6000 汉字。",
			perChapter: fallbackPerChapter,
		};
	}
	const measuredLine = goldMeasuredHanzi === null
		? `第 ${goldChapter} 章范例章实测：正文尚未生成`
		: `第 ${goldChapter} 章范例章实测：${goldMeasuredHanzi} 汉字`;
	const targetLines = currentTargets.length === 0
		? "（尚无逐章目标）"
		: currentTargets
			.map((chapter) => {
				const current = Number.isFinite(chapter.targetWords)
					? `${chapter.targetWords} 汉字`
					: "未定";
				return `- 第 ${chapter.n} 章「${chapter.title || "未命名"}」现有目标：${current}${chapter.reason ? `；依据：${chapter.reason}` : ""}`;
			})
			.join("\n");
	const prompt = `你是"造书工作台"的编辑顾问，为一位家长/老师建议每章目标汉字数。

学习目标：${goal || "（未填写）"}
使用方式：${route}
理科内容：${science ? "是" : "否"}
全书章节数：${chapterCount} 章
${measuredLine}
现有逐章目标：
${targetLines}

请结合最佳范例章的实测体量、各章现有目标、标题、内容密度与例题量，给出**每一章**的目标汉字数建议。这是供用户预填和拍板的建议，不是必须命中的指标，也不要给篇幅压力。

输出严格 JSON（不要解释、不要代码块），perChapter 必须逐章齐全，形状为 {n:1-based章号,targetWords:正整数,reason:一句话}：
{"suggested":6000,"range":"5000-7000","reason":"一句话总理由（家长能看懂）","perChapter":[{"n":1,"targetWords":5400,"reason":"这一章概念少"},{"n":2,"targetWords":6800,"reason":"这一章例题多"}]}`;
	try {
		const raw = await runSubagent(runtime, "逐章字数建议", prompt, 120 * 1000);
		const parsed = parseJsonLoose(raw);
		const suggested = Number(parsed.suggested);
		if (!Number.isFinite(suggested) || suggested < 500)
			throw new Error("建议字数不合法");
		if (!Array.isArray(parsed.perChapter) || parsed.perChapter.length !== chapterCount)
			throw new Error("逐章建议不完整");
		const perChapter = parsed.perChapter.map((chapter) => {
			const n = Number(chapter?.n);
			const targetWords = Number(chapter?.targetWords);
			if (!Number.isSafeInteger(n) || n < 1 || n > chapterCount || !Number.isFinite(targetWords) || targetWords < 500 || targetWords > 50000)
				throw new Error("逐章建议格式不对");
			return {
				n,
				targetWords: Math.round(targetWords),
				reason: typeof chapter?.reason === "string" ? chapter.reason : "",
			};
		});
		if (new Set(perChapter.map((chapter) => chapter.n)).size !== chapterCount)
			throw new Error("逐章建议章号重复");
		return {
			suggested: Math.round(suggested),
			range: typeof parsed.range === "string" ? parsed.range : "",
			reason: typeof parsed.reason === "string" ? parsed.reason : "",
			perChapter,
		};
	} catch {
		return {
			suggested: 6000,
			range: "5000-7000",
			reason: "（AI 建议暂不可用，保留现有逐章目标）",
			perChapter: fallbackPerChapter,
		};
	}
}

/** 自定义模式分析：用户粘贴一段教学/结构描述 → AI 提炼成「模式卡」（加入本书模式库用）。 */
async function analyzePattern(runtime, params) {
	const text = typeof params.text === "string" ? params.text.trim() : "";
	if (text === "") throw new Error("请先粘贴要分析的文本");
	if (runtime.demo) {
		return {
			card: {
				name: "自定义板块（演示）",
				problem:
					"按你粘贴的描述提炼的板块结构（演示占位，真实模式由 AI 分析生成）",
				when: "本书写作时使用",
				blocks: `1. 先呈现：${text.slice(0, 50)}${text.length > 50 ? "…" : ""}\n2. 再逐条落地为章节板块。`,
			},
		};
	}
	const prompt = `你是"造书工作台"的教学模式设计师。用户粘贴了一段对「教学结构/教法/板块」的描述，请把它提炼成一张标准「模式卡」，供 AI 写书时选用（与内置模式库格式一致）。

模式卡字段：
- name：模式名（4-12 个字的动词短语，如「先场景后概念」「误区判断题」）
- problem：它解决哪个教学问题（一句话，家长能看懂）
- when：什么时候用（什么场景/什么类型的内容适合）
- blocks：在章节里怎么落地——板块/步骤怎么排、每步干什么（可执行的写法，用「1. … 2. … 3. …」编号）

用户粘贴的文本：
「${text.slice(0, 3000)}」

输出严格 JSON（不要解释、不要代码块）：
{"card":{"name":"…","problem":"…","when":"…","blocks":"…"}}
字符串内部严禁使用英文双引号，引用一律用「」。`;
	const raw = await runSubagent(runtime, "分析自定义模式", prompt, 120 * 1000);
	const parsed = parseJsonLoose(raw);
	const card = parsed?.card;
	if (card === null || typeof card !== "object")
		throw new Error("模式分析格式不对");
	const name = typeof card.name === "string" ? card.name.trim() : "";
	if (name === "") throw new Error("模式分析缺少模式名");
	return {
		card: {
			name,
			problem: typeof card.problem === "string" ? card.problem.trim() : "",
			when: typeof card.when === "string" ? card.when.trim() : "",
			blocks: typeof card.blocks === "string" ? card.blocks.trim() : "",
		},
	};
}

/** 按任务类型生成内容。 */
export async function generateContent(runtime, kind, params = {}) {
	// 流水线任务：只支持演示模式（真实模式已由主 AI 接管，走到这说明是配置错误）。
	const pipeline = (demoCode) => {
		if (runtime.demo) return demoCode(runtime, params);
		throw new Error(
			`流水线任务「${kind}」应由主 AI 经 stage-brief/stage-submit 完成，不应在这里调用`,
		);
	};
	switch (kind) {
		case "explore":
			return pipeline(demoExplore);
		case "gate":
			return pipeline(demoGateProposal);
		case "outline":
			return pipeline(demoOutline);
		case "gold":
			return pipeline(demoGoldChapter);
		case "chapter":
			return pipeline(demoChapterWrite);
		case "audit":
			return pipeline(demoChapterAudit);
		case "merge":
			return pipeline(demoMergeBook);
		case "words":
			return await suggestWords(runtime, params);
		case "wizard":
			return await wizardSuggest(runtime, params);
		case "roles":
			return await suggestRoles(runtime, params);
		case "pattern":
			return await analyzePattern(runtime, params);
		default:
			throw new Error(`未知生成任务: ${kind}`);
	}
}
