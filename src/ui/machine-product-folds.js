/**
 * 造书工作台 · 机器产物的人读折叠（中性模块，票 `depth-review-2026-10/03`）
 *
 * 这个 module 回答一句话：**「那份机器 JSON 长什么样、怎么读？」**
 *
 * ## 它为什么必须中性
 *
 * 零 import——不引 react（不碰渲染）、不引 `view-rules` / `domain-rules`（不认识界面词）、
 * 不认识任何一张卡。形态对标 `card-view.js`（同样是 UI 层的中性零依赖 module）。
 * 理由与那一件同源：它站在**每一处读这份机器产物**的缝上，一旦它认出某张卡或某一个渲染路径，
 * 加卡就得改它，locality 当场退化回一个中央文件。
 *
 * ## 它治的病
 *
 * 住址与消费方分离：`foldKnowledgeMap` / `foldOutline` 原来住在 `chapters-map.js` 尾部，
 * 而**该文件内部零调用**——渲染路径上唯一的消费者是 `phase-page.js` 第 2／第 3 阶段那两块，
 * 外加壳 `client-entry.js` 从那里再导出到插件表面（那只是转发，不算内部调用）。
 * 住址与消费方分离逼出了三处「不许 import，防成环」的注释，而那个环由
 * `phase-page → chapters-map` 这一条边撑着——边一撤，三处的**理由**当场不成立，
 * 留着不改就是「注释与代码相矛盾」，正是这张票点名要治的那类漂移。
 * 更要紧的是**同一份机器 JSON 的形状知识有两个读者**：`chapters-map.js` 一份、
 * `confirm-cards.js` 一份内联 `JSON.parse`（后者那份注释还自称「调前者」，与事实不符——
 * 这类「注释自称而代码没做到」在 `docs/测试信任边界.md` 开头「总纲」有第四例）。
 * 形状知识散在两处 ⇒ 键名改一个就有一处静默失配（JSON 多一个键/少一个键都不会有人响）。
 *
 * ## ⚠️ 「数据同源、措辞各自成篇」是**既有裁决**，本 module 只统一前者
 *
 * 收编的是**形状读取**（哪个键、不是数组就当没有、解析失败返回 `null`），
 * **一个字都不动措辞**。同一份 `knowledge-map.json` 在屏上仍然有两副不同的说法：
 * 本 module 的 `foldKnowledgeMap` 印「📚 章节建议（N 章）」「🎯 知识点清单（N 个）」，
 * 而源探查确认卡印「📚 AI 建议的章节安排（后续可再调）」与它自己那份折叠口。
 * 那是**产品决定**，不是重构遗留：两处服务于两种读法（就地折叠的纯文本清单 vs 一张要拍板的卡），
 * 统一成一句会同时毁掉两处。收编时**不许顺手统一措辞**。
 *
 * ## 解析失败一律 `null`——不许假装读懂了
 *
 * 三份折叠都遵守：读不出来返回 `null`，由调用方决定回退成什么
 * （阶段页回退原样、确认卡不渲染那一块且**不阻断确认流程**）。
 * 「两条错误策略逐字不同」是票 03 收编时留下的裁决，本 module 不收它、也不许把它统一。
 */

// ── 形状读取：工作区/knowledge-map.json ───────────────────────────────────────

/**
 * 把 `工作区/knowledge-map.json` 的原文读成那三份清单。
 *
 * 收编前这里有两份各读各的：`chapters-map.js` 的 `foldKnowledgeMap` 与 `confirm-cards.js`
 * 里那份内联 `JSON.parse`。键名与「不是数组就当没有」这条兜底因此住在两个文件里。
 *
 * @param {string} text `knowledge-map.json` 的原文。
 * @returns {{chapters: object[], kps: object[], materials: object[]}|null}
 *   读不出来（非字符串 / 空串 / 坏 JSON / 字面 `null` / 不是对象）时 `null`。
 */
export function parseKnowledgeMap(text) {
	if (typeof text !== "string" || text === "") return null;
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		return null;
	}
	if (data === null || typeof data !== "object") return null;
	return {
		chapters: Array.isArray(data.chapterSuggestion) ? data.chapterSuggestion : [],
		kps: Array.isArray(data.knowledgePoints) ? data.knowledgePoints : [],
		materials: Array.isArray(data.materials) ? data.materials : [],
	};
}

// ── 折叠：机器产物 → 人读清单（就地折叠，不开右栏）─────────────────────────────

// F38（2026-08-20 走查）：knowledge-map.json 的最小人读折叠——把原始 JSON 的
// 章节建议/知识点清单/材料小节折叠成逐行清单；解析失败或无内容返回 null（回退原样）。
export function foldKnowledgeMap(text) {
	const km = parseKnowledgeMap(text);
	if (km === null) return null;
	const lines = [];
	const { chapters, kps, materials } = km;
	if (chapters.length > 0) {
		lines.push(`📚 章节建议（${chapters.length} 章）`);
		chapters.forEach((chapter, index) => {
			const title = String(chapter?.title ?? "").trim();
			const src = String(chapter?.source ?? "").trim();
			lines.push(`${index + 1}. ${title}${src !== "" ? `　← ${src}` : ""}`);
		});
		lines.push("");
	}
	if (kps.length > 0) {
		lines.push(`🎯 知识点清单（${kps.length} 个）`);
		for (const point of kps) {
			const title = String(point?.title ?? "").trim();
			if (title === "") continue;
			const diff = String(point?.difficulty ?? "").trim();
			const src = String(point?.source ?? "").trim();
			lines.push(
				`· ${title}${diff !== "" ? `（${diff}）` : ""}${src !== "" ? ` ${src}` : ""}`,
			);
		}
		lines.push("");
	}
	if (materials.length > 0) {
		lines.push(`📄 材料小节（${materials.length} 份）`);
		materials.forEach((material, index) => {
			const title = String(material?.title ?? "").trim();
			const sections = Array.isArray(material?.sections)
				? material.sections
						.map((s) => String(s?.title ?? "").trim())
						.filter((t) => t !== "")
				: [];
			lines.push(
				`资料${material?.num ?? index + 1}${title !== "" ? `（${title}）` : ""}：${sections.join(" / ") || "（未读到小节标题）"}`,
			);
		});
		lines.push("");
	}
	if (lines.length === 0) return null;
	return lines.join("\n").replace(/\n+$/, "");
}

/**
 * `工作区/outline.md`（章节安排）的**人读折叠形态**（票 pipeline-wiring-gaps/09）。
 *
 * ⚠️ 这一份与 `foldKnowledgeMap` 同族、同一形状：文件名带 `.md`，**内容是机器 JSON**
 * （`{"chapters":[…]}`，落盘见 `actions/chapters.js` 的 `writeWork(project,'outline.md',…)`
 * 与演示模式的 `engine.js` 那一行），所以 `domain-rules.productOpenMode` 判它 `'inline'`
 * ——不开右栏（与 `工作区/audit-NN.md` 同一条理由）。它与 audit 那一族的分别只在于
 * **有人读**：人读形态是**就地折叠清单**，本函数是它**唯一**的实现
 * （阶段页第 3 阶段的 `OutlineBlock` 调它；拍板前那张 `OutlineConfirmCard` 从 `meta` 直接渲染，
 * 数据与本函数同源、措辞各自成篇）。
 *
 * 解析失败 / 无内容返回 `null`（由调用方回退原文）——**不许假装读懂了**（与 foldKnowledgeMap 同纪律）。
 * @param {string} text `工作区/outline.md` 的原文。
 * @returns {string|null} 人读清单；读不出来时 `null`。
 */
export function foldOutline(text) {
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		return null;
	}
	if (data === null || typeof data !== "object") return null;
	const chapters = Array.isArray(data.chapters) ? data.chapters : [];
	if (chapters.length === 0) return null;
	const lines = [`📐 章节安排（${chapters.length} 章）`];
	chapters.forEach((chapter, index) => {
		const title = String(chapter?.title ?? "").trim();
		lines.push(`${index + 1}. ${title}`);
		const summary = String(chapter?.outline ?? "").trim();
		if (summary !== "") lines.push(`　${summary}`);
		const source = String(chapter?.source ?? "").trim();
		if (source !== "") lines.push(`　源：${source}`);
		const points = (Array.isArray(chapter?.points) ? chapter.points : [])
			.map((pt) => String(pt ?? "").trim())
			.filter((pt) => pt !== "");
		if (points.length > 0) lines.push(`　覆盖知识点 ${points.length} 个：${points.join(" / ")}`);
	});
	return lines.join("\n");
}