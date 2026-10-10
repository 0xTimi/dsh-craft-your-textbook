/**
 * 造书工作台 · **演示通道豁免面的单点声明**（票 `demo-flow-fidelity/08`）。
 *
 * ── 病 ────────────────────────────────────────────────────────────────────────
 * 演示通道与真实通道的分叉有 20 处（逐条见 `.scratch/demo-flow-fidelity/findings.md` §B）。
 * 病不在「有豁免」——病在**豁免散着**：有的写了理由（`chapters.js` 的几处、`engine.js` 的几处、
 * ADR-0008），有的只写在票面，有的**连注释都没有**（gold 干净审计、`audit-skip`、留言销号、
 * `styleCheck` 那几族）。下一批闸门照这个先例写，就会继续在 demo 上悄悄失效。
 * 本文件把那 20 处（＋ 扫描面里多出来的几处）收成**一份**清单，每条四件：
 * `what`＝豁免什么、`why`＝为什么一句话、`origin`＝出处（票号／代码注释）、`guards`＝守卫点。
 *
 * ── ⚠️ 声明面**只是登记，不放行任何东西** ──────────────────────────────────────
 * 豁免的判据仍在**原处**（`meta.demo !== true`／`subMeta.demo !== true`／演示支早退那些守卫）。
 * 本文件不接进任何生产路径、不改任何一条判定的结果（不放宽、不收紧）——它的唯一消费者是
 * `test-demo-exemptions.mjs` 那道双向元检查。
 *
 * ── 落点为什么是**新模块**而不是 `src/domain-rules.js` ──────────────────────────
 * 先核 import 方向：`domain-rules.js` 零 import，`src/workflow/**` 与 `src/workflow/actions/**`
 * 都在 import 它，所以**从成环角度看它完全能承载**这份表。不能承载的是**职责与打包面**：
 * 它文件头自述「前后端共享的领域常量与纯推导函数……只放『两侧都必须知道』的规则」，而它确实
 * 被 esbuild 打进前端 bundle（`src/ui/chapters-map.js`、`src/ui/confirm-cards.js` 直接 import 它）。
 * 这份表的每一条都指向**后端源码的文件路径与代码子串**，前端一个字节都用不上 ⇒ 放进去等于把
 * 后端守卫的源码片段塞进浏览器产物，并让那句自述失真。
 * ⚠️ **票 06 起有一个例外方向**：`quality-checks-tail` 那条多了一个机器可读字段 `checkNames`
 * （那段检查的项名名单——票 06 收口起是 `engine.js` 那几处 `checks.push({ name })` 的
 * **服务端 `name` 逐字**），而**那份名单常量住在 `src/domain-rules.js`**（前端那句提示句也要读它，
 * 并在上屏前逐项过 `checkHuman`）——
 * 本表**引用**它，不把它抄进来。「表不进前端」这条纪律因此一个字没松：前端读的是
 * `domain-rules` 里那份纯名单，`src/ui/**` 一个字节都不 import 本文件。
 * 本模块**只 import 那一份纯名单**（票 06），其余是纯数据：`src/workflow/**`、
 * `src/workflow/actions/**` 与判据都能 import 它而不引入环（`domain-rules.js` 自己零 import，
 * 方向仍是**向下**的）。
 *
 * ── 守卫点为什么写 `{ file, contains }` 而不是「文件:行号」 ─────────────────────
 * 行号会漂。今天写死的 `chapters.js:923` 在下一票插几行注释之后就指向别处，而元检查只会
 * 「在那一行找到了一个 demo 字面量」——一条**会腐烂的判据输入**：它看起来在守着某个具体守卫，
 * 实际守的是那一行的偶然内容。`{ file, contains }` 要求给出**该守卫的代码子串**（可以跨行），
 * 元检查按文件读文本找 `contains`；行号漂了它照样命中，守卫被改写成别的样子它当场红。
 * 代价：`contains` 必须自己足够特有（同一个文件里五处同形的 `if (meta?.demo !== true) {`
 * 就得把下一行一起写进来），所以下面的片段有的跨两行——这是这个偏离的成本，写在票面 `## Answer` 里。
 *
 * ── ⚠️ 声明面是**一份会被别人扫的文本**（票 08 合入集成分支后整链红的那一课） ────────
 * 它住在 `src/` 下 ⇒ 任何「读 `src/**` 文本再匹配」的判据都把它当输入面。已经在真链上炸过一次、
 * 另有两条**静默**通道（下面第二个 anchor 那种：让一个已被删掉的真实锚点照样「命中」＝假绿）：
 *   · `appendEvent` ＋ 左括号 ⇒ `test-ledger-artifact-fields.mjs` 把那一行当成一处**落账调用点**
 *     做闭包对账 ⇒ 未登记即红（票 08 合入后整链红的就是这三处）；
 *   · `ensureStatus(` ＋ 一个 `'awaiting-…'` 字面量（或 `status =` ＋ 同一个东西）⇒
 *     `test-gate-write-points.mjs` 的写入点扫描把它当成一处「workflow 能设这个值」的**写入点**
 *     ⇒ 真写入点哪天被删，闭包仍绿（本票登记的**假绿**通道，也是这格连注释一起判的原因）；
 *   · 删除原语、状态写入的底层标识符、词表声明、手抄章节路径同理（各有一条判据在扫 `src/**`）。
 * ⇒ **写 `contains` 时从锚点的第二个 token 起**（`'textbook/phase-start', …`、
 * `'awaiting-final-approval', …`），别整行照抄调用表达式。常驻闸（锚点清单 ＋ 反证 ＋ 核过哪些
 * 扫描面）在 `test-demo-exemptions.mjs` 的「声明面是文本」那一格——**加了新 `contains` 之后跑它**。
 *
 * ── ⚠️ 我的枚举面比现实窄在哪里（票 `dev-gate-scan/17` 的纪律） ─────────────────
 * ① 元检查那一侧的 grep 面是**五个字面量写法**（`DEMO_GUARD_LITERALS`），它咬得住的是
 *    「新写了一处这五种写法的守卫却没登记」。**咬不住**的是间接判断：`runtime.demo`
 *    （`content-lib.js` 那条 seam）、把 `demo` 传进别处再判、`goldN(meta)` 那类派生、
 *    以及任何换成别的变量名／别种写法的等价判断——那些今天不在 grep 面内，将来把判据改成
 *    AST 扫描是**升级**，不是本票。
 * ② `contains` 匹配是**原文子串**（去 `\r` 后逐字），不认同义的改写：守卫被重写成
 *    `meta && meta.demo` 这种形状、片段对不上，元检查报的是「声明的守卫点找不到」——
 *    那是**要人来看一眼**的红，不是自动修的红。这正是拆成两向判据的理由（见测试文件头）。
 * ③ 这里登记的是**源码里的分叉**，不是「演示书在盘上实际发生了什么」：行为面由
 *    `test-flow-transitions-matrix.mjs`（票 `test-chain-latency/04` 之前是 `test-flow-transitions.mjs`）、
 *    `test-collab-replay.mjs` 那一族管。
 * ④ ⚠️ 与票 07 的分工：影子对账的**期望值从生产函数派生**（`exploreDepthTier` 等），
 *    这份声明面**只用来排除**（「这处差异是登记过的豁免」），**绝不**当成判据的唯一期望值来源
 *    ——两张票别打架。
 * ⑤ ⚠️ 票 06 给 `quality-checks-tail` 补的 `checkNames` 是**说明文字的数据源，不是判据**：
 *    元检查那四件（`what`/`why`/`origin`/`guards`）一个字没动，`checkNames` 的内容与现实
 *    （`engine.js` 里那几处演示守卫**各推一项**）**没有任何机器闸门**——`engine.js` 多推一项、
 *    这里不补，两边都不响；前端那句提示就跟着少说一项。那正是本文件头部第 ① 条那个窄处的
 *    另一面：**从源导出只保证不抄漏，不保证看到的比现实多**（票 `dev-gate-scan/17`）。
 *    真正被判据钉住的只有：这句提示**上了屏**（演示 payload）与**真书那一侧一个字都没有**。
 *
 * 术语见 `CONTEXT.md`；豁免的账见 `docs/测试信任边界.md` 与 ADR-0008。
 */
import { QUALITY_CHECKS_TAIL_NAMES } from './domain-rules.js'

/**
 * **grep 面**：五条 demo 守卫的字面量写法（票面点名的那五个）。
 *
 * 元检查拿它扫 `src/**`（逐行、跳过注释行），任何一处命中都必须被下面某条声明的 `guards`
 * 覆盖；反过来，这条面上的每个字面量都必须在 `src/**` 里**真的有命中**（空名单当场红）。
 */
export const DEMO_GUARD_LITERALS = [
	'meta?.demo !== true',
	'meta.demo !== true',
	'subMeta.demo !== true',
	'state.demo === true',
	'meta.demo === true',
];

/**
 * 演示通道豁免面的声明清单。
 *
 * 每条：
 * · `id`        —— 稳定 id（元检查按它报红，别改名玩）
 * · `what`      —— 豁免什么（一处分叉的用户可见／机器可见后果）
 * · `why`       —— 为什么（一句话：那条理由本身）
 * · `origin`    —— 出处（票号／代码注释；findings §B 的编号也写在这里）
 * · `guards`    —— 守卫点：`{ file, contains }`（守卫所在的文件 ＋ 该守卫的代码子串）
 * · `guardKind` —— `'demo-guard'`＝守卫本身就是一条 demo 判据（五字面量之一）；
 *                  `'structural'`＝豁免靠结构性事实（演示支早退／演示通道永不交工），
 *                  声明的守卫点是**那道门本身**（它没被放宽，只是演示通道走不到它）
 * · `state`     —— 省略＝还活着；`'closed'`＝这条分叉已被别的票关掉（配 `closedBy`）
 */
export const DEMO_EXEMPTIONS = [
	{
		id: 'content-source-seam',
		what: '内容验证入口（`stage-submit` 逐阶段验货的那一条链）',
		why: '演示通道的内容来自内置回放夹具（`generateContent`），一步都不进 `stage-submit`——验货入口在它身上没有入口点。',
		origin: 'findings §B #1；`src/workflow/engine.js` 的 `demoStep`／`projectRuntime` 自述',
		guardKind: 'demo-guard',
		guards: [
			{ file: 'src/workflow/engine.js', contains: 'demo: meta.demo === true,\n    dir: projectDir(projectId),' },
			{ file: 'src/workflow/engine.js', contains: "const result = await generateContent(runtime, 'explore')" },
		],
	},
	{
		id: 'explore-required-items',
		what: '探查必做项（三／五节）与 `chapterSuggestion` 章数区间这两道 400',
		why: '演示书的 `explore.md` 由夹具写、从不经 `stage-submit(explore)`，那两道门读不到它（夹具报告确实缺那三节）。',
		origin: 'findings §B #2；票 `pipeline-wiring-gaps/07`',
		guardKind: 'structural',
		guards: [
			{ file: 'src/workflow/engine.js', contains: 'const missingItems = exploreTier.required.filter((item) => !exploreText.includes(item))' },
			{ file: 'src/workflow/actions/chapters.js', contains: 'if (chapterSuggestion.length < CHAPTER_SUGGESTION_MIN || chapterSuggestion.length > CHAPTER_SUGGESTION_MAX) {' },
		],
	},
	{
		id: 'explore-artifact-shards',
		what: '源探查就绪判据里「每份转换完成的材料各有一片知识地图分片 ＋ 各一份精读细目」那两条（置态、放行、交工验货三处共用同一份判据）',
		why: '演示通道没有「精读小助手」这回事——分片与细目在那条路上**没有来源**（结构性到不了，不是没做完）；演示书那一段的产物只有 `explore.md` 与机器拼的合并件两件。票 `premature-announce/01` 起，这两条与另外两处**共用同一份判据**，所以演示分叉落在判据里那一行，而不是原来那两条 400。',
		origin: '票 `premature-announce/01`（前身：findings §B #3；票 `context-budget/11` · ADR-0030 决策 13 那两条 400）',
		guardKind: 'demo-guard',
		guards: [
			{ file: 'src/workflow/engine.js', contains: 'const demoBook = !atSubmit && state.demo === true' },
		],
	},
	{
		id: 'final-approve-hard-checks',
		what: '交付放行（`final-approve`）那一刻**当场重算**硬检查那一道闸',
		why: '演示通道的 `awaiting-final-approval` 由 `engine.js` 的演示支直接置下、**有意不判检查结果**（它跑的是内置回放夹具，硬检查里那几项在它身上没有来源）⇒ 放行那一刻重算只会把演示书自己拦住。真书一律当场重算。',
		origin: '票 `premature-announce/01`；与 `quality-checks-tail` 那条豁免同源（演示通道到不了那几项检查）',
		guardKind: 'demo-guard',
		guards: [
			{ file: 'src/workflow/actions/gates.js', contains: 'if (meta?.demo !== true) {' },
		],
	},
	{
		id: 'demo-chapter-skeleton-fixed',
		what: '章节建议的章数区间 `CHAPTER_SUGGESTION_MIN..MAX`（4–10 章）不约束演示通道——演示书的章级骨架**固定 3 章**',
		why: '演示书走旧全自动通道：章节安排（`demoOutline`）与 `knowledgeMap.chapterSuggestion` 都由夹具写、从不经 `stage-submit(explore)` 那两道 400。3 章**低于下限 4 是有意为之**（票 01 Q2＝乙：维持 3 章骨架）——抬到 4 章会让 `test-flow-transitions-matrix.mjs`（票 `test-chain-latency/04` 之前是 `test-flow-transitions.mjs`）那 6 路口矩阵的多条断言算术跟着变，那是另一件事。',
		origin: '票 `demo-flow-fidelity/02`（要做的第 3 条）＋ 票 01 Q2＝乙；骨架被判据钉住在 `test-flow-transitions-matrix.mjs` 的 `check(chapterCount === 3, …)` 那一格（票面出处写 `:936`，08 合入 t02 后实际落 `:971`；票 `test-chain-latency/04` 拆开之后它住在 `-matrix` 那一半——⚠️ 行号会漂，故按本文件纪律**不把行号写进守卫点**，以那句子串为准）',
		guardKind: 'structural',
		// 两个守卫点各说这半句话的一半，缺一个都说不全：
		//   ① 骨架本身是**写死的单点**（票 02 新收的口径出口，`DEMO_CHAPTER_COUNT` 由它派生）
		//      ——「固定 3 章」这一半；
		//   ② 那条区间门**仍在原处、没被放宽**，只是演示通道走不到它（与 `explore-required-items`
		//      共用同一处守卫点：那条登记的是「explore 交工的两道 400 演示通道不触发」这一族，
		//      这条登记的是「3 章因此是合法的」——同一个门、两句不同的陈述）。
		guards: [
			{ file: 'src/content-lib.js', contains: 'export const DEMO_CHAPTER_COUNT = DEMO_CHAPTERS.length;' },
			{ file: 'src/workflow/actions/chapters.js', contains: 'if (chapterSuggestion.length < CHAPTER_SUGGESTION_MIN || chapterSuggestion.length > CHAPTER_SUGGESTION_MAX) {' },
		],
	},
	{
		id: 'explore-shards-and-readings',
		what: '分片（知识地图每源一片）与精读细目两份在场验货',
		why: '演示通道一个分片、一份细目都不产（`knowledge-map.json` 由引擎一步写好）。⚠️ 票 `premature-announce/01` 起，这两条不再只是「它不交工所以触发不到」——它们与置态、放行两处共用同一份就绪判据，所以判据里补了一条显式的 demo 分叉（见 `explore-artifact-shards`）；本条留作那两条**要求本身**的出处登记。',
		origin: 'findings §B #3；票 `context-budget/11`（ADR-0030 决策 13）；搬进判据：票 `premature-announce/01`',
		guardKind: 'structural',
		guards: [
			{ file: 'src/workflow/engine.js', contains: 'const shardMissing = okNumbers' },
			{ file: 'src/workflow/engine.js', contains: 'const detailMissing = okNumbers' },
		],
	},
	{
		id: 'knowledge-coverage-gate',
		what: '知识点覆盖闸门（`knowledgePoints` ↔ `chapters[].points` 互查，失配即 400）',
		why: '演示书的 `outline` 由引擎直接写、不过 `stage-submit(outline)`，覆盖闸门在它身上没有入口点。',
		origin: 'findings §B #4（半——票 `pipeline-wiring-gaps/12` 票面写了「没动 demo 通道」）',
		guardKind: 'structural',
		guards: [
			{ file: 'src/workflow/actions/chapters.js', contains: 'if (okMaterialNumbers(outlineMeta?.sources).length > 0) {' },
		],
	},
	{
		id: 'material-standing',
		what: '材料分量声明 `materials[].standing` 的 G1／G3／G4 三条验货',
		why: '演示书只有 1 份转换完成的源 ⇒ 按 G2 单源豁免本就不要求 standing（夹具 `materials` 只有 `{num,sections}` 也照旧）——按同一份 `okMaterialShards` 它就是「轻量档、三项必做」，**不是**零源那一档。',
		origin: 'findings §B #5 ＋ §C10；`standingGate` 的 G2 注释与票 `pipeline-wiring-gaps/17`',
		guardKind: 'structural',
		guards: [
			{ file: 'src/domain-rules.js', contains: 'if (count >= 2) {' },
			{ file: 'src/domain-rules.js', contains: '// G1（含 G2 豁免）：≥2 份转换完成的源 ⇒ 逐源都要有一份非空 standing。' },
		],
	},
	{
		id: 'gold-style-spec-sections',
		what: '`style-spec.md` 五节标题在场软验（含「多源同级声明」那一项）',
		why: '演示书的占位 `style-spec.md` 没有节标题，且它不交工——这一格在演示通道里结构上不触发。',
		origin: 'findings §B #6（有：`chapters.js:829-830` 注释 ＋ 票 26）',
		guardKind: 'demo-guard',
		guards: [
			{ file: 'src/workflow/actions/chapters.js', contains: 'if (subMeta.demo !== true) {\n            const spec = readFileSync(workFile(project, \'style-spec.md\'), \'utf8\')' },
		],
	},
	{
		id: 'gold-clean-audit',
		what: '范例章的干净审计 `checkGoldAudit`（5 份必读逐字 quote ＋ `passed`）',
		why: '演示书的范例章正文与审计都由机器写，没有真小助手可审计（夹具自陈「演示章未做真实审计」）。',
		origin: 'findings §B #7（无——相邻注释只说「真实模式」）',
		guardKind: 'demo-guard',
		guards: [
			{ file: 'src/workflow/actions/chapters.js', contains: 'if (subMeta.demo !== true) {\n            const auditText = readFileSync(workFile(project, auditName), \'utf8\')' },
		],
	},
	{
		id: 'chapter-level-inspection-family',
		what: '章级验货族：正文拼装件一致性、审计 `passed`、脚手架残留＋练习答案、抽查意见、范例章拼装件',
		why: '演示通道不派真小助手 ⇒ 没有分片可拼、没有审计件、没有抽查意见，这一族在它身上无对象。',
		origin: 'findings §B #8（半：拼装＋脚手架那两格明写为有意，`audit-skip` 与抽查意见那一支原本无注释）',
		guardKind: 'demo-guard',
		guards: [
			{ file: 'src/workflow/actions/chapters.js', contains: 'if (subMeta.demo !== true) {\n            const assembled = verifyChapterAtSubmit(project, gN)' },
			{ file: 'src/workflow/actions/chapters.js', contains: 'if (subMeta.demo !== true) {\n            const assembled = verifyChapterAtSubmit(project, n)' },
			{ file: 'src/workflow/actions/chapters.js', contains: "if (subMeta.demo !== true && !waived(project, 'audit-skip')) {" },
			{ file: 'src/workflow/actions/chapters.js', contains: 'if (subMeta.demo !== true) {\n            const chapterText = readFileSync(chapterPath, \'utf8\')' },
		],
	},
	{
		id: 'merge-cross-audit',
		what: '合并前跨章审计 `工作区/audit-cross.md` 的四项核对',
		why: '演示通道不派跨章审计小助手；演示支的合并由机器直接拼装。',
		origin: 'findings §B #9（有）；票 `context-budget/05`（ADR-0030 决策 2）',
		guardKind: 'demo-guard',
		guards: [
			{ file: 'src/workflow/actions/chapters.js', contains: "if (subMeta.demo !== true) {\n            const crossPath = workFile(project, 'audit-cross.md')" },
		],
	},
	{
		id: 'final-gate-family',
		what: '终检族：留言销号、`工作区/progress.md`、五份分查报告、`styleCheck` 处置契约',
		why: '演示通道没有用户留言、没有真小助手写的进度账本与分报告，这四道的对象都不存在。',
		origin: 'findings §B #10（有）；票 `context-budget/11` ⑤ 明写「demo 不因缺五份被拒」',
		guardKind: 'demo-guard',
		guards: [
			{ file: 'src/workflow/actions/chapters.js', contains: 'if (subMeta.demo !== true) {\n            const pendingIv = (subMeta.pendingInterventions ?? []).filter((i) => i.status === \'pending\')' },
			{ file: 'src/workflow/actions/chapters.js', contains: "if (subMeta.demo !== true && !waived(project, 'progress-skip') && !existsSync(workFile(project, 'progress.md'))) {" },
			{ file: 'src/workflow/actions/chapters.js', contains: 'if (subMeta.demo !== true) {\n            const reportMissing = FINAL_AUDIT_SCOPES' },
			{ file: 'src/workflow/actions/chapters.js', contains: 'if (subMeta.demo !== true) {\n            const active = (subMeta.styleNotes ?? []).filter((n) => n.status === \'active\')' },
		],
	},
	{
		id: 'quality-checks-tail',
		// 票 `demo-flow-fidelity/06`：`what` 与下面的 `checkNames` 都从**同一个数组**拼出来
		// （`src/domain-rules.js` 的 `QUALITY_CHECKS_TAIL_NAMES`），前端那句提示句
		// （`src/ui/view-rules.js` 的 `demoQualityChecksNote()`）用的也是它——三处一个引用，
		// 谁也别再抄一份。⚠️ 票 06 收口（2026-10-08）：那个数组装的是 `engine.js` 那几处
		// `checks.push({ name })` 的**服务端 `name` 逐字**（9 处），所以 `what` 这句里会出现
		// 机器名——这是**对的**：本声明面只给判据读、不上屏（判定线：机器检查 `name` 不改，
		// 翻译发生在界面出口，那句提示句逐项过 `checkHuman`）。
		// ⚠️ `checkNames` **不是判据**（窄处见文件头 ⑤）。
		what: `\`runQualityChecks\` 后半 ${QUALITY_CHECKS_TAIL_NAMES.length} 项（${QUALITY_CHECKS_TAIL_NAMES.join('、')}）`,
		checkNames: QUALITY_CHECKS_TAIL_NAMES,
		why: '演示通道不派真小助手、不花模型额度，这些项的输入（风格线、进度账本、style-spec 清单）在演示书里没有来源。',
		origin: 'findings §B #11（半——ADR-0008 与 `engine.js` 有口径，四处守卫本身原本无注释）；清单见 `.scratch/pipeline-wiring-gaps/verification.md`；机器可读的 `checkNames` 由票 `demo-flow-fidelity/06` 补（同一批项名还给前端那句提示句用）',
		guardKind: 'demo-guard',
		guards: [
			{ file: 'src/workflow/engine.js', contains: 'if (meta?.demo !== true) {\n    const activeStyles = (meta.styleNotes ?? []).filter((n) => n.status === \'active\')' },
			{ file: 'src/workflow/engine.js', contains: "if (meta?.demo !== true) {\n    const progressWaived = waived(projectId, 'progress-skip')" },
			{ file: 'src/workflow/engine.js', contains: "if (meta?.demo !== true) {\n    const spec = existsSync(workFile(projectId, 'style-spec.md')) ? readWork(projectId, 'style-spec.md') : ''" },
			{ file: 'src/workflow/engine.js', contains: 'if (meta?.demo !== true) {\n    const chapters = meta?.outline?.chapters ?? []' },
			{ file: 'src/workflow/engine.js', contains: 'if (meta?.demo !== true) {\n    // ① 章名全书唯一：直接读大纲的章名，不经正文' },
		],
	},
	{
		id: 'chapter-pipeline-ledger',
		what: '`meta.chapterPipeline`（每章流水线阶段）落账',
		why: '演示通道不上报 `progress`，这一段没有内容可记。',
		origin: 'findings §B #12（有）；`engine.js` 的 `progress` 落账口径',
		guardKind: 'demo-guard',
		guards: [
			{ file: 'src/workflow/actions/chapters.js', contains: 'if (state.demo === true) return\n          const pipeline = Array.isArray(state.chapterPipeline) ? state.chapterPipeline.slice() : []' },
		],
	},
	{
		id: 'deep-modify',
		what: '定点修改／深改',
		why: '演示书走旧全自动通道，没有可回退重做的真实段。',
		origin: 'findings §B #13（有：`deep-modify.js:53` 注释）',
		guardKind: 'demo-guard',
		guards: [
			{ file: 'src/workflow/actions/deep-modify.js', contains: "if (meta.demo === true) { return reject(409, '演示书不支持定点修改') }" },
			{ file: 'src/workflow.js', contains: 'seg.canDeepModify = affected !== null && meta?.demo !== true' },
			{ file: 'src/workflow/actions/deep-modify.js', contains: 'if (meta.demo !== true) {\n        try { wakeMainAI(ctx, project) } catch { /* 唤醒失败不阻塞深改 */ }' },
		],
	},
	{
		id: 'startup-recovery',
		what: '启动续跑与老书过程记录回填',
		why: '演示书重启后不该自动接着跑（那会凭空烧掉一轮演示），也没有老账本要回填。',
		origin: 'findings §B #14（半——测试写明，产品代码那两行原本无注释）',
		guardKind: 'demo-guard',
		guards: [
			{ file: 'src/workflow.js', contains: "if (meta === null || meta.demo === true) continue\n      if (meta.status === 'running') {" },
			{ file: 'src/workflow.js', contains: 'if (meta === null || meta.demo === true) continue\n      const logPath = processLogPath(id)' },
		],
	},
	{
		id: 'review-drive',
		what: '过目态提意见时的驱动（`handoff()` 不补 kick ⇒ 演示书停在 `running/pendingStage`）',
		why: '票 05 修（把 `chapters.js` 的交办换成 `handoffAndDrive()`）；**本分支尚未落地**——t08 上那行还是 `handoff()`，所以这条分叉此刻还活着，本票只按票面口径登记为「已关闭」。',
		origin: 'findings §B #15（无）；票 05（`.scratch/demo-flow-fidelity/issues/05-过目态提意见不补-kick.md`）',
		guardKind: 'structural',
		state: 'closed',
		closedBy: '票 05（过目态提意见不补 kick）',
		// ⚠️ 守卫点**刻意不钉在 `chapters.js` 那行 `handoff()` 上**：那正是票 05 要改的行，
		// 钉上去等于给票 05 埋一颗必然踩到的红。这里钉的是修好之后仍然存在的**补驱动 seam**。
		guards: [
			{ file: 'src/workflow/engine.js', contains: 'function handoffAndDrive(ctx, projectId, stage, gate = null, snapshotReason = null, options = {}) {' },
		],
	},
	{
		id: 'demo-self-drive',
		what: '交办后唤醒主 AI（演示书没有主 AI 可唤醒 ⇒ 改补一次 `kick`）',
		why: '`wakeMainAI` 对演示书恒 false，不补 kick 则 `pendingStage` 挂着没人推；副作用是确认闸门放行后多一条 `stage-start`／`pendingStage` 残留。',
		origin: 'findings §B #16 ＋ §A；`engine.js` 的 `handoffAndDrive` 函数文档',
		guardKind: 'demo-guard',
		guards: [
			{ file: 'src/workflow/engine.js', contains: 'if (meta === null || meta.demo === true) return false\n  const sessionId = meta.session' },
			{ file: 'src/workflow/engine.js', contains: 'if (woke === false && meta !== null && meta.demo === true) void kick(ctx, projectId)' },
			{ file: 'src/workflow/actions/gold.js', contains: 'else { void kick(ctx, project); if (meta.demo === true) void kick(ctx, project) }' },
		],
	},
	{
		id: 'dead-condition-and-stale-doc',
		what: '真实支里那条恒真的 demo 判据（死条件），以及它上方那句过期文档',
		why: '它在 `if (meta.demo)` 早退**之后**的真实支里 ⇒ 恒真、无害；同一处函数文档还写着演示支「＋ 交付」，而它实际停在 `awaiting-final-approval`（交付在 `gates.js` 的认可动作里）。**本票只登记、有意不修**（改它属别的边界）。',
		origin: 'findings §B #17（无——文档与代码不一致）',
		guardKind: 'demo-guard',
		guards: [
			{ file: 'src/workflow/engine.js', contains: "if (meta.status !== 'awaiting-chapters-review' && meta.chaptersReviewed !== true && meta.demo !== true) {" },
			// ⚠️ 同上：从 `'awaiting-final-approval'` 起，**不**带上 `ensureStatus(`——
			// 合起来就是一个「workflow 能设这个值」的写入点形状（`test-gate-write-points.mjs` 的
			// `scanAwaitingSetPoints` 会把它算成声明面里的一处写入点 ⇒ 真写入点被删也照样绿）。
			{ file: 'src/workflow/engine.js', contains: "'awaiting-final-approval', FINAL_CHECK_DONE_HINT)" },
		],
	},
	{
		id: 'final-acceptance-card',
		what: '终检认可卡的内容（自查报告全文 ＋ 14 项 ＋ 汇总件指针）',
		why: '演示通道不产 `textbook/ai-report`，认可卡上只有机器质量门那几项。',
		origin: 'findings §B #18（半——`engine.js` 函数文档一句）；票 `context-budget/12` ⑦',
		guardKind: 'structural',
		guards: [
			// ⚠️ 片段**刻意从 `appendEvent` 的第一个实参起**——不整行照抄那处调用：
			// 声明面是 `src/**` 下的一份**文本**，`test-ledger-artifact-fields.mjs` 的
			// `findAppendEventCalls` 把「`appendEvent` ＋ 左括号」当落账调用点做闭包对账
			// （票 08 合入后整链红的就是这一处）。同族锚点的**常驻闸**在 `test-demo-exemptions.mjs`。
			{ file: 'src/workflow/engine.js', contains: "{ label: '最后检查（质量门）', outcome: 'ok', ...artifactDataForStage('final') }" },
		],
	},
	{
		id: 'book-shape-reconcile',
		what: '书夹形状对账（产物清单 ↔ 扫盘登记，缺件清单）',
		why: '`demo-run` 不写产物清单 ⇒ `shape` 恒 `null`、不显缺件；而 `book-create(demo:true)` 会写 ⇒ 那种演示书永远缺 `细目/`、`报告/`、`分片/`、`preface.md`。',
		origin: 'findings §B #20（无——`manifestRowsFor`／`bookShapeReport` 没有 demo 口径）',
		guardKind: 'structural',
		guards: [
			{ file: 'src/workflow/actions/patterns-ops.js', contains: "case 'demo-run': {" },
			{ file: 'src/workflow/actions/books.js', contains: 'writeArtifactManifest(id, meta)' },
			{ file: 'src/workflow/book-shape.js', contains: 'if (readArtifactManifest(projectId) === null) return null' },
		],
	},
	{
		id: 'phase1-no-real-conversion',
		what: '阶段一的真实转换（MinerU 那一步）',
		why: '演示书的源是一条**占位**（盘上没有 `sources/`）——真跑一次转换要 MinerU Token、要时间、还要处理失败态与重试，与「不花模型额度、几步走完」的入口语义冲突；所以阶段一在演示书里是「已完成」的**展示态**，不是「没做」。',
		origin: '票 01 Q4（2026-10-07 裁决：维持 `demo-run` 伪造「材料准备已完成」这一态）；理由正文在 `patterns-ops.js` 的 `case \'demo-run\'` 旁',
		guardKind: 'structural',
		guards: [
			// ⚠️ 同上：片段从 `appendEvent` 的实参起，目的一样（别把落账调用点抄进声明面）。
			{ file: 'src/workflow/actions/patterns-ops.js', contains: "'textbook/phase-start', { phase: 1, label: PHASE_LABELS[1] })" },
			{ file: 'src/workflow/actions/patterns-ops.js', contains: "'textbook/phase-end', { phase: 1, label: PHASE_LABELS[1] })" },
		],
	},
	{
		id: 'waiver-mechanism',
		what: '用户豁免口（`waive`：`audit-skip`／`progress-skip`／`scaffold-keep`／`other`／`gold-skip`）在演示书里不生效',
		why: '演示通道不派真小助手，没有「以用户说明为准」的对象，`waived()` 对演示书恒 false。',
		origin: '`engine.js` 的 `waived()` 注释「真实模式 ＋ userNote 非空才算数」；ADR-0008',
		guardKind: 'demo-guard',
		guards: [
			{ file: 'src/workflow/engine.js', contains: "if (meta === null || meta.demo === true) return false\n  return (meta.waivers ?? []).some((w) => w.item === item && typeof w.userNote === 'string' && w.userNote.trim() !== '')" },
		],
	},
	{
		id: 'demo-error-status',
		what: '出错后的状态归属（`error` 而不是 `needs-config`）',
		why: '演示通道出错是流程 bug 或环境问题（可直接重试）；真实模式的子助手失败多半是 LLM 未配置／欠费，才要配置引导。',
		origin: '`engine.js` 的 `recordAgentError` 注释',
		guardKind: 'demo-guard',
		guards: [
			{ file: 'src/workflow/engine.js', contains: "meta.status = meta.demo === true ? 'error' : 'needs-config'" },
		],
	},
	{
		id: 'gold-chapter-opinions',
		what: '全章过目段的段落意见（带 `chapter` 的 `gold-opinion` 落 `pendingReviews`）',
		why: '这一支只对真实模式生效；演示书的段落意见走 `goldOpinions` 老链路。',
		origin: '`gold.js` 的注释（F39，2026-08-20 走查）——⚠️ findings §B 那 20 条**没有收录它**（它的理由注释本来就写着，属「有」），但它落在五字面量扫描面里，故一并登记：本票的枚举面比 findings §B 宽。',
		guardKind: 'demo-guard',
		guards: [
			{ file: 'src/workflow/actions/gold.js', contains: 'if (meta.demo !== true && meta.phase === 5 && chapter !== null && chapter <= chapters.length) {' },
		],
	},
];
