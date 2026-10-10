/**
 * 书夹形状 · 两份表（票 `context-budget/10` · ADR-0031 决策 2–3）
 *
 * ## 这一份是什么
 *
 * 两份表各答一个问题，**合起来才是「这本书的形状」**：
 * · `工作区/产物清单.json` —— **应当有什么**：建档时**探本书形状**生成，**书内只读**；
 * · `过程/登记.json` —— **实际有什么**：机器每次扫盘**写回**。
 *
 * ⚠️ 今天全仓**没有任何「扫盘写登记表」的动作**（唯一的「扫盘→磁盘」是深改存档的
 * `archived`，`deep-modify.js:79-81`）。本模块新建这一个。
 *
 * ## 路径一律经目录解析函数拼
 *
 * 本文件**不手写任何一个 `工作区/…` 或 `过程/…` 字面量**：全部来自 `engine/paths.js`
 * （票面点名的 `workDir()` 与它的同族）。段名常量住在 `domain-rules.js`（两侧都要知道：
 * 后端拼路径、前端按形状分类产物）。
 *
 * ## 边界（本票只断「形状与在不在」）
 *
 * · **缺件**（清单 ∖ 登记）在建书当天本来就是红的——「还没写」是实话，不是缺陷。
 *   「什么时候缺件该拦住」归票 `11`／`12` 的接线。
 * · **多件**（登记 ∖ 清单）**任何时候都是红的**：盘上多了一件清单没声明的产物，
 *   要么是有人加了产物没登记，要么是改名改漏了。这半边今天就能当门禁用。
 * · 「AI 有没有照这些行去读」**不在这里**（真机层，票 `10`／落序 07）。
 *
 * @module workflow/book-shape
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import {
	artifactManifestPath,
	artifactRegistryPath,
	projectDir,
	workDir,
} from './engine/paths.js'
import {
	isSweepExcluded,
	manifestRowsFor,
	normalizeBookRel,
	productOpenMode,
	reconcileManifestRows,
} from '../domain-rules.js'

/**
 * 建档时的形状探针 —— **三个事实**（handoff §4.2）。
 *
 * ⚠️ `route`／`science` **今天只进清单头部**、不改变行集合：这两个探针改变的是
 * **产物内容与注入时机**，不是「盘上多一件」（理由与裁决留给票 `02`，见 ADR-0031 决策 2）。
 * `hasSources` 是今天唯一真的改变行集合的那个：**无源的书不探查**，也就没有探查那一族。
 *
 * @param {object} meta `project.json`
 * @returns {{route: string, science: boolean, hasSources: boolean}}
 */
export function probeBookShape(meta) {
	return {
		route: meta?.route === 'human' ? 'human' : 'blueprint',
		science: meta?.science === true,
		hasSources: Array.isArray(meta?.sources) && meta.sources.length > 0,
	}
}

/**
 * 生成「应当有什么」那份清单（建档时调用一次）。
 *
 * ⚠️ **书内只读**：这里写一次就不再改——状态会过期而清单是静态件，状态走派生
 * （`domain-rules.stageStateOf`）。真要改形状，只能改 `BOOK_PRODUCT_FAMILIES` 再对新书生效。
 *
 * @param {string} projectId
 * @param {object} meta
 * @returns {{shape: object, rows: object[], path: string}}
 */
export function writeArtifactManifest(projectId, meta) {
	const shape = probeBookShape(meta)
	const rows = manifestRowsFor(shape)
	const document = {
		version: 1,
		// 书内只读的两个理由（ADR-0031 决策 2）：书内生成 ⇒ 没有任何一端能改它；
		// 状态会过期 ⇒ 它压根不该装状态。
		book: shape,
		rows,
	}
	const path = artifactManifestPath(projectId)
	writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
	return { shape, rows, path }
}

/** 读清单（读不出返回 `null`——**老书没有这一件，不拦人**）。 */
export function readArtifactManifest(projectId) {
	try {
		const parsed = JSON.parse(readFileSync(artifactManifestPath(projectId), 'utf8'))
		if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.rows)) return null
		return parsed
	} catch {
		return null
	}
}

/** 读登记（读不出返回 `null`——老书同理）。 */
export function readArtifactRegistry(projectId) {
	try {
		const parsed = JSON.parse(readFileSync(artifactRegistryPath(projectId), 'utf8'))
		if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.rows)) return null
		return parsed
	} catch {
		return null
	}
}

/** 递归列出目录下的文件（书夹相对路径，按 `/` 归一；目录本身不存在返回空数组）。 */
function listFilesUnder(root, dir) {
	const out = []
	let entries
	try {
		entries = readdirSync(dir, { withFileTypes: true })
	} catch {
		return out
	}
	for (const entry of entries) {
		if (entry.name.startsWith('.')) continue
		const full = join(dir, entry.name)
		if (entry.isDirectory()) {
			out.push(...listFilesUnder(root, full))
		} else if (entry.isFile()) {
			out.push(relative(root, full).split(sep).join('/'))
		}
	}
	return out
}

/**
 * **扫盘**：工作区里实际有的产物（按路径排序，`productOpenMode` 那一档一并记下）。
 *
 * 扫盘面＝工作区（过程产物）；排除表（`SWEEP_EXCLUDED`）逐条带理由收掉归档旧稿、清单自身、
 * 进度账本。
 *
 * ⚠️ **这一档 `open` 只作记录，不作门禁**（2026-10-04 复核改）。原先「`productOpenMode` 判成
 * `'machine'` 的不进登记」把**两个问题**当成一个：那份判据答的是「怎么给人看」，
 * 扫盘答的是「有没有产物」。连坐的后果是**凡不开预览的产物都进不了登记**，而清单照样声明着它们
 * ⇒ 「前言」「知识地图分片」两族恒缺件（详见 `SWEEP_EXCLUDED` 上方注记）。
 * 现在判据只有一个：**在排除表之外就是产物**；`open` 记下来，供界面取词与将来那本清单用。
 *
 * ⚠️ **行里的路径是书夹相对（带 `工作区/` 前缀）**，不是工作区相对——那是 `productOpenMode`
 * 与清单两边的共同口径。写成工作区相对的话清单会一条都对不上。
 *
 * ⚠️ **行里的路径是「规范形状」，不是「盘上原样」**（老书读侧兜底；票 `context-budget/13`
 * 那一节的取舍已被维护者推翻）：老书扫出来的行带的是老名前缀，登记里逐行过
 * {@link normalizeBookRel} 映成新名，于是**清单（永远是新名）与登记对得上**，
 * 界面那些按路径形状取词的地方（`view-rules` 那一族 `^工作区/…` 正则）一份都不用改。
 * ⚠️ **`stat` 走的是盘上原路径**（`onDisk`）：登记要记的 `bytes`／`modifiedAt` 是**那一份文件**的事实，
 * 拿归一后的路径去 stat 只会全部读不出——读不出就被吞成 `null`，于是登记里凭空多出「大小未知」。
 *
 * @param {string} projectId
 * @returns {object[]} 登记行
 */
export function scanArtifactRegistry(projectId) {
	const root = workDir(projectId)
	if (!existsSync(root)) return []
	const bookRoot = projectDir(projectId)
	const rows = []
	for (const onDisk of listFilesUnder(bookRoot, root)) {
		if (isSweepExcluded(onDisk)) continue
		// ⚠️ 归一发生在「判形状之后、记进行之前」这一步：排除表与预览档位要规范形状，
		// 而 `stat` 要盘上那一条——两件事，一个都不能省（省了哪一个都会静默少一半）。
		const path = normalizeBookRel(onDisk)
		const open = productOpenMode(path)
		let bytes = null
		let modifiedAt = null
		try {
			const stat = statSync(join(bookRoot, ...onDisk.split('/')))
			bytes = stat.size
			modifiedAt = stat.mtimeMs
		} catch {
			// 读不出 stat 就只记「它在」——登记答的是「实际有什么」，不是「多大」。
		}
		rows.push({ path, open, bytes, modifiedAt })
	}
	return rows.sort((left, right) => left.path.localeCompare(right.path))
}

/**
 * **机器每次扫盘写回**登记。
 *
 * ⚠️ 这是全仓**第一个**「扫盘 → 写登记表」的动作（此前唯一的「扫盘→磁盘」是深改存档）。
 * 写盘失败一律吞掉：登记是**派生**的，写不进去不许拖垮交动作本身。
 *
 * ⚠️ **老书不写**（老书读侧兜底的边界）：这本书没有产物清单 ⇒ 对账那一半压根不存在
 * （`bookShapeReport` 返回 `null`，不拦也不显示），写回去的登记**没人读**；
 * 而它要落的 `过程/` 在老书里**压根不存在**——为一个没人读的派生件在用户的老书上新建一层目录，
 * 正是本票要治的那个病（维护者的实测：空的新目录把老目录遮住）。所以先读一次清单，读不出就不写。
 *
 * @param {string} projectId
 * @returns {{scannedAt: number, rows: object[]}|null}
 */
export function refreshArtifactRegistry(projectId) {
	try {
		if (readArtifactManifest(projectId) === null) return null
		const rows = scanArtifactRegistry(projectId)
		const document = { version: 1, scannedAt: Date.now(), rows }
		mkdirSync(workDir(projectId), { recursive: true })
		writeFileSync(artifactRegistryPath(projectId), `${JSON.stringify(document, null, 2)}\n`, 'utf8')
		return document
	} catch {
		return null
	}
}

/**
 * 两份表对账（读侧用的派生视图）。
 *
 * ⚠️ **老书兼容**：没有清单（或清单没有行）时返回 `null` **而不是**一份全红的差集——
 * 「缺这些字段的老书不拦人」（spec 决策 4 / 用户故事 12）。调用方据此不拦、不显示。
 *
 * ⚠️ **老名书夹的 `shape` 恒为 `null`**（票 `context-budget/13` 读侧兜底的**边界**）：
 * 老书是票 `10` 之前建的，没有 `工作区/产物清单.json`（老名那一份盘上也没有）⇒ 读不出 ⇒ `null`。
 * ⚠️ **兼容层不许把它变成一份全红的差集**：读侧兜底只该让老书**看得见自己已有的产物**
 * （扫盘登记那一半照常有行），**不该凭空造出一份「应当有什么」**去对账——造出来的话老书
 * 会第一次见到一份满屏红色的缺件清单，那比「什么都不显示」坏得多（用户故事 4：我的旧书还能照常打开）。
 *
 * @param {string} projectId
 * @returns {{manifestRows: number, registryRows: number, missing: object[], extra: object[]}|null}
 */
export function bookShapeReport(projectId) {
	const manifest = readArtifactManifest(projectId)
	if (manifest === null) return null
	const registry = readArtifactRegistry(projectId)
	const { missing, extra } = reconcileManifestRows(manifest.rows, registry?.rows ?? [])
	return {
		manifestRows: manifest.rows.length,
		registryRows: registry?.rows?.length ?? 0,
		missing,
		extra,
	}
}