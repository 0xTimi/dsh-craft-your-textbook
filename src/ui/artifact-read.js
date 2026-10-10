/**
 * 产物读取拥有者（票 `workbench-card-contract/03`）
 *
 * `/textbook/file`（读产物正文）与 `/textbook/download`（附件下载）的**地址骨架与身份编码只此一份**。
 * 收编前同一件事有三份各拼各的实现：`ui/chapters-map.js`、`client-entry.js`、`ui/confirm-cards.js`
 * ——收编后调用点**只给 `rel`**，不再自己拼地址，也不再手工穿 `project` / `session` 两个身份 prop。
 *
 * ## 继承的不变量（只编码，不重决）
 *
 * 1. **这条通道是被正式保留的，不是待删的重复实现。** `.scratch/dsh-file-preview/spec.md` 目标形态第 6 条：
 *    私有 `/textbook/file` **保留但按「给人读的产物」收窄**；同一条 spec 第 30-32 行定死「卡片上属于造书
 *    自己业务操作的文本**不动**」，并逐个列名：谈判桌分段批注 / 谈判桌逐段对比 / 探查确认卡顶部报告 /
 *    章节卡内联展开。**收编前的三个调用点恰好逐个落在那份例外清单上**——它们不是重复实现的污点。
 *    ⚠️ 同一份 spec 第 36 行还写着「整条删掉是后续另一票的事」：那条票若落地，本 module 跟着走。
 * 2. **`readText` 不判断「该不该读」**——那是 `domain-rules.productOpenMode` 的归属（ADR-0010 决策 1/2），
 *    一个字不动。本 module 只负责「给一个 `rel`，把正文取回来」。
 * 3. **`downloadHref` 只共享身份拼装，不共享读取语义**：「导航 vs 读取」是**两件不同的事**，
 *    前者交给浏览器导航（`<a href>`），后者是一次带 `res.ok` 检查的 fetch。⚠️ 这条差别必须留在
 *    interface 上写明——否则日后有人顺手给 download 也补一个 `res.ok` 检查，就给一条纯导航链接
 *    加上了取不到时无处可报的行为。
 *
 * ## 刻意不做的事
 *
 * - **不引入 `capture` / `isCurrent` 守卫。** `client-entry.js:1942-1947` 那段注释是**契约的一部分**：
 *   谈判桌那份正文的读取由卡片自己的挂载 effect 发起，而 StrictMode 的 effect 重放会推进 generation，
 *   让「挂载时 capture 的守卫」当场失效、正文被换成一条错误条。落点是 keyed 壳内的谈判桌卡，
 *   身份一变整棵重挂。**票 05 查过的隔离边界，不是待办**——把它当 bug 修掉就是行为变更。
 * - **不吞错误、不决定错误怎么显示。** 本 module 只 `reject`；吞还是显示归调用方，且现存**两种正当策略
 *   必须逐字保留**（见调用点注释）。收敛时把它们一起搬过来，否则后来者会「顺手统一」成一条——
 *   那是产品决定的收窄，不是重构。
 *
 * 依赖分类（DEEPENING.md）：**in-process + 既有 HTTP adapter**。`fetch` 已是本仓全部工作台网络读的
 * 那一个 adapter，本 module 不新开 seam，只把**地址拼装**收进一处。
 *
 * `fetchImpl` 是**本 module 自己的 internal seam**：生产侧永远不传（默认取全局 `fetch`），
 * 只有本 module 的测试用它。不进任何调用方要知道的 interface。
 */

/** 身份段：`session` + `project`。`projectId` 读不到时返回 null，调用方据此不发请求。 */
function identityOf(sessionId, projectId) {
	if (projectId === null || projectId === undefined) return null;
	return `session=${encodeURIComponent(sessionId)}&project=${encodeURIComponent(projectId)}`;
}

/**
 * 建一个产物读取器。
 *
 * @param {object} input
 * @param {string} input.sessionId 会话身份（工作台当前会话）
 * @param {string|null} input.projectId 当前书身份；`null`（无当前书）时**不发请求**
 * @param {Function} [input.fetchImpl] internal seam，生产不传
 * @returns {{ readText(rel: string): Promise<string>, downloadHref(rel: string): string|null }}
 */
export function createArtifactReader({
	sessionId,
	projectId,
	fetchImpl = globalThis.fetch,
}) {
	/** 地址骨架：`/textbook/<route>?session=&project=&path=`。身份读不到时返回 null。 */
	const href = (route, rel) => {
		const identity = identityOf(sessionId, projectId);
		if (identity === null) return null;
		// `path` 一律编码：服务端用 `url.searchParams.get('path')` 读，WHATWG URLSearchParams
		// 自动解码，所以编码与不编码解出来是同一个值（收编前 download 那一路写的是裸 `工作区/book.md`，
		// file 那三路写的是编码值——两套写法对同一份服务端代码都成立）。
		return `/textbook/${route}?${identity}&path=${encodeURIComponent(rel)}`;
	};

	return {
		/**
		 * 读一份产物的正文。
		 *
		 * 非 2xx → `reject(new Error("HTTP <status>"))`（**错误原文是调用点与测试都认的那一句**，
		 * 收编前三条实现逐字相同，不许改写）。网络失败 → 原样 reject。
		 * 「读不到怎么办」不由本函数决定，见文件头「刻意不做的事」。
		 *
		 * @param {string} rel 书文件夹相对路径（形如 `工作区/chapter-01.md`）
		 * @returns {Promise<string>}
		 */
		readText(rel) {
			const url = href("file", rel);
			if (url === null) {
				// 无当前书 ⇒ 不发请求。与收编前两处早退（`project == null` ⇒ 不取）同口径。
				return Promise.reject(new Error("没有当前书，读不了产物"));
			}
			return fetchImpl(url).then((res) => {
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				return res.text();
			});
		},

		/**
		 * 附件下载的地址（给 `<a href>` 用，**不是** fetch——没有 `res.ok`、没有错误条）。
		 *
		 * @param {string} rel 书文件夹相对路径
		 * @returns {string|null} 无当前书时返回 null（调用点据此不渲染那颗下载键）
		 */
		downloadHref(rel) {
			return href("download", rel);
		},
	};
}
