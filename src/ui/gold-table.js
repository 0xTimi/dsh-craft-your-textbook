/**
 * 造书工作台 · 谈判桌（最佳范例章 · 风格谈判）
 *
 * Gold 系列组件：意见单、阅读与标记（段旁三键 + 笼统便签）、稿间内联对比、
 * 定稿沉淀、总装（稿页签 + 读/对比 + 意见单 + 定稿区）。
 */

import { createElement, useEffect, useState } from "react";
import { defineCardView } from "./card-view.js";
import { S } from "./styles.js";
import {
	splitParagraphs,
	paragraphHint,
	diffParagraphs,
	REVIEW_REVOKED_TEXT,
	// 票 02：意见 kind 词的**唯一一份**正名在 `rules.js`——谈判桌与章节卡说同一件事，不各写一份
	// （此前这里逐字抄了一份，与 `rules.js` 的 `REVIEW_KIND_TEXT` 恒等）。
	REVIEW_KIND_TEXT,
} from "./rules.js";
import { chapterRel, goldChapterNo } from "../domain-rules.js";
import { READER_PARA_STYLE, renderInline } from "./md-render.js";

// ── 谈判桌·意见单 ───────────────────────────────────────────────────────────

const OPINION_STATUS_TEXT = {
	pending: "待处理",
	sent: "AI 修订中",
	applied: "AI 已改",
	// 票 09：`revoked` 一个状态在界面上**只此一种说法**（`CONTEXT.md`「撤回（意见）」的正名）。
	// 取词走 `rules.js` 那一个出口，不在本文件另写一份（此前意见单与章节卡各写了一份同义说法）。
	revoked: REVIEW_REVOKED_TEXT,
};

/**
 * 一条 `sent` 意见在**第 N 稿已经回到盘上、还没交工**时的那句话（票 `walkthrough-2026-10/04`，B6）。
 *
 * 病（票面 :22-:23）：`sent → applied` 的**唯一**写回点在交工那一刻
 * （`actions/chapters.js` 的 `stage-submit gold`：`if (o.status === 'sent') o.status = 'applied'`），
 * 所以「第 2 稿已经交付、按钮区已经回到等我」时，标签**必然**停在「AI 修订中」——AI 明明已经
 * 交回稿了，屏上还在说它在改（走查 B6）。
 *
 * 前置条件就是那份事实：**这一稿在不在盘上**。
 *   · 不在盘上（AI 真在改：`gold-revise` 会先把旧稿归档挪走）⇒ 照旧「AI 修订中」；
 *   · 已在盘上（改完了、只差交工/定稿）⇒ 「已交付·待定稿」。
 * 裁决甲的原话：**`sent` 这个标签只在 AI 真在改时出现**。
 *
 * ⚠️ **我的枚举面比现实窄在哪里**：判据只有「读到了这一稿的正文」这一位（`draftLanded`），
 * 它**不区分**「AI 还在改」与「正文读不到」——两种都落回旧词「AI 修订中」。宁可退回旧词，
 * 也不把读不到当成已交付（那是替一件没看见的事作证）。
 * ⚠️ 这张卡今天**只在 `awaiting-gold` 上屏**（`focusCardKey`），所以生产上走得通的是
 * 「已交付·待定稿」那一支；旧词那一支留在函数里，供 `status: running` 的旧快照与直调断言。
 */
export const DELIVERED_AWAITING_SEAL_TEXT = "已交付·待定稿";

/**
 * 意见单里那一条的**状态词**（唯一出口）。
 *
 * @param {string} status `pending`／`sent`／`applied`／`revoked`
 * @param {{ draftLanded?: boolean }} [facts] `draftLanded`＝这一稿的正文已经在盘上
 */
export function opinionStatusText(status, { draftLanded = false } = {}) {
	if (status === "sent" && draftLanded === true) return DELIVERED_AWAITING_SEAL_TEXT;
	return OPINION_STATUS_TEXT[status] ?? status;
}

/**
 * 展示期里、有意见躺在「待处理」时那句提示（唯一出口）——票 `gold-display-period/01`。
 *
 * 病：`gold-opinion` 提交后**只是落盘排队**（`meta.goldOpinions` 追加 `status:'pending'`），
 * 而消费它的那一轮**已经定死了**——正在跑的那一轮检查读不到它（审计的必读矩阵里没有意见通道，
 * 见 `resources/references/subagent-prompts/gold-audit-prompt.md`），正在跑的主笔 AI 也读不到它
 * （意见透给 AI 的唯一出口是 brief 构造时刻，`workflow/engine.js` 的 `brief.goldOpinions`）。
 * 界面却把「提意见」画成一个当即生效的动作，而提完之后屏上**什么解释都没有**（原式在
 * `pending > 0` 时返回 `null`）——用户以为有人接了。
 *
 * 措辞里那句「等检查收工就能点这颗键」不是客套：那颗键此刻**正禁着**（票 `.../02` 的展示期闸），
 * 所以这句话必须说成「等」，不能说成「点」。
 */
export const DISPLAY_PERIOD_PENDING_HINT =
	"记下了；这一轮检查不会读这些意见，等检查收工就能点这颗键让 AI 照它们改";

/**
 * 意见单旁的**状态提示**（票 gold-revision-flow/01）：按真实状态说话。
 *
 * 原式只有一种话——`pendingCount === 0` 就说「先标记至少一条意见（段旁三键或笼统便签）」。
 * 可屏上明明挂着意见：只是它们已经「AI 修订中」/「AI 已改」/「已撤回」，按钮该灰（服务端只把
 * `pending` 交给 AI），提示却像在问用户「你还没标意见」。四态各说一句，**真空手时**才说「先标记」。
 *
 * 票 `walkthrough-2026-10/04`（B6）给 `sent` 那一支补了同一件事实：这一稿**已经在盘上**时，
 * 「等它改完」与前一行那个「已交付·待定稿」自相矛盾——说这一稿改回来了、只差定稿。
 *
 * 票 `gold-display-period/01` 给 `pending > 0` 那一支补了**第二件事实**：展示期里那句话必须说，
 * 因为此刻没有任何人读得到这些意见（见 `DISPLAY_PERIOD_PENDING_HINT` 的注释）。
 *
 * ⚠️ **我的枚举面比现实窄在哪里**：`displayPeriod` 这一位只覆盖「章稿在盘、检查记录读不到」，
 * **不覆盖**「文件在盘但内容为空」与「读到了但格式坏」——那两格与 `goldDisplayPeriod` 同一口径
 * （本函数不自己另判一格）。
 *
 * @param {Array<{status?: string}>} list 意见单
 * @param {{ draftLanded?: boolean, displayPeriod?: object | null }} [facts]
 *   `draftLanded` 与 `opinionStatusText` 吃**同一件事实**（一处定义）；
 *   `displayPeriod` 是 `goldDisplayPeriod()` 的返回值（`null`＝不是展示期）——展示期里
 *   「待处理」那一支**不再闭嘴**。
 */
export function opinionActionHint(list, { draftLanded = false, displayPeriod = null } = {}) {
	const pending = list.filter((o) => o.status === "pending").length;
	const sent = list.filter((o) => o.status === "sent").length;
	const applied = list.filter((o) => o.status === "applied").length;
	const revoked = list.filter((o) => o.status === "revoked").length;
	// 有待办：平时按钮自己写着几条，不必再补一句；**展示期例外**——那颗键此刻禁着，
	// 而「提完什么都没有」正是这一票的病，所以这一格必须说话。
	if (pending > 0) return displayPeriod !== null ? DISPLAY_PERIOD_PENDING_HINT : null;
	if (sent > 0)
		return draftLanded === true
			? "这一稿已经改回来了，还没定稿"
			: "这一轮已经交给 AI 了，等它改完";
	if (applied > 0) return "这些意见这一稿都改过了";
	// 票面 AC 点名的那一支：清单里只剩「已撤回」时**也不许**说「先标记」——屏上明明挂着意见
	//（划线的那几条），那句话仍像在问用户"你还没标意见"。说清真实状态并指出下一步。
	if (revoked > 0) return "这些意见都撤回了；要提新的，读到哪标到哪";
	return "先标记至少一条意见（段旁三键或笼统便签）";
}

export function GoldOpinionList(props) {
	const { opinions, busy, onRevoke, onRevise, draftLanded = false, displayPeriod = null } = props;
	const list = opinions ?? [];
	if (list.length === 0) {
		return createElement(
			"div",
			{ style: { ...S.card, opacity: 0.85 } },
			createElement(
				"p",
				{ style: { margin: "0" } },
				// 票 gold-revision-flow/01：空态也不许用「本稿」限定——这份清单是历次累积的。
				"📋 意见单还空着：读下面的稿子随手标记，或用最底下的「笼统提一条」。",
			),
		);
	}
	let seq = 0;
	const rows = list.map((o) => {
		if (o.status === "revoked") {
			return createElement(
				"div",
				{
					key: o.id,
					style: {
						...S.card,
						opacity: 0.45,
						textDecoration: "line-through",
						marginBottom: "6px",
					},
				},
				`${REVIEW_REVOKED_TEXT}：${REVIEW_KIND_TEXT[o.kind] ?? o.kind}${o.wish ? ` ${o.wish}` : ""}`,
			);
		}
		seq += 1;
		const target =
			o.target == null
				? "笼统（不指哪段）"
				: `第${o.target.para}段${o.target.hint ? `「${o.target.hint}」` : ""}`;
		// 票 gold-revision-flow/01：已改过的条目**默认收成一行摘要**（可展开）——它不再是待办，
		// 占着一整张卡只会让人以为还要再点一次「让 AI 照这些改」。
		// 「撤销」在这条上改叫「撤回这条意见」并说清它不回滚正文（原词很容易被读成"撤销那次修改"）。
		if (o.status === "applied") {
			return createElement(
				"details",
				{ key: o.id, style: { ...S.card, marginBottom: "6px" } },
				createElement(
					"summary",
					{ style: { cursor: "pointer", fontSize: "12px", opacity: 0.75 } },
					`#${seq} ${REVIEW_KIND_TEXT[o.kind] ?? o.kind}${o.wish ? ` · ${o.wish}` : ""} —— AI 已改`,
				),
				createElement(
					"div",
					{
						style: {
							marginTop: "6px",
							display: "flex",
							gap: "8px",
							alignItems: "baseline",
							flexWrap: "wrap",
						},
					},
					createElement(
						"span",
						{ style: { opacity: 0.75, fontSize: "12px" } },
						target,
					),
					createElement(
						"button",
						{ style: S.smallLink, onClick: () => onRevoke(o.id), disabled: busy },
						"撤回这条意见",
					),
					createElement(
						"span",
						{ style: { fontSize: "12px", opacity: 0.7 } },
						"撤回只作废这条意见（定稿时不生效），不回滚已经改好的正文",
					),
				),
			);
		}
		return createElement(
			"div",
			{ key: o.id, style: { ...S.card, marginBottom: "6px" } },
			createElement(
				"div",
				{
					style: {
						display: "flex",
						gap: "8px",
						alignItems: "baseline",
						flexWrap: "wrap",
					},
				},
				createElement("strong", null, `#${seq}`),
				createElement("span", null, REVIEW_KIND_TEXT[o.kind] ?? o.kind),
				createElement(
					"span",
					{ style: { opacity: 0.75, fontSize: "12px" } },
					target,
				),
				o.wish ? createElement("span", null, o.wish) : null,
				createElement(
					"span",
					{
						style: {
							marginLeft: "auto",
							fontSize: "12px",
							whiteSpace: "nowrap",
						},
					},
					opinionStatusText(o.status, { draftLanded }),
					" ",
					createElement(
						"button",
						{
							style: S.smallLink,
							onClick: () => onRevoke(o.id),
							disabled: busy,
						},
						"撤销",
					),
				),
			),
		);
	});
	const pendingCount = list.filter((o) => o.status === "pending").length;
	const hint = opinionActionHint(list, { draftLanded, displayPeriod });
	const activeCount = list.filter((o) => o.status !== "revoked").length;
	return createElement(
		"div",
		null,
		createElement(
			"p",
			{ style: { margin: "0 0 6px", fontWeight: 600 } },
			// 票 gold-revision-flow/01：标题改成如实说法——`meta.goldOpinions` 是**全书累积**、
			// 不分稿的（`gold-revise` 只追加、不记稿号），写「本稿」是名不副实，
			// 也正是"最新版还带着上一轮意见单"的直接来源。
			`📋 历次意见（${activeCount} 条${pendingCount > 0 ? ` · ${pendingCount} 条待处理` : ""}）`,
		),
		...rows,
		onRevise !== undefined
			? createElement(
					"div",
					{ style: { margin: "8px 0" } },
					createElement(
						"button",
						{
							style: S.bigBtn(true),
							onClick: onRevise,
							// 票 gold-display-period/02（展示期的闸）：这一颗**会作废在跑的工作**——
							// `gold-revise` 先把 `chapter-NN.md`/`style-spec.md`/`audit-NN.md` 三份归档挪走、
							// 再重开一轮 gold，而对**正在读这一份稿**的检查小助手没有任何 `interrupt`
							// （全仓 `src/**` 零处生产调用 `interrupt_agent`）⇒ 这一轮检查的产出当场作废。
							// 拦法与裁决甲给定稿键定的那条同形：**禁用 ＋ 把理由写在脸上**（此刻禁着，
							// 所以理由那一句（`DISPLAY_PERIOD_PENDING_HINT`）说的是「等检查收工就能点」）。
							disabled: busy || pendingCount === 0 || displayPeriod !== null,
						},
						pendingCount > 0
							? `🔁 让 AI 照这些改（${pendingCount} 条）`
							: "🔁 让 AI 照这些改",
					),
					// 票 gold-revision-flow/01：提示按**真实状态**分四种说法（意见ActionHint），
					// 只有真的空手（连一条都没有）才说「先标记至少一条意见」。
					hint !== null
						? createElement(
								"span",
								{
									style: { marginLeft: "8px", fontSize: "12px", opacity: 0.7 },
								},
								hint,
							)
						: null,
					createElement(
						"p",
						{ style: S.hint },
						// 票 14（承诺账 A2）：机器**没有段落级校验**（只把标过的意见交给 AI，
						// 见 engine.js 的 gold 分支）——「只改你标过的地方，其余原样保留」是结果承诺，
						// 查无机制；收成机制真做的那件事。
						"只把你标过的意见交给 AI",
					),
				)
			: null,
	);
}

// ── 谈判桌·阅读与标记（段旁三键 + 笼统便签） ───────────────────────────────

// F36（2026-08-20 走查）：首次引导脉冲只在本页会话触发一次（页面刷新后重新计）。
let goldFirstPulseDone = false;

export function GoldReader(props) {
	const {
		text,
		opinions,
		busy,
		onOpinion,
		readOnly,
		onRevokeOpinion = () => {},
	} = props;
	const [hover, setHover] = useState(null);
	const [formPara, setFormPara] = useState(null);
	const [wishText, setWishText] = useState("");
	const [wishError, setWishError] = useState(null);
	const [generalKind, setGeneralKind] = useState("change");
	const [generalText, setGeneralText] = useState("");
	const [generalError, setGeneralError] = useState(null);
	// 票 08：段落三键（😕/🗑）的**提交前确认层**。这两个键原先一击直发（handler 直接调
	// `onOpinion`），而它们恰恰是这 13 章里唯一会被连点几十次的那一类动作——误点一次，
	// AI 就已经收到并在处理这条意见了。
	// ⚠️ 这里**另起一个 state**，不复用 `GoldFinalize` 那个 `confirming`：定稿/重写的渲染块
	// 讲的是「会把意见变成全书风格线」，对一条段落意见完全不成立（段落意见不进风格线）。
	// `markConfirm = { kind, para, hint } | null`；`markWish` 是那一句**可选**理由。
	// ✏️ change 键**已经有**理由框（`formPara` + `submitWish`），本票不给它再加一层。
	const [markConfirm, setMarkConfirm] = useState(null);
	const [markWish, setMarkWish] = useState("");
	// F36：进入标记态时首段三键闪两下，教用户「这三键可标意见」（本页会话一次）。
	// pulsePhase: null=未闪 | 'on1' | 'off' | 'on2' | 'done'（done 后不再闪）。
	const [pulsePhase, setPulsePhase] = useState(null);
	useEffect(() => {
		if (readOnly || goldFirstPulseDone) return undefined;
		goldFirstPulseDone = true;
		const timers = [
			setTimeout(() => setPulsePhase("on1"), 250),
			setTimeout(() => setPulsePhase("off"), 750),
			setTimeout(() => setPulsePhase("on2"), 1150),
			setTimeout(() => setPulsePhase("done"), 1650),
		];
		return () => {
			for (const t of timers) clearTimeout(t);
		};
	}, [readOnly]);
	const paras = splitParagraphs(text);
	// 段号 -> 已挂意见的标签（#N 表情），给人看「这段已标过」。
	const marked = new Map();
	let seq = 0;
	for (const o of opinions ?? []) {
		if (o.status === "revoked") continue;
		seq += 1;
		if (o.target != null && Number.isSafeInteger(o.target.para)) {
			const arr = marked.get(o.target.para) ?? [];
			arr.push(
				`#${seq} ${o.kind === "dislike" ? "😕" : o.kind === "drop" ? "🗑" : "✏️"}`,
			);
			marked.set(o.target.para, arr);
		}
	}
	const submitWish = () => {
		const wish = wishText.trim();
		if (wish === "") {
			setWishError("写一句你想让它变成什么样");
			return;
		}
		onOpinion(
			"change",
			wish,
			formPara,
			paragraphHint(paras[formPara - 1] ?? ""),
		);
		setFormPara(null);
		setWishText("");
		setWishError(null);
	};
	const submitGeneral = () => {
		const wish = generalText.trim();
		if (generalKind === "change" && wish === "") {
			setGeneralError("「要改成」请写一句话");
			return;
		}
		onOpinion(generalKind, wish, null, "");
		setGeneralText("");
		setGeneralError(null);
	};
	// 票 08：点键只**记下待提交的那一条**（不发动作），确认层里才真正发出去。
	const openMarkConfirm = (kind, n, para) => {
		setMarkConfirm({ kind, para: n, hint: paragraphHint(para) });
		setMarkWish("");
	};
	const closeMarkConfirm = () => {
		setMarkConfirm(null);
		setMarkWish("");
	};
	const submitMark = () => {
		const target = markConfirm;
		if (target === null) return;
		// 🔴 留空照样提交（＝今天一击直发那条路的逐字行为）：理由栏解决的是「用户想说更多」，
		// 不是「用户必须交代」。服务端也只对 `change` 强制要 wish（gold.js 的校验原文
		// 「不喜欢/不需要可以只点一下」就是这条硬约束的服务端一侧）。
		onOpinion(target.kind, markWish.trim(), target.para, target.hint);
		closeMarkConfirm();
	};
	// 左右留白：右 68px 给三键浮出腾地方，左 34px 给段号/已标标签的装订线腾地方。
	return createElement(
		"div",
		{ style: { paddingLeft: "34px", paddingRight: "68px" } },
		!readOnly
			? createElement(
					"p",
					{ style: { margin: "0 0 8px", fontSize: "12px", opacity: 0.75 } },
					// 票 10（判定四③）：原句 69 字本就在 90 字内，只删了「提完」前那个句号造成的断句
					// （同一句连着读更省字），信息一条不丢。
					"标记方法：鼠标停在哪一段，那段右侧就亮出三个键 😕🗑✏️；不指哪段就用最底下「笼统提一条」，提完点意见单里的【让 AI 照这些改】。",
				)
			: null,
		// 票 08：确认层摆在正文**顶部**（不是贴着被点的那一段）——用户读的是一整章，
		// 刚点的那段可能在第 188 段，贴着它弹等于弹到屏幕外。
		markConfirm !== null
			? createElement(
					"div",
					{
						style: {
							...S.card,
							borderColor: "var(--dsw-alias-state-business-primary)",
							margin: "0 0 10px",
						},
					},
					createElement(
						"p",
						{ style: { margin: "0 0 4px", fontWeight: 600 } },
						`确认：把第 ${markConfirm.para} 段记成「${REVIEW_KIND_TEXT[markConfirm.kind] ?? markConfirm.kind}」？`,
					),
					createElement(
						"p",
						{ style: { margin: "0 0 6px", fontSize: "12px", opacity: 0.85 } },
						// 这两句是**兑现的**、不是承诺（`CONTEXT.md`「承诺过度」那条账）：
						// AI 真的会照这条改这一章（这段意见随交办任务送给主笔 AI），
						// 这一章交工前也真的必须先处置它（交工校验会直接拒收没处置的 pending 意见）。
						"AI 会照这条改这一章；这一章交工前必须先处置它。",
					),
					createElement("textarea", {
						style: { ...S.input, width: "100%", boxSizing: "border-box" },
						rows: 2,
						// 提示走 placeholder、**不预填进值里**：预填会让「留空也能提交」这条硬约束
						// 变成「用户得先自己把它删掉才成立」，那就把快速标记这条路又堵回去了。
						placeholder: "想说为什么就写一句（可以不填）",
						value: markWish,
						onChange: (e) => setMarkWish(e.target.value),
					}),
					createElement(
						"div",
						{
							style: {
								display: "flex",
								gap: "8px",
								alignItems: "center",
								marginTop: "6px",
							},
						},
						// 两个热区各干一件事：提交＝发动作；再想想＝纯收起（不发任何东西）。
						createElement(
							"button",
							{ style: S.bigBtn(true), onClick: submitMark, disabled: busy },
							"✅ 提交这条",
						),
						createElement(
							"button",
							{ style: S.smallLink, onClick: closeMarkConfirm, disabled: busy },
							"再想想",
						),
					),
				)
			: null,
		paras.map((para, idx) => {
			const n = idx + 1;
			const marks = marked.get(n) ?? [];
			// F36：首段三键引导脉冲（on1/on2 亮起、off 熄灭），平时常显淡态 0.3。
			const pulsing = n === 1 && (pulsePhase === "on1" || pulsePhase === "on2");
			const pulseBtnStyle = pulsing
				? {
						background: "var(--dsw-alias-state-business-tertiary)",
						borderRadius: "6px",
						boxShadow: "0 0 0 2px var(--dsw-alias-state-business-primary)",
						transform: "scale(1.15)",
						transition: "transform 0.2s, boxShadow 0.2s, background 0.2s",
					}
				: null;
			return createElement(
				"div",
				{
					key: n,
					// 段容器相对定位：装订线、三键浮出都以它为参照，正文不占这些位置。
					style: { position: "relative" },
					onMouseEnter: () => setHover(n),
					onMouseLeave: () => setHover((cur) => (cur === n ? null : cur)),
				},
				// 左侧装订线：段号 + 已标 #N 标签（不指段时淡出到 0.35，指到时亮起）。
				createElement(
					"span",
					{
						style: {
							position: "absolute",
							left: "-34px",
							top: "0",
							fontSize: "11px",
							lineHeight: 1.6,
							whiteSpace: "nowrap",
							color: "var(--dsw-alias-state-business-primary)",
							opacity: hover === n ? 1 : 0.35,
							transition: "opacity 0.15s",
						},
					},
					String(n),
					marks.length > 0
						? createElement(
								"span",
								{ style: { display: "block" } },
								marks.join(" "),
							)
						: null,
				),
				// 正文段落：纯流式 + markdown 最小渲染（标题/加粗/列表行）。
				createElement("p", { style: READER_PARA_STYLE }, ...renderInline(para)),
				formPara === n
					? createElement(
							"div",
							{ style: { margin: "-4px 0 8px" } },
							createElement("textarea", {
								style: { ...S.input, width: "100%", boxSizing: "border-box" },
								rows: 2,
								placeholder:
									"写一句你想让它变成什么样（例：开头别反问，直接讲道理）",
								value: wishText,
								onChange: (e) => {
									setWishText(e.target.value);
									setWishError(null);
								},
							}),
							createElement(
								"div",
								{
									style: { display: "flex", gap: "8px", alignItems: "center" },
								},
								createElement(
									"button",
									{
										style: S.bigBtn(true),
										onClick: submitWish,
										disabled: busy,
									},
									"✅ 记下这条",
								),
								createElement(
									"button",
									{
										style: S.smallLink,
										onClick: () => {
											setFormPara(null);
											setWishError(null);
										},
									},
									"收起",
								),
								wishError !== null
									? createElement("span", { style: S.error }, wishError)
									: null,
							),
						)
					: null,
				// 三键浮出（absolute 定在段右上角、不占正文宽度）：F36 常显淡态 0.3（可感知、不占位），
				// 悬停或首段引导脉冲时全亮；键始终可点（悬停键本身也算悬停该段）。
				!readOnly
					? createElement(
							"div",
							{
								style: {
									position: "absolute",
									top: "-2px",
									right: "-64px",
									display: "flex",
									gap: "2px",
									opacity: hover === n || pulsing ? 1 : 0.3,
									transition: "opacity 0.15s",
									pointerEvents: "auto",
								},
							},
							(() => {
								const activeOf = (kind) =>
									(opinions ?? []).find(
										(o) =>
											o.status !== "revoked" &&
											o.target != null &&
											o.target.para === n &&
											o.kind === kind,
									);
								// toggle=true 的两态键：同段同类型已有未撤销意见 -> 再点=revoke（防误触，F14 裁决）。
								// ✏️ 传 toggle=false：点开的是改写框、本身不落账、无误触问题，行为不变（F14 裁决第 3 条）。
								const keyWith = (
									label,
									kind,
									title,
									onClick,
									toggle = true,
								) => {
									const active = toggle ? activeOf(kind) : null;
									// aria-label 与 title 同文案：让读屏用户也知道「再点=撤销」。
									const labelText =
										active != null ? `${title}（已标：再点一次=撤销）` : title;
									return createElement(
										"button",
										{
											key: label,
											"aria-label": labelText,
											style: {
												...S.smallLink,
												fontSize: "15px",
												padding: "2px 4px",
												whiteSpace: "nowrap",
												transition:
													"transform 0.2s, boxShadow 0.2s, background 0.2s",
												...(active != null
													? {
															background: "var(--dsw-alias-state-business-tertiary)",
															borderRadius: "6px",
														}
													: {}),
												...(pulseBtnStyle ?? {}),
											},
											title: labelText,
											onClick: () => {
												if (pulsing) setPulsePhase("done");
												if (active != null) onRevokeOpinion(active.id);
												else onClick();
											},
											disabled: busy,
										},
										label,
									);
								};
								return [
									// 票 08：这两个键**不再一击直发**——只打开确认层；确认层里点「提交这条」
								// 才真正调 `onOpinion`（理由可留空，留空发空串＝今天的行为）。
								keyWith("😕", "dislike", "这种写法不喜欢", () =>
										openMarkConfirm("dislike", n, para),
									),
									keyWith("🗑", "drop", "这类内容不需要", () =>
										openMarkConfirm("drop", n, para),
									),
									keyWith(
										"✏️",
										"change",
										"要改成（写一句话）",
										() => {
											setFormPara(n);
											setWishText("");
										},
										false,
									),
								];
							})(),
						)
					: null,
			);
		}),
		!readOnly
			? createElement(
					"div",
					{
						style: {
							...S.card,
							display: "flex",
							gap: "8px",
							alignItems: "center",
							flexWrap: "wrap",
						},
					},
					createElement(
						"span",
						{ style: { fontSize: "12px", opacity: 0.75 } },
						"笼统提一条（不指哪段也行）：",
					),
					["dislike", "drop", "change"].map((k) =>
						createElement(
							"button",
							{
								key: k,
								style: S.projectBtn(generalKind === k),
								onClick: () => setGeneralKind(k),
								disabled: busy,
							},
							REVIEW_KIND_TEXT[k],
						),
					),
					createElement("input", {
						style: { ...S.input, flex: "1 1 160px", minWidth: "120px" },
						placeholder: "例：整体语气再亲切一点",
						value: generalText,
						onChange: (e) => {
							setGeneralText(e.target.value);
							setGeneralError(null);
						},
					}),
					createElement(
						"button",
						{ style: S.bigBtn(true), onClick: submitGeneral, disabled: busy },
						"笼统提一条",
					),
					generalError !== null
						? createElement("span", { style: S.error }, generalError)
						: null,
				)
			: null,
	);
}

// ── 谈判桌·稿间内联对比（删除线旧文 + 绿底新文 + 意见号） ──────────────────

export function GoldCompare(props) {
	const { oldText, newText, opinions } = props;
	const oldParas = splitParagraphs(oldText);
	const newParas = splitParagraphs(newText);
	const ops = diffParagraphs(oldParas, newParas);
	// 新稿段号(1 基) -> 意见号数组；笼统意见只计数。
	const chipsByNewPara = new Map();
	let generalCount = 0;
	let seq = 0;
	for (const o of opinions ?? []) {
		if (o.status === "revoked") continue;
		seq += 1;
		if (o.target != null && Number.isSafeInteger(o.target.para)) {
			const arr = chipsByNewPara.get(o.target.para) ?? [];
			arr.push(seq);
			chipsByNewPara.set(o.target.para, arr);
		} else generalCount += 1;
	}
	const chipSpan = (n) =>
		createElement(
			"span",
			{
				key: `c${n}`,
				style: {
					fontWeight: 700,
					marginRight: "6px",
					color: "var(--dsw-alias-state-business-primary)",
					whiteSpace: "nowrap",
				},
			},
			`#${n}`,
		);
	const blocks = ops.map((op, idx) => {
		if (op.type === "del") {
			return createElement(
				"p",
				{
					key: `d${idx}`,
					style: {
						...READER_PARA_STYLE,
						textDecoration: "line-through",
						background: "var(--dsw-alias-file-diff-deleted-bg)",
						opacity: 0.75,
					},
				},
				oldParas[op.old],
			);
		}
		// same 与 add 都按新稿渲染；挂到该段的意见号亮出来（same 段挂了意见=AI 在别处落实，也给人看见）。
		const paraNo = op.new + 1;
		const chips = chipsByNewPara.get(paraNo) ?? [];
		return createElement(
			"p",
			{
				key: `n${idx}`,
				style:
					op.type === "add"
						? {
								...READER_PARA_STYLE,
								background: "var(--dsw-alias-state-success-tertiary)",
								borderColor: "var(--dsw-alias-state-success-primary)",
							}
						: READER_PARA_STYLE,
			},
			chips.map((n) => chipSpan(n)),
			" ",
			newParas[op.new],
		);
	});
	return createElement(
		"div",
		null,
		createElement(
			"p",
			{ style: { margin: "0 0 8px", fontSize: "12px", opacity: 0.75 } },
			// 票 10（判定四③）：原句 96 字压到 90 字内——「AI 会对号入座」属客套（意见单里就写着哪条
			// 是哪条），删掉后只留三种颜色/编号各自什么意思。
			`对照方式：红底划掉的是旧稿删掉的；绿底是新稿改成的；#号对应意见单里的第几条${generalCount > 0 ? `（另有 ${generalCount} 条笼统意见）` : ""}。`,
		),
		...blocks,
	);
}

// ── 谈判桌·定稿沉淀（字数 + AI 建议 + 定稿/重写确认层） ─────────────────────

export function GoldFinalize(props) {
	const { meta, opinions, busy, onApprove, onSuggestWords, onWriteTargets, displayPeriod = null } = props;
	const [targetWords, setTargetWords] = useState(""); // 兼容旧单值：仅未填章兜底
	const [targetDrafts, setTargetDrafts] = useState(() =>
		Object.fromEntries(
			(meta?.outline?.chapters ?? []).map((chapter, index) => [
				index + 1,
				Number.isFinite(chapter.targetWords) ? String(chapter.targetWords) : "",
			]),
		),
	);
	const [suggesting, setSuggesting] = useState(false);
	const [writing, setWriting] = useState(false);
	const [suggestion, setSuggestion] = useState(null);
	const [error, setError] = useState(null);
	const [confirming, setConfirming] = useState(null); // 'seal' | 'rewrite' | null
	const chapters = meta?.outline?.chapters ?? [];
	const goldNo = goldChapterNo(meta);
	const canEditTargets = meta?.canEditTargetWords === true;
	/**
	 * 不能就地调逐章目标时，**为什么**不能（票 gold-revision-flow/03 的「承诺过度」修法）。
	 *
	 * 原式只有一句「写完整本已经开始，逐章目标请到「定点修改 · 章节安排」调整」，可它在
	 * **最佳范例章生成/修订**（阶段 4、铺章根本没开始）与**已定稿**那一瞬也说这句——
	 * 那是在替一个没发生的事实作证（CONTEXT「承诺过度」）。按真实状态分三句：
	 *  - 铺章已开始（phase ≥ 5）：原句照旧，那才是真话；
	 *  - 已定稿：定稿之后目标就归全书节奏管，走定点修改；
	 *  - 还在改/写这一章：这一章还没定稿，逐章目标等定稿后再调（或走定点修改）。
	 * 兜底给中性的一句，不把「不可编辑」一律说成「已经开始了」。
	 */
	const targetEditHint = (() => {
		if (canEditTargets) return null;
		const phase = Number(meta?.phase ?? 0);
		if (phase >= 5) return "写完整本已经开始，逐章目标请到「定点修改 · 章节安排」调整。";
		if (meta?.goldSealed != null) return "这一章已定稿；逐章目标请到「定点修改 · 章节安排」调整。";
		return "正在写/改最佳范例章；逐章目标等这一章定稿后再调（或走「定点修改 · 章节安排」）。";
	})();
	const targetSignature = chapters
		.map((chapter, index) => `${index + 1}:${chapter.targetWords ?? ""}`)
		.join("|");

	/**
	 * 票 31 / ADR-0026（grilling Q2 ＋ Q3）：谈判桌上把「实测」与「逐章目标」点破成
	 * **独立一整行**的一句话：
	 *
	 *   样章实测 10,119 汉字。按这个标定，其余 12 章合计约 149,000 汉字——要调吗？
	 *
	 * 「按这个标定」＝把最佳范例章的**实测/原定之比**乘到其余各章的现有目标上：
	 * 母版章实际写了多少，其余章就照这个比例算——这样那个 +69% 的超标基准第一次被摆到台面上。
	 * 字数一律标「汉字」口径（CONTEXT.md「字数」词条，grilling Q3）。
	 *
	 * 读不到标定所需的数据时（`goldMeasuredHanzi` 不可用、母版章原定未定、只有母版章一章）
	 * **退回旧两行**（母版行里「原定 · 实测」那个既有形状）：不要空句，
	 * 旧形状不需要新词表，也少一处「界面上凭空少了一句话」说不清的差异。
	 */
	const calibratedLine = (() => {
		const measured = Number(meta?.goldMeasuredHanzi);
		if (!Number.isFinite(measured)) return null;
		const goldRow = chapters[goldNo - 1];
		const goldOriginal = Number(goldRow?.targetWords);
		const rest = chapters.filter((_, index) => index + 1 !== goldNo);
		if (!Number.isFinite(goldOriginal) || goldOriginal <= 0 || rest.length === 0)
			return null;
		const fallback = Number.isFinite(meta?.targetWords) ? Number(meta.targetWords) : 0;
		const restOriginal = rest.reduce(
			(sum, chapter) =>
				sum + (Number.isFinite(chapter?.targetWords) ? chapter.targetWords : fallback),
			0,
		);
		if (restOriginal <= 0) return null;
		const projected = Math.round((restOriginal * measured) / goldOriginal);
		return `样章实测 ${measured} 汉字。按这个标定，其余 ${rest.length} 章合计约 ${projected} 汉字——要调吗？`;
	})();
	useEffect(() => {
		setTargetDrafts(
			Object.fromEntries(
				chapters.map((chapter, index) => [
					index + 1,
					Number.isFinite(chapter.targetWords) ? String(chapter.targetWords) : "",
				]),
			),
		);
	}, [targetSignature]);

	const editableRows = chapters
		.map((chapter, index) => ({ chapter, n: index + 1 }))
		.filter(({ n }) => n !== goldNo);
	const targetRowsOk = editableRows.every(({ n }) => {
		const raw = String(targetDrafts[n] ?? "").trim();
		if (raw === "") return true;
		const words = Number(raw);
		return Number.isFinite(words) && words >= 500 && words <= 50000;
	});
	const targetsToWrite = editableRows.flatMap(({ n }) => {
		const raw = String(targetDrafts[n] ?? "").trim();
		if (raw === "") return [];
		const words = Number(raw);
		return Number.isFinite(words) && words >= 500 && words <= 50000
			? [{ n, targetWords: Math.round(words) }]
			: [];
	});
	const targetsDirty = editableRows.some(({ chapter, n }) => {
		const raw = String(targetDrafts[n] ?? "").trim();
		if (raw === "") return Number.isFinite(chapter.targetWords);
		return Number.isFinite(chapter.targetWords)
			? Math.round(Number(raw)) !== chapter.targetWords
			: true;
	});
	const requestSuggestion = () => {
		setSuggesting(true);
		setError(null);
		Promise.resolve(onSuggestWords())
			.then((result) => {
				if (result === null || !Array.isArray(result.perChapter)) {
					setError("AI 建议没有带回逐章建议，请再试一次");
					return;
				}
				const perChapter = result.perChapter.filter((item) => Number(item?.n) !== goldNo);
				setTargetDrafts((prev) => {
					const next = { ...prev };
					for (const item of perChapter) {
						const n = Number(item?.n);
						const words = Number(item?.words);
						if (!Number.isSafeInteger(n) || n < 1 || n > chapters.length) continue;
						if (Number.isFinite(words) && words >= 500 && words <= 50000) {
							next[n] = String(Math.round(words));
						}
					}
					return next;
				});
				setSuggestion({ ...result, perChapter });
			})
			.catch((err) =>
				setError(String(err instanceof Error ? err.message : err)),
			)
			.finally(() => setSuggesting(false));
	};
	const writeTargets = () => {
		if (!canEditTargets || !targetRowsOk || targetsToWrite.length === 0) return;
		setWriting(true);
		setError(null);
		Promise.resolve(onWriteTargets(targetsToWrite))
			.then((result) => {
				if (result === null) {
					setError("逐章目标没有写回，请检查提示后重试");
					return;
				}
				setSuggestion(null);
			})
			.catch((err) => setError(String(err instanceof Error ? err.message : err)))
			.finally(() => setWriting(false));
	};
	const wordsRaw = String(targetWords ?? "").trim();
	const wordsEmpty = wordsRaw === "";
	const words = Number(wordsRaw);
	const wordsOk =
		wordsEmpty || (Number.isFinite(words) && words >= 500 && words <= 50000);
	const targetToSend = wordsEmpty
		? null
		: Number.isFinite(words) && words >= 500 && words <= 50000
			? Math.round(words)
			: null;
	const live = (opinions ?? []).filter((o) => o.status !== "revoked");
	return createElement(
		"div",
		{ style: S.card },
		createElement(
			"p",
			{ style: { margin: "0 0 6px", fontWeight: 600 } },
			// 票 10（判定一 #4）：「样板」是界面词表外的第三套叫法，统一成「最佳范例章」。
			"✅ 满意了就定稿（这一章就是全书的最佳范例章）",
		),
		createElement(
			"div",
			{ style: { margin: "6px 0" } },
			// 票 31 / ADR-0026：那句点破「实测」与「逐章目标」关系的话独立占一整行，
			// 不塞进下面输入区的标题（那是「只在样章后报一次」的那一次，塞进去会像输入框的标签）。
			// 读不到标定所需数据时 calibratedLine 为 null ⇒ 退回旧两行，不留空句。
			calibratedLine !== null
				? createElement(
						"p",
						{
							style: {
								margin: "0 0 6px",
								padding: "6px 8px",
								background: "var(--dsw-alias-bg-layer-1)",
								borderRadius: "8px",
								border: "1px solid var(--dsw-alias-border-l2)",
								fontSize: "12px",
							},
						},
						calibratedLine,
					)
				: null,
			createElement(
				"p",
				{ style: { margin: "0 0 4px", fontSize: "12px", opacity: 0.8 } },
				"逐章目标（单位：汉字；来自章节安排，只在写完整本开始前可调）：",
			),
			chapters.map((chapter, index) => {
				const n = index + 1;
				const isGold = n === goldNo;
				const original = Number.isFinite(chapter.targetWords)
					? `原定 ${chapter.targetWords}`
					: "原定未定";
				// 票 31 / ADR-0026：独立那一行已经说过实测了，母版行这里只留「原定」
				// （不再把两个数字并排摆着、也不说它们的关系）；读不到时退回旧两行。
				const measured =
					calibratedLine !== null
						? ""
						: Number.isFinite(meta?.goldMeasuredHanzi)
							? ` · 实测 ${meta.goldMeasuredHanzi} 汉字`
							: " · 实测暂不可用";
				return createElement(
					"div",
					{
						key: n,
						style: {
							fontSize: "12px",
							margin: "2px 0",
							display: "flex",
							gap: "6px",
							alignItems: "center",
							flexWrap: "wrap",
						},
					},
					createElement("span", null, `${n}. ${chapter.title ?? ""}`),
					isGold
						? createElement(
								"strong",
								{ style: { color: "var(--dsw-alias-state-business-primary)" } },
								`${original}${measured}`,
							)
						: canEditTargets
							? createElement(
									"input",
									{
										"aria-label": `第 ${n} 章目标汉字数`,
										style: { ...S.input, width: "92px" },
										type: "number",
										min: 500,
										max: 50000,
										step: 100,
										value: targetDrafts[n] ?? "",
										disabled: busy || writing,
										onChange: (e) => {
											setTargetDrafts((prev) => ({ ...prev, [n]: e.target.value }));
											setSuggestion(null);
										},
									},
								)
							: createElement(
									"span",
									{ style: { opacity: 0.6 } },
									Number.isFinite(chapter.targetWords)
										? `目标 ${chapter.targetWords} 汉字`
										: "目标未定",
								),
					!isGold && canEditTargets
						? createElement("span", { style: { opacity: 0.6 } }, "汉字")
						: null,
					chapter.volumeReason
						? createElement(
								"span",
								{ style: { opacity: 0.5 } },
								`（${chapter.volumeReason}）`,
							)
						: null,
				);
			}),
			canEditTargets && onWriteTargets !== undefined
				? createElement(
						"div",
						{ style: { display: "flex", gap: "8px", alignItems: "center", marginTop: "6px" } },
						createElement(
							"button",
							{
								style: { ...S.bigBtn(true), padding: "6px 12px" },
								onClick: writeTargets,
								disabled: busy || writing || !targetRowsOk || targetsToWrite.length === 0,
							},
							writing ? "正在写回…" : "💾 写回章节安排",
						),
						createElement(
							"span",
							{ style: { fontSize: "11px", opacity: 0.65 } },
							"手动改动与 AI 建议都先预填；点「写回」才落盘。",
						),
					)
				: createElement(
						"p",
						{ style: { ...S.hint, margin: "6px 0 0" } },
						// 票 gold-revision-flow/03 复审：文案按**真实状态**说，别把「不可编辑」
						// 一律说成「写完整本已经开始」——阶段 4 改稿、刚定稿那几态铺章都还没开始。
						targetEditHint,
					),
			Number.isFinite(meta?.targetWords)
				? createElement(
						"p",
						{ style: { margin: "4px 0 0", fontSize: "12px", opacity: 0.6 } },
						`兜底统一值：${meta.targetWords} 汉字（仅未填章使用）`,
					)
				: null,
		),
		createElement(
			"div",
			{
				style: {
					display: "flex",
					gap: "6px",
					alignItems: "center",
					flexWrap: "wrap",
				},
			},
			createElement(
				"label",
				{ style: S.label },
				"兜底统一目标（汉字，可选，仅未填章使用）",
			),
			createElement("input", {
				style: { ...S.input, width: "110px" },
				type: "number",
				min: 500,
				max: 50000,
				step: 500,
				value: targetWords,
				onChange: (e) => {
					setTargetWords(e.target.value);
					setSuggestion(null);
				},
			}),
			createElement(
				"button",
				{
					style: { ...S.bigBtn(true), padding: "6px 14px" },
					onClick: requestSuggestion,
					disabled: suggesting || writing || busy,
				},
				suggesting ? "AI 思考中…" : "✨ AI 建议",
			),
		),
		suggestion !== null
			? createElement(
					"div",
					{ style: { margin: "4px 0", fontSize: "12px", opacity: 0.8 } },
					createElement(
						"p",
						{ style: { margin: "0 0 4px" } },
						`🤖 AI 建议已预填，尚未写回：整体每章约 ${suggestion.suggested} 汉字（${suggestion.range ?? ""}）。${suggestion.reason ?? ""}`,
					),
					(suggestion.perChapter ?? []).length > 0
						? createElement(
								"div",
								null,
								(suggestion.perChapter ?? []).map((item) =>
									createElement(
										"div",
										{ key: item.n, style: { margin: "1px 0" } },
										`${item.n}. ${item.title ?? ""}：${Number.isFinite(item.words) ? `约 ${item.words} 汉字` : "未定，AI 写整本时自定"}${item.reason ? `（${item.reason}）` : ""}`,
									),
								),
							)
						: null,
				)
			: null,
		!wordsEmpty && !wordsOk
			? createElement(
					"p",
					{ style: S.error },
					"兜底目标请填 500-50000 汉字，或留空只用逐章目标",
				)
			: null,
		!targetRowsOk
			? createElement(
					"p",
					{ style: S.error },
					"逐章目标请填 500-50000 汉字，或留空沿用未定。",
				)
			: null,
		targetsDirty
			? createElement(
					"p",
					{ style: { ...S.hint, margin: "4px 0" } },
					"逐章目标有未写回改动；先点「写回章节安排」再定稿。",
				)
			: null,
		error !== null
			? createElement("p", { style: S.error }, `⚠️ ${error}`)
			: null,
		// 票 walkthrough-2026-10/04（裁决甲）：「暂不可定稿」落在**这颗键的能力**上——
		// 禁用 ＋ 把理由写在它旁边（⛔ 不许亮着点了无效）。
		// 票 gold-display-period/02 把「这一版整个不要，重写」也并进这一档：它**同样会作废
		// 在跑的工作**（归档这一稿三份 ＋ 重开一轮 gold，且对在跑的检查小助手没有任何
		// `interrupt`）——理由与定稿那颗**分开写**，见 `goldDisplayPeriod.rewriteReason`。
		displayPeriod !== null
			? createElement(
					"p",
					{ style: { ...S.hint, margin: "8px 0 0" } },
					displayPeriod.finalizeReason,
				)
			: null,
		displayPeriod !== null
			? createElement(
					"p",
					{ style: { ...S.hint, margin: "2px 0 0" } },
					displayPeriod.rewriteReason,
				)
			: null,
		createElement(
			"div",
			{
				style: {
					display: "flex",
					gap: "8px",
					marginTop: "8px",
					alignItems: "center",
				},
			},
			createElement(
				"button",
				{
					style: S.bigBtn(true),
					onClick: () => {
						if (live.length > 0) setConfirming("seal");
						else onApprove(true, targetToSend);
					},
					disabled: busy || writing || !wordsOk || !targetRowsOk || targetsDirty || displayPeriod !== null,
				},
				"✅ 就按这章的风格写全书",
			),
			createElement(
				"button",
				{
					style: {
						...S.bigBtn(true),
						background: "transparent",
						color: "var(--dsw-alias-state-error-primary)",
						padding: "8px 10px",
					},
					onClick: () => setConfirming("rewrite"),
					// 票 gold-display-period/02：与上面那颗同一件事实、同一个理由（`rewriteReason`）。
					disabled: busy || writing || !wordsOk || !targetRowsOk || targetsDirty || displayPeriod !== null,
				},
				"❌ 这版整个不要，重写",
			),
		),
		createElement(
			"p",
			{ style: S.hint },
			// 票 14（承诺账 A2）：机制只透出 `pending`/`sent` 的意见（engine.js 的 gold 分支）——
			// 已经点过「让 AI 照这些改」的那批不再随整版重写下发，所以限定成「还没处理的意见」。
			"从头重写这一章；还没处理的意见会一并带给 AI 当方向",
		),
		confirming === "seal"
			? createElement(
					"div",
					{
						style: {
							...S.card,
							borderColor: "var(--dsw-alias-state-business-primary)",
							marginTop: "8px",
						},
					},
					createElement(
						"p",
						{ style: { margin: "0 0 4px", fontWeight: 600 } },
						// 票 14（承诺账 A2）：「永久生效」与机制自相矛盾——风格线可被收回
						// （collab-signals 的 style-note-revoke 置 superseded，界面自己也渲染「·（已收回）」）。
						// 改成「会生效」＋把收回的路说给用户（收回入口在对话侧，界面没有）。
						"定稿前确认：下面这些会生效（想收回，可以在对话里跟 AI 说）",
					),
					// 票 gold-revision-flow/01：定稿确认层**分两组**——原式把「本稿已照它改过的」与
					// 「会变成全书风格线的」平铺成一条，一条早就改过的意见会再次以"会生效"的姿态出现。
					// 取数口径**不变**（未撤回＝会生效），只改展示分组。
					createElement(
						"p",
						{ style: { margin: "0 0 4px", fontSize: "12px", opacity: 0.85 } },
						"① 你的意见转成「风格线」，后面每一章都照此执行：",
					),
					live
						.filter((o) => o.status !== "applied")
						.map((o, i) =>
							createElement(
								"p",
								{
									key: o.id,
									style: { margin: "0 2px 2px 12px", fontSize: "12px" },
								},
								`#${i + 1} ${REVIEW_KIND_TEXT[o.kind] ?? o.kind}${o.wish ? `：${o.wish}` : ""}${
									o.status === "pending" || o.status === "sent"
										? "（这一稿还没改到，AI 写全书时按它办）"
										: ""
								}`,
							),
						),
					live.some((o) => o.status === "applied")
						? createElement(
								"p",
								{ style: { margin: "6px 0 2px", fontSize: "12px", opacity: 0.85 } },
								"（下面这些这一稿已经照它改过了，一并沉淀为风格线：）",
							)
						: null,
					live
						.filter((o) => o.status === "applied")
						.map((o) =>
							createElement(
								"p",
								{
									key: o.id,
									style: { margin: "0 2px 2px 12px", fontSize: "12px", opacity: 0.6 },
								},
								`${REVIEW_KIND_TEXT[o.kind] ?? o.kind}${o.wish ? `：${o.wish}` : ""} —— 本稿已改`,
							),
						),
					createElement(
						"p",
						{ style: { margin: "4px 0", fontSize: "12px", opacity: 0.85 } },
						// 票 10（判定一 #4）：同上，「样板」→「最佳范例章」。
						"② 这一稿定下来当最佳范例章，AI 写整本时都照着它。",
					),
					createElement(
						"div",
						{ style: { display: "flex", gap: "8px", marginTop: "6px" } },
						createElement(
							"button",
							{
								style: S.bigBtn(true),
								onClick: () => onApprove(true, targetToSend),
								disabled: busy || writing || !wordsOk || !targetRowsOk || targetsDirty || displayPeriod !== null,
							},
							"确认，定稿",
						),
						createElement(
							"button",
							{ style: S.smallLink, onClick: () => setConfirming(null) },
							"再想想",
						),
					),
				)
			: null,
		confirming === "rewrite"
			? createElement(
					"div",
					{
						style: {
							...S.card,
							borderColor: "var(--dsw-alias-state-error-primary)",
							marginTop: "8px",
						},
					},
					createElement(
						"p",
						{ style: { margin: "0 0 6px" } },
						// 票 14（承诺账 A2）：归档是「尽力」语义（gold.js 的 `try { renameSync } catch {}`），
						// 「不丢」是全集承诺——收掉。
						"整稿丢弃重写：这一稿会归档留底，AI 从头再写一版。",
					),
					createElement(
						"div",
						{ style: { display: "flex", gap: "8px" } },
						createElement(
							"button",
							{
								style: {
									...S.bigBtn(true),
									background: "transparent",
									color: "var(--dsw-alias-state-error-primary)",
								},
								onClick: () => onApprove(false, targetToSend),
								// 票 gold-display-period/02：确认层里这颗与外面那颗同一件事实——
								// 展示期整个确认路径都不许走（理由同样写在脸上，`rewriteReason`）。
								disabled: busy || writing || !wordsOk || !targetRowsOk || targetsDirty || displayPeriod !== null,
							},
							"确认重写",
						),
						createElement(
							"button",
							{ style: S.smallLink, onClick: () => setConfirming(null) },
							"再想想",
						),
					),
				)
			: null,
	);
}

// ── 谈判桌·检查徽章（票 gold-revision-flow/02：从 GoldTable 里抽出的纯函数） ─────
// ⚠️ 票面勘误②：初值**不许**落在「已附检查记录」上。原式只在 `auditText != null` 时改写，于是三种
// "其实没有"的情形全落在默认句上——① 还没读到（undefined 初值）② 读不到/没有（拉取失败 → null）
// ③ 拿到但形状不对。三种都不许说「已附」。抽成纯函数是为了能直调断言（渲染级要 stub fetchText + 异步 effect）。
// `auditText` 形状：**undefined = 还没读到**、null = 没有／读不到、string = 读到了（内容自己判）。
export function auditBadgeText(auditText) {
	// 票 10（判定三 #9）：界面一律说「检查」——「质检」（质量门系机器词）与「自查」（机器视角）
	// 都不上人眼。文件仍是 `工作区/audit-NN.md`（机器身份词，不改）。
	// 票 gold-display-period/01：这一格说的是**本卡**在拉这个文件，不是「检查小助手正在读」——
	// 原句「正在读这一稿的检查记录」紧挨着顶栏那句「🔎 N 个小助手在跑」，读者只会读成后者。
	// 视角收回本卡（「记录读取中…」），与「这一稿还没有检查记录」并列时才是两种可分辨的事实。
	if (auditText === undefined) return "🧪 检查：记录读取中…";
	if (auditText === null) return "🧪 检查：这一稿还没有检查记录";
	try {
		const audit = JSON.parse(auditText);
		return typeof audit.passed === "boolean"
			? audit.passed === true
				? "🧪 检查：通过（没有待完善项）"
				: "🧪 检查：有几处待完善（可以让 AI 改）"
			: "🧪 检查：记录格式待完善";
	} catch {
		return "🧪 检查：记录格式待完善";
	}
}

// ── 谈判桌·展示期（票 walkthrough-2026-10/04，2026-10-06 裁决甲） ───────────────
//
// **展示期**：这一章的稿子已经在盘上（`engine.js:1730-1733` 只看文件在不在就置 `awaiting-gold`，
// 于是稿子连同验收面一起提前亮给用户——这一步**是有意的**，出处 `gold-revision-flow/02` 的
// Out of scope：它逐字把「未审稿不进阅读器」那道门判为不可达、不新增），**而这一稿的检查记录
// 还没落盘**（审计小助手还在跑）。
//
// 裁决甲要的两件事都落在这里：
//   ① 一句**明确状态**（不新造第四个状态词：状态词那一半归状态条／活性行出「我正在做」，
//      判据 `view-rules.goldDraftDisplayed`；这一句是**不占三词名额的 fact line**，
//      与「上下文已用 51%」同一类登记，见 `CONTEXT.md`「工作台状态词」）；
//   ② 「暂不可定稿」落在**定稿键的能力**上：禁用 ＋ 把理由写在脸上（⛔ 不许亮着点了无效）。
//
// ⛔ 这里**不是**乙：判据只问「这份检查记录读得到／读不到」，**不比任何文件时间**，
// 也**不改** `engine.js:1730-1733` 那一道闸门（乙要先推翻本裁决）。

/** 「这一稿已经在盘上」的**唯一判据**（读回来了、且不是空文件）——展示期那句与意见单标签共用它。 */
export function goldDraftLanded(draftText) {
	return typeof draftText === "string" && draftText.trim() !== "";
}

/**
 * 展示期那两句话（**唯一出口**）：卡内那句 fact line ＋ 定稿键旁边的理由。
 *
 * `auditText` 的形状沿用同一条通道的既有口径（见 `auditBadgeText` 上方那段）：
 * `undefined`＝还没读到、`null`＝没有／读不到、字符串＝读到了。
 *
 * ⚠️ **我的枚举面比现实窄在哪里**：`null` 这一格把「文件不在盘上」与「这次读失败」算成同一件事
 * （与徽章「这一稿还没有检查记录」同一口径）；「文件在盘但内容为空」**不算**展示期——那一格
 * 徽章说的是「记录格式待完善」，两句话不许在同一张卡上各说各的。
 *
 * @param {{ draftText?: unknown, auditText?: unknown }} facts
 * @returns {{ factLine: string, finalizeReason: string } | null} 不是展示期时回 `null`（照旧放行）
 */
export function goldDisplayPeriod({ draftText, auditText } = {}) {
	if (!goldDraftLanded(draftText)) return null; // 还没稿子：验收面此刻也没东西可展
	if (auditText !== null) return null; // 记录在盘（或还没读到）⇒ 照旧放行，不加任何新闸
	// 票 gold-display-period/01：原句「**这一稿还在检查**，暂不可定稿」是**关于进程的断言**，
	// 而这条判据只问**文件**（检查记录读不到）——检查小助手崩了、被暂停收走了、或这本书走了
	// `engine.js` 的 `auditWaived` 豁免时，它照旧说「还在检查」，用户会一直等一个不存在的人。
	// 改成它真知道的那件事（记录还没出来），`finalizeReason` 一个字不动：它本来就没说谁在跑。
	return {
		factLine: "这一稿的检查记录还没出来，暂不可定稿",
		finalizeReason: "等这一稿的检查记录出来再定稿",
		// 票 gold-display-period/02：重写那颗键的理由**另写一份**，不与上面那句合并——
		// 两颗键作废的东西不一样（定稿只是不能点；重写会把这一稿和正在跑的检查一起作废），
		// 笼统一句「暂不可用」把两种代价抹平，用户就没法据此决定要不要等。
		rewriteReason: "重写会连这一稿和正在跑的检查一起作废；等这一轮收工再决定",
	};
}

// ── 谈判桌·总装（稿页签 + 读/对比 + 意见单 + 定稿区） ────────────────────────

/**
 * 谈判桌总装（`GoldTable`）的 props 契约（票 `workbench-card-contract` 02）
 *
 * **这张卡吃什么**：八件——书级只读两件（`meta` / `goldDrafts`）、书级派生两件
 * （`goldDraftVersion` / `goldAuditText`）、壳级可变一件（`busy`）、壳注入的回调三件
 * （`postAction` / `fetchText` / `onSuggestWords`）。
 * 收编前由 `client-entry.js:1929-1964` 逐项手抄。
 *
 * ⚠️ **票 `gold-finalize-blocked/01` 从这里拿掉了一件、又加回了一件**：原先本卡在挂载 effect 里
 * 自己去读 `工作区/audit-NN.md`（经 `fetchText` → `/textbook/file`），而那份文件被判 `'machine'`
 * ⇒ 该路由对它**必然 403**，检查记录被记成「没有」，卡永远停在展示期、两颗键永远灰、刷新无效。
 * 现在检查记录原文由壳随 payload 递进来（`goldAuditText`），本卡**不再读机器产物**；
 * `fetchText` 仍然留着，但只服务正文（当前稿与旧稿页签、对比对象）。
 *
 * ### 必填五项的判据：卡内**没有兜底**
 *
 * · `meta` —— `:1404` 的 `meta.goldOpinions` 与 `:1405` 的 `goldChapterNo(meta)` 都**没有** `?.`：
 *   缺了当场 TypeError，连降级的机会都没有。
 * · `goldDraftVersion` —— 缺了 `Math.min`（`:1427`）算出 `NaN`，`pathOf` 找不到路径，`:1438` 永远
 *   是「加载中…」——**不崩，但整张卡的主区静默死在加载态**，而这正是本票要拆的那个形状。
 * · `postAction` —— 本卡所有业务动作都从它发：`:1456`（gold-opinion）、`:1571` 与 `:1590`
 *   （gold-opinion-revoke）、`:1593`（gold-revise）、`:1601`（gold-approve）、`:1605`
 *   （gold-target-words-set）。⚠️ **本文件里没有一处 `if (postAction === undefined)` 守卫**——
 *   `grep -n "postAction" src/ui/gold-table.js` 的 7 处命中里，1 处是解构、6 处是调用，**没有一处
 *   是守卫**。（票 01 查实的那三处 `=== undefined` 守卫在 `chapters-map.js:671/780/793`，
 *   **不在本文件**；那张卡才需要「守卫保留」的说明，本卡没有守卫可保留。）缺了它 = 用户点段旁那颗
 *   键当场 TypeError。
 * · `fetchText` —— 挂载 effect 里发一次（`:1413` 当前稿），换页签/对比态各再发一次。缺了当场
 *   TypeError，屏上永远停在「加载中…」。
 * · `onSuggestWords` —— 它不是本卡调的，是**转手**给 `GoldFinalize`（`:1603`），而那边 `:850`
 *   在「✨ AI 建议」那颗键的点击回调里 `Promise.resolve(onSuggestWords())`，**同样没有守卫**。
 *   缺了它 = 那颗键一点就崩。
 *
 * ### 不列必填的三件，漏了会怎样静默降级
 *
 * · `goldDrafts` —— `:1410` 的 `?? []` 兜底。漏了不崩，是**旧稿页签点了停不住**：`:1448` 算出的
 *   路径是 `null`，正文又回到「加载中…」。壳那一份在无当前书时是模块级单例 `NO_GOLD_DRAFTS`
 *   （`client-entry.js:467`），缺省三规则第 3 条要的正是这个「模块级同一引用」。
 * · `busy` —— 只作 `disabled` 用（`:1568` / `:1588` / `:1599` 三处转手给下游）。漏了 = 三处下游
 *   都不置灰，AI 还在写的时候用户能重复发意见、重复定稿。
 * · `goldAuditText` —— **三态里 `undefined` 那一格**（＝还没读到）**照旧放行**：漏了不崩、也不挂
 *   展示期，是**定稿键照旧可点**。这是有意的取舍（与 `goldDisplayPeriod` 的既有口径同源：
 *   读不出不是「没有」）——漏传的代价落在服务端那道就绪判据上（真缺检查记录时 `gold-approve`
 *   当场拒收并说明缺哪份文件），**不是**一颗永远灰着、用户猜不出为什么的键。壳侧
 *   `client-entry.js` 的 `goldAuditText` 在无当前书时传 `undefined`。
 *
 * ### 两处不许被「顺手统一」的地方
 *
 * 1. **`fetchText` 是产物读取，不是宿主钩子。** 它就是 `ui/artifact-read.js` 的 `readText`
 *    （票 03 收编的那一份），照常进 `fromBook`；它不匹配 `/^use[A-Z]/`，这份契约里也没有任何
 *    宿主钩子下沉。⚠️ 壳那侧 `client-entry.js:1957-1962`「`fetchText` 刻意不加 capture 守卫」
 *    那段注释是**契约的一部分**（票 05 的隔离边界：StrictMode 的 effect 重放会让「挂载时 capture
 *    的守卫」当场失效，正文被换成一条错误条），**一个字不许动、也不许因为收编而顺手统一掉**。
 * 2. **段旁那些键（标意见／撤回／让 AI 改／定稿／写逐章字数）不是本卡的 props。** 它们是本卡用
 *    `postAction` 包出来的闭包（`:1455-1462` 的 `addOpinion` 等），壳只递一个会发动作的函数进来
 *    ——这正是收编想要的形状：壳那份袋子从「逐项抄」变成「递一个发动作的函数」。
 */
export const goldTableView = defineCardView({
	card: "GoldTable",
	fromBook: [
		"meta",
		"goldDrafts",
		"goldDraftVersion",
		"goldAuditText",
		"busy",
		"postAction",
		"fetchText",
		"onSuggestWords",
	],
	required: ["meta", "goldDraftVersion", "postAction", "fetchText", "onSuggestWords"],
	defaults: {},
	// 这张卡同样没有需要现算的表达式：`onSuggestWords` 那个动作信封（`uiCallable`、capture 守卫）
	// 留在壳里——`src/ui/` 跨域协作只走 public exports（AGENTS.md「Frontend layout」），不把它拖进来。
	derive: () => ({}),
});

export function GoldTable(props) {
	const {
		meta,
		goldDrafts,
		goldDraftVersion,
		goldAuditText,
		busy,
		postAction,
		fetchText,
		onSuggestWords,
	} = props;
	// 这一稿的检查记录原文：**随 payload 下发**，不再由本卡去读。
	// ⚠️ 原先这里是挂载 effect 里的一次 `fetchText('工作区/audit-NN.md')`——那条路走
	// `/textbook/file`，而该路由只放行 `productOpenMode === 'preview'` 的产物，`工作区/audit-NN.md`
	// 被判 `'machine'` ⇒ **每次必然 403**，`.catch` 把它记成 `null`，卡于是永远停在展示期、
	// 两颗键永远灰、**刷新无效**（票 `gold-finalize-blocked/01` 的病因，2026-02-11 真机实撞）。
	// 现在它和知识地图／章节安排同一条路（`/textbook/events` 的 `goldAudit`）。
	// 三态口径一个字不改：`undefined`＝还没读到、`null`＝没有／读不到、字符串＝读到了。
	const auditText = goldAuditText;
	const [texts, setTexts] = useState({});
	const [view, setView] = useState({ tab: goldDraftVersion, mode: "read" });
	const [loadError, setLoadError] = useState(null);
	const opinions = meta.goldOpinions ?? [];
	const goldNo = goldChapterNo(meta);
	// 当前稿路径（票 `depth-review-2026-10/05`：构造只此一份，住在 `domain-rules.chapterRel`；
	// 此前这里内联一份模板，与客户端另外三处各拼各的）。⚠️ `工作区/audit-NN.md` 那一行**还没有**
	// 收编（它是 `audit` 族的契约，不是本章正文的形状），两行别看成同一件事。
	const currentPath = chapterRel(goldNo);
	const pathOf = (version) =>
		version === goldDraftVersion
			? currentPath
			: ((goldDrafts ?? []).find((d) => d.version === version)?.path ?? null);
	const load = (path) => {
		if (texts[path] !== undefined) return;
		fetchText(path)
			.then((t) => setTexts((prev) => ({ ...prev, [path]: t })))
			.catch((err) =>
				setLoadError(String(err instanceof Error ? err.message : err)),
			);
	};
	useEffect(() => {
		load(currentPath);
		// ⚠️ 这里**原先还有一次** `fetchText('工作区/audit-NN.md')`（把结果写进 `setAuditText`）——
		// 那正是票 `gold-finalize-blocked/01` 的病因那一步：该路径被判 `'machine'`，
		// `/textbook/file` 对它必然 403，于是这次读取**每次都失败**（不是缓存、刷新没用），
		// 检查记录被记成「没有」⇒ 卡永远停在展示期。现在它随 payload 来（见函数头 `goldAuditText`），
		// 本卡不再自己去读机器产物。
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	// 展示稿：当前稿或旧稿
	const showTab = Math.min(view.tab, goldDraftVersion);
	const showPath = pathOf(showTab);
	// 换稿也要**加载**（2026-09-23 代码审查补）：原来只有挂载时加载当前稿（上面那个 effect 的
	// `load(currentPath)`）与对比态加载对照稿（下面那个 effect），谁都没加载"切过去的那一稿"——
	// 于是点「第 N 稿」切到旧稿后 `showText` 恒为 `undefined`，正文永远停在「加载中…」。
	// spec §3 转场矩阵的 `E 焦点区·「现在」 × 页内换内容` 格（「点 `第 N 稿` → 正文换成那一稿」）
	// 此前只有渲染级覆盖（只断稿页签在不在），这条漏网正是"渲染级冒充点击级"的典型。
	useEffect(() => {
		if (showPath !== null) load(showPath);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [showPath]);
	const showText = showPath === null ? null : (texts[showPath] ?? null);
	// 对比对象：当前稿比上一稿；旧稿比它的下一稿
	const compareWith =
		view.mode === "compare"
			? showTab === goldDraftVersion
				? showTab - 1
				: showTab + 1
			: null;
	const comparePath = compareWith !== null ? pathOf(compareWith) : null;
	useEffect(() => {
		if (comparePath !== null) load(comparePath);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [comparePath]);
	const compareText =
		comparePath === null ? null : (texts[comparePath] ?? null);
	// 票 gold-revision-flow/02：徽章取词走那个纯函数（三态如实说，缺文件不说「已附」）。
	const auditBadge = auditBadgeText(auditText);
	// 票 walkthrough-2026-10/04（裁决甲）：展示期那两件事取一次、共用一处判据——
	// `draftLanded`（这一稿在不在盘上）既喂展示期那句，也喂意见单那条标签（B6）；
	// ⚠️ 只看**当前稿**这一格（`currentPath`），不看用户翻到的旧稿页签。
	const draftLanded = goldDraftLanded(texts[currentPath]);
	const displayPeriod = goldDisplayPeriod({ draftText: texts[currentPath], auditText });
	const addOpinion = (kind, wish, para, hint) => {
		void postAction({
			action: "gold-opinion",
			kind,
			wish,
			...(para !== null ? { para } : {}),
			...(hint ? { hint } : {}),
		});
	};
	const tabBtn = (v) =>
		createElement(
			"button",
			{
				key: v,
				style: S.projectBtn(view.tab === v),
				onClick: () => setView({ tab: v, mode: "read" }),
			},
			`第 ${v} 稿${v === goldDraftVersion ? "（最新）" : ""}`,
		);
	return createElement(
		"div",
		{ style: S.focus },
		createElement(
			"div",
			{
				style: {
					display: "flex",
					gap: "8px",
					alignItems: "center",
					flexWrap: "wrap",
					marginBottom: "6px",
				},
			},
			createElement(
				"strong",
				{ style: { fontSize: "14px" } },
				"🤝 最佳范例章 · 一起定风格",
			),
			createElement(
				"span",
				{ style: { fontSize: "12px", opacity: 0.8 } },
				auditBadge,
			),
		),
		// 票 walkthrough-2026-10/04（裁决甲）：展示期那句**明确状态**——提前展示是有意的，
		// 但屏上得说清「这一稿此刻不能定稿」。它是**不占三词名额的 fact line**（状态词那一半
		// 由状态条／活性行出「我正在做」，见 `view-rules.goldDraftDisplayed`）。
		displayPeriod !== null
			? createElement(
					"p",
					{
						style: {
							margin: "0 0 6px",
							padding: "4px 8px",
							background: "var(--dsw-alias-bg-layer-1)",
							borderRadius: "8px",
							border: "1px solid var(--dsw-alias-border-l2)",
							fontSize: "12px",
						},
					},
					displayPeriod.factLine,
				)
			: null,
		goldDraftVersion > 1
			? createElement(
					"div",
					{
						style: {
							display: "flex",
							gap: "6px",
							flexWrap: "wrap",
							marginBottom: "6px",
						},
					},
					Array.from({ length: goldDraftVersion }, (_, i) => tabBtn(i + 1)),
					showTab === goldDraftVersion
						? createElement(
								"button",
								{
									style: S.smallLink,
									onClick: () =>
										setView({
											tab: showTab,
											mode: view.mode === "compare" ? "read" : "compare",
										}),
								},
								view.mode === "compare"
									? "只看这一稿"
									: `和第 ${goldDraftVersion - 1} 稿对比`,
							)
						: createElement(
								"button",
								{
									style: S.smallLink,
									onClick: () =>
										setView({
											tab: showTab,
											mode: view.mode === "compare" ? "read" : "compare",
										}),
								},
								view.mode === "compare"
									? "只看这一稿"
									: `和第 ${showTab + 1} 稿对比`,
							),
				)
			: null,
		loadError !== null
			? createElement("p", { style: S.error }, `稿子打开失败：${loadError}`)
			: null,
		createElement(
			"div",
			{ style: { margin: "6px 0" } },
			showText === null
				? createElement("p", { style: S.hint }, "加载中…")
				: view.mode === "compare" && compareText !== null
					? createElement(
							"div",
							null,
							createElement(
								"p",
								{ style: S.hint },
								"想在这一稿上继续挑毛病？点「只看这一稿」。",
							),
							createElement(GoldCompare, {
								oldText: showTab === goldDraftVersion ? compareText : showText,
								newText: showTab === goldDraftVersion ? showText : compareText,
								opinions,
							}),
						)
					: createElement(GoldReader, {
							text: showText,
							opinions,
							busy,
							onOpinion: addOpinion,
							onRevokeOpinion: (id) => {
								void postAction({ action: "gold-opinion-revoke", id });
							},
							readOnly: showTab !== goldDraftVersion,
						}),
			showTab !== goldDraftVersion && view.mode === "read"
				? createElement(
						"p",
						{ style: { fontSize: "12px", opacity: 0.7, margin: "4px 0" } },
						// 票 10（判定四①）：与上面「想在这一稿上继续挑毛病？点『只看这一稿』」是同一件事
						// 的两种说法（一条讲怎么改、一条讲为什么不能改），收敛成这一句——它信息量大
						// （说清了"旧稿只能回顾"这个原因）。两处不会同屏（mode 互斥），故只留一份字。
						"这是旧稿，只能回顾；要挑毛病请回到「最新」那稿。",
					)
				: null,
		),
		createElement(GoldOpinionList, {
			opinions,
			busy,
			// 票 walkthrough-2026-10/04（B6）：标签与提示吃的是**同一件事实**（这一稿在不在盘上）
			draftLanded,
			// 票 gold-display-period/01＋02：展示期**两件事共用这一位**——① `pending > 0` 时
			// 提示那一句必须说话（`DISPLAY_PERIOD_PENDING_HINT`）；②「让 AI 照这些改」那颗键禁用。
			displayPeriod,
			onRevoke: (id) => {
				void postAction({ action: "gold-opinion-revoke", id });
			},
			onRevise: () => {
				void postAction({ action: "gold-revise" });
			},
		}),
		createElement(GoldFinalize, {
			meta,
			opinions,
			busy,
			// 票 walkthrough-2026-10/04（裁决甲）：展示期里定稿那颗键的能力（禁用＋理由），
			// 由卡算好递进来——`GoldFinalize` 自己不去读检查记录（它没有那条通道）。
			displayPeriod,
			onApprove: (approved, targetWords) => {
				void postAction({ action: "gold-approve", approved, targetWords });
			},
			onSuggestWords,
			onWriteTargets: (targets) =>
				postAction({ action: "gold-target-words-set", targets }),
		}),
	);
}
