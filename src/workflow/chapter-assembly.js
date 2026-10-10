/**
 * 章正文（`工作区/chapter-NN.md`）的**机器拼装** —— 机器是章正文的唯一写者
 * （票 `.scratch/walkthrough-2026-10/issues/02` · 2026-10-06 裁决）。
 *
 * ## 病与它治的方式（这一段就是本模块的边界，别在别处另写一句）
 *
 * 2026-10-03 真机走查 A10：主笔把一章**拆两半派**给两个执笔小助手，两个写者写**同一个**
 * `工作区/chapter-08.md`——零互斥、零合并，谁后落盘谁说了算（后半段那位报「已落盘、前半段未改动
 * 一字」的时间**早于**前半段报「已落盘 455 行」；若前半段用整文件覆盖写，后半段当场丢字）。
 * 盘上那次没丢，兜住它的是**主 AI 事后自己读全章补齐**，不是任何机制。
 *
 * 裁决否掉了两条：**(a) 把 `CONTEXT.md:465` 那条领域不变量降成愿望**（不许）；
 * **「加一把锁」**（仓里没有可加的锁，加也锁不住别人的写工具——`src/**` 里
 * `mutex|lockfile|atomicWrite|O_EXCL` 零命中，`src/ui/rules.js` 逐字写着宿主没给
 * 「哪个小助手在写哪一章」的逐个归属）。⇒ **换协议**：子助手**只落分片**
 * （`工作区/分片/chapter-NN-MM.md`，一路一个号），`工作区/chapter-NN.md` **由机器拼**。
 * 先例＝ADR-0030 决策 2／4 的「机器 100% 保真拼 `book.md`」与票 12／17 的两份派生件。
 *
 * ## 它做什么／不做什么
 *
 * - **做**：把某一章的几片分片按**分片号升序**首尾相接，拼成一份章正文，并在
 *   `工作区/chapter-NN.md` **与拼装件不一致时**写下去（一致时**一个字节都不动**——见下）。
 * - **不做**：不改分片内容（拼装是**搬运**，不是编辑）、不出裁决（章正文是自由文本，机器不往里加东西）、
 *   也不替任何人**决定一章拆几路**（几路＝盘上有几片，主笔派工时说了算）。
 *
 * ## 为什么「一致时不重写」是承重的一格
 *
 * `工作区/chapter-NN.md` 的 mtime 是**票 22 那道闸**的输入（「正文比检查记录新时过目被拦」）。
 * 交工那一刻无条件重写会把 mtime 推后，于是**每一章的检查记录都当场变成「审的是旧稿」**、
 * 过目闸门永远拦人。同输入同输出（不读时钟、不写随机数）＋ 逐字比对后再决定写不写，
 * 这两件合起来才让「机器是唯一写者」与「审过就是审过」同时成立。
 *
 * ## 这一层只断接线与形状（判据声称的强度＝实现强度）
 *
 * {@link judgeChapterAssembly} 断的是「盘上那份章正文是不是这几片分片的拼装件」：分片非空、
 * 分片号从 `01` 起连续、逐字等于拼装件。它**不证**分片内容对不对、也**不证**两个写者有没有被
 * 派到同一个分片号上（见下面那条边界）——那两层归真机层与派工纪律。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
	chapterRel,
	CHAPTER_SHARD_DIR_REL,
	chapterShardName,
	parseChapterShardName,
} from '../domain-rules.js'
import { chapterShardDir, workDir } from './engine/paths.js'

// ── 拼装口径（生产落盘与判据核对走同一段：两处不会各写一套说法）──────────────────

/**
 * 分片之间的**接缝**。
 *
 * ⚠️ 这是**拼装契约的一半**（改它＝改章正文字节，`renderChapter` 的确定性判据也跟着变）：
 * 一片分片自己该以换行结尾（模板里写了），这里再补一个 `\n` 只是**兜住没写尾换行的那一片**
 * （少了它两片会被粘成一行，正文里凭空多出一个错词）。**不 trim、不归一空白**：
 * 机器只搬运，一个字都不改分片的内容。
 */
const SEAM = '\n'

/**
 * 盘上一章的全部分片（**按分片号升序**，只认 `工作区/分片/chapter-NN-MM.md` 这个形状）。
 *
 * ⚠️ **我的枚举面比现实窄在哪里**（票 `dev-gate-scan/17` 的纪律）：这里只读**一个目录的一层**
 * （`工作区/分片/`），并且只认 {@link parseChapterShardName} 认得出来的名字。现实比它大：
 * 子目录里的分片、以及正则压根匹配不上的名字（`chapter-01-02.md.txt`、`chapter-01-02.md.bak`、
 * 分隔符或序号位写错的 `chapter_0102.md`）都**看不见**——它们既不会被拼进正文，也不会被这里
 * 点名。`shardShapeProblems` 的「缺号」判据只覆盖「该有的号不见了」，覆盖不了
 * 「有人把分片写在别的名字上」。
 *
 * ⚠️ **反过来，识别面在「补零位数」这一维上比产出面**宽**（2026-10-06 code-review 规范轴 N6 订正）**：
 * `parseChapterShardName` 的两个序号位是 `\d+`（一位以上），不是「恰好两位」——
 * **写者少补一个零（`chapter-2-1.md`）照样被认出来、被拼进正文**，而不是静默判成
 * 「一片分片都没有」（见 `domain-rules.js` 那个函数的注记，那里写着「宽一格」是**有意**的：
 * 宁可认下、也别把写者的东西静默丢掉）。这条口径的**后果**必须一起记住：
 * `chapter-02-01.md` 与 `chapter-2-1.md` 解出**同一个** `{n, m}`，于是一章可能被数成两片
 * （同一片内容在正文里出现两遍），而 `shardShapeProblems` 的连续性判据用的是 **`m` 的集合**，
 * 它**看不见这种重号**。挡它的是派工纪律「一路一个号」与模板里的两位补零契约
 * （补零位数的字面量断言在 `test-artifact-path.mjs`），不在这条判据的射程内。
 *
 * @param {string} projectId
 * @param {number} n 章号（1 起）
 * @returns {ReadonlyArray<{m: number, name: string, rel: string, text: string, blank: boolean}>}
 */
export function readChapterShards(projectId, n) {
	const dir = chapterShardDir(projectId)
	let names = []
	try {
		names = readdirSync(dir)
	} catch {
		// 目录不在 ⇒ 这一章一片分片都没有。⚠️ `chapterShardDir` 是**纯解析**（不建目录）：
		// 读一件事实不许有副作用——本仓已经栽过一次「读的动作把空目录建出来、把老目录遮住」
		// （票 `context-budget/13` 的实测），这条纪律对新建的那一段同样适用。
		return []
	}
	const out = []
	for (const name of names) {
		const parsed = parseChapterShardName(name)
		if (parsed === null || parsed.n !== Number(n)) continue
		let text = ''
		try {
			text = readFileSync(join(dir, name), 'utf8')
		} catch {
			text = ''
		}
		out.push({
			m: parsed.m,
			name,
			rel: `${CHAPTER_SHARD_DIR_REL}/${name}`,
			text,
			blank: text.trim() === '',
		})
	}
	return out.sort((left, right) => left.m - right.m)
}

/**
 * 分片的形状问题（空数组＝能拼）。逐条点名**是第几片**（拼不出来时主笔要知道去补哪一片）。
 *
 * ⚠️ **「从 01 起连续」是本模块最承重的一条**：少了 `-01` 而 `-02` 在，机器会把后半章当成整章
 * 拼出去——「内容丢了一半而没人知道」正是本票要治的那件事的另一种写法。所以缺号**逐号点名**，
 * 且**不拼**（`assembleChapter` 拿它当拒收理由）。
 *
 * @param {ReadonlyArray<{m: number, rel: string, blank: boolean}>} shards
 * @param {number} n 章号（1 起，只为把话说全）
 * @returns {string[]}
 */
export function shardShapeProblems(shards, n) {
	const problems = []
	const list = Array.isArray(shards) ? shards : []
	if (list.length === 0) {
		problems.push(`第 ${n} 章一片分片都没有：正文只能由机器从分片拼出来——写作小助手只落 ${CHAPTER_SHARD_DIR_REL}/${chapterShardName(n, 1)} 这样的分片（一路一片），机器才拼 ${chapterRel(n)}`)
		return problems
	}
	for (const shard of list) {
		if (shard.blank === true) problems.push(`第 ${n} 章的分片是空的：${shard.rel} —— 空片拼进正文等于少一段（先让它写满再交工）`)
	}
	// 分片号必须从 01 起连续：缺号 = 那一路的东西不在正文里，静默拼出去就是丢字。
	const present = new Set(list.map((shard) => shard.m))
	const missing = []
	for (let m = 1; m <= Math.max(...list.map((shard) => shard.m)); m += 1) if (!present.has(m)) missing.push(m)
	if (missing.length > 0) {
		problems.push(`第 ${n} 章的分片号不连续：缺 ${missing.map((m) => String(m).padStart(2, '0')).join('、')}（分片号从 01 起一路排下来，缺哪一号就是那一路的东西没进正文）`)
	}
	return problems
}

/**
 * 几片分片 → 「应该是那样」的章正文（**生产落盘与判据核对共用这一段**）。
 *
 * @param {ReadonlyArray<{text: string}>} shards 按分片号升序
 * @returns {string}
 */
export function renderChapter(shards) {
	return (Array.isArray(shards) ? shards : []).map((shard) => String(shard?.text ?? '')).join(SEAM)
}

// ── 判据（那把尺子；坏形状喂进**同一段**它，不另写一份「相似的量法」）──────────────

/**
 * 判盘上那份章正文是不是**这几片分片的拼装件**。返回问题清单，空数组＝站得住。
 *
 * 三档输入语义（这是判据的全部）：
 * - `text === null`：**机器还没拼过**（那一章还没交工）⇒ 不是问题，机器马上会拼；
 * - `text` 与拼装件**逐字相同** ⇒ 机器写的/与机器写的一样 ⇒ 没问题（幂等，mtime 也不动）；
 * - `text` 与拼装件**不同** ⇒ **机器之外有人在写这份文件**——这就是「同一文件多写者」那一格的形状
 *   （两个写者先后落盘：后写者的整份正文把先写者的盖掉了，盘上那一份既不等于那几片分片，
 *   也没人知道少了哪一半）。判据点名它，**不静默覆盖**。
 *
 * ⚠️ **扫面非空下限**（防空跑）：零片时「盘上那份等于拼装件」这句话恒真，所以先断「至少有一片」；
 * 反证正是把这个形状喂回**这一段**。
 *
 * @param {string|null} text 盘上 `工作区/chapter-NN.md` 的全文（不在传 `null`）
 * @param {ReadonlyArray<{m: number, rel: string, text: string, blank: boolean}>} shards
 * @param {number} n 章号（1 起）
 * @returns {string[]} 逐条点名的问题
 * ⚠️ **「点出丢了哪一片」这句话的强度＝它做到的强度**（2026-10-06 code-review 规范轴 N10 订正）：
 * 它逐个点名的是「**非空、且整片正文在盘上那一份里找不到**」的那些片的**路径**
 * （`工作区/分片/chapter-NN-MM.md`——编号由基名带出，不另印一句「第几片」）。它**看不见**三件事：
 *   ① **空片**（`blank`）被过滤掉，不点名；
 *   ② 只丢了**一段**的片——判据用的是 `got.includes(shard.text)` 这个**整片子串**判定，
 *      盘上那份若含这片的一部分，这片就不算「没了」（「丢了一半而没人知道」的另一种写法）；
 *   ③ 一片都没被认出来时（`lost` 为空），那句话只说「不一致」，**不说丢的是哪一片**。
 * 这三条是**已知的窄**，不是它保证的东西；要收紧就得改判据本体并补反证（本票不改行为）。
 */
export function judgeChapterAssembly(text, shards, n) {
	const list = Array.isArray(shards) ? shards : []
	const problems = shardShapeProblems(list, n)
	if (problems.length > 0) return problems
	if (text === null || text === undefined) return []
	const want = renderChapter(list)
	if (String(text) === want) return []
	const got = String(text)
	// 逐片点名：哪几片的正文**没在**盘上那一份里（这正是「后写者把先写者盖掉」能看见的那一半）。
	const lost = list.filter((shard) => shard.text.trim() !== '' && !got.includes(shard.text))
	const detail = lost.length > 0
		? `：${lost.map((shard) => shard.rel).join('、')} 的内容不在盘上那一份里`
		: ''
	return [
		`第 ${n} 章的 ${chapterRel(n)} 与分片拼装件不一致${detail} —— 机器之外有人在写这份文件（同一文件多写者）；`
		+ `正文只能由机器从 ${list.length} 片分片拼（机器不覆盖它，免得把谁的整份手写稿当成正文）：`
		+ `先让机器重拼（chapter-assemble）再交工`,
	]
}

// ── 盘上那一半：机器拼（写）与交工那一刻的验货（读＋必要时写）─────────────────────

/**
 * 拼装的**唯一实现**（两个出口各传一种态度，见下两段）。
 *
 * ⚠️ **为什么是「一个实现 ＋ 一个开关」，不是「拼」与「验」各写一套**（2026-10-06 code-review
 * 规范轴 N9：中间人／臆测通用性的气味，结论是**保留开关并写明理由**）：
 * 两个出口**九成是同一条路**——读分片、查形状、按号拼、与盘上那份**逐字比**、决定写不写。
 * 真正不同的只有**一条**：盘上那份不是拼装件时，是「覆盖」（拼这一步的职责就是拼）
 * 还是「拒收」（验货这一步的职责就是拦人）。把这九成抽成两个函数，就多出两处会各自漂的
 * 「一致时一个字节都不写」「形状坏了两种态度都拒收」——而这两条正是本模块最承重的两格
 * （前者是票 22 新鲜度闸门的输入，后者是「丢了半章而没人知道」的兜底）。
 * ⇒ 开关只允许影响**那一条**，语义由这个参数名直说（`tolerateExternalWrite`＝「容忍盘上那份
 * 是别人写的」），调用点只有 {@link assembleChapter} 与 {@link verifyChapterAtSubmit} 两处。
 *
 * @param {string} projectId
 * @param {number} n 章号（1 起）
 * @param {{tolerateExternalWrite: boolean}} options
 *   `true`＝这是**「机器拼」那一步**本身（`chapter-assemble`）：盘上那份若不是拼装件，**机器覆盖它**
 *   （这一步的职责就是拼，它不验收），并如实回报 `overwroteExternalWrite`；
 *   `false`＝这是**交工验货**：盘上那份若不是拼装件，**拒收、不覆盖**（见 {@link judgeChapterAssembly}）。
 * @returns {{status: 'ok'|'none'|'blocked', problems: string[], wrote: boolean, overwroteExternalWrite: boolean, rel: string, shards: number}}
 */
function assembleCore(projectId, n, { tolerateExternalWrite }) {
	const shards = readChapterShards(projectId, n)
	const rel = chapterRel(n)
	const base = { rel, shards: shards.length, wrote: false, overwroteExternalWrite: false }
	// ① 分片本身的形状（零片、空片、缺号）：两种态度都拒收——拼不出来就是拼不出来。
	const shape = shardShapeProblems(shards, n)
	if (shape.length > 0) {
		return { ...base, status: shards.length === 0 ? 'none' : 'blocked', problems: shape }
	}
	const want = renderChapter(shards)
	const path = join(workDir(projectId), ...rel.split('/').slice(1))
	const existing = existsSync(path) ? readFileSync(path, 'utf8') : null
	// ② 一致 ⇒ **一个字节都不动**（mtime 是票 22 那道闸的输入，见文件头那一节）。
	if (existing === want) return { ...base, status: 'ok', problems: [] }
	if (existing !== null && !tolerateExternalWrite) {
		// ③ 交工验货：盘上那份**不是机器写的** ⇒ 拒收（不覆盖，免得把谁的整份手写稿当成正文收下）。
		return { ...base, status: 'blocked', problems: judgeChapterAssembly(existing, shards, n) }
	}
	writeFileSync(path, want, 'utf8')
	return {
		...base,
		status: 'ok',
		problems: [],
		wrote: true,
		// 只有「盘上原本有一份、而它不是拼装件」才算「覆盖了机器之外的一次写入」。
		overwroteExternalWrite: existing !== null && existing !== want,
	}
}

/**
 * **机器拼章正文**那一步（`workbench_act(action=chapter-assemble, chapter=N)`）：
 * 按分片拼、写 `工作区/chapter-NN.md`；盘上那份若不是拼装件就**覆盖它**（并在返回值里说出来）。
 *
 * ⚠️ 它**不验收**：验收在交工那一刻（{@link verifyChapterAtSubmit}）。两步分开的理由是——
 * 写作小助手落完分片之后、审计小助手读正文之前，必须先有这一份**机器拼出来的**正文
 * （审计读的就是它，票 22 的新鲜度闸门比对的就是它的 mtime）。而「盘上那份是不是拼装件」
 * 只有交工那一刻才该拦人：拼这一步的职责是把正文做出来，不是拒绝交工。
 *
 * @param {string} projectId
 * @param {number} n 章号（1 起）
 */
export function assembleChapter(projectId, n) {
	return assembleCore(projectId, n, { tolerateExternalWrite: true })
}

/**
 * **交工那一刻**的验货（`stage-submit(chapters|gold)` 唯一的那一格）：盘上那份章正文必须是
 * 这几片分片的拼装件；机器还没拼过（文件不在）时就**由机器补拼**（机器仍是唯一写者）。
 *
 * @param {string} projectId
 * @param {number} n 章号（1 起）
 */
export function verifyChapterAtSubmit(projectId, n) {
	return assembleCore(projectId, n, { tolerateExternalWrite: false })
}

/**
 * 交工/拼装失败时的**唯一报错文案**（动作层两处共用这一段：不会各写一套说法）。
 *
 * @param {{status: string, problems: string[], rel: string}} assembled
 * @param {number} n 章号（1 起）
 * @returns {string}
 */
export function chapterAssemblyReject(assembled, n) {
	return `${assembled.problems.join('；')}（第 ${n} 章 · ${assembled.rel}）`
}

/**
 * 交工/深改要归档的**这一章盘上真有的那些分片**（书夹相对路径，按分片号升序）。
 *
 * ⚠️ **深改归档必须带上它们**（票 11 的同一条教训）：分片是章正文的**输入**，定点修改到本章时
 * 只归档正文、把分片留在原地，重做那一路写的若是**另一片**，旧内容会被机器拼回正文里
 * ——旧稿回来了，而账上什么都没说。
 *
 * @param {string} projectId
 * @param {number} n 章号（1 起）
 * @returns {string[]}
 */
export function chapterShardRelsOnDisk(projectId, n) {
	return readChapterShards(projectId, n).map((shard) => shard.rel)
}
