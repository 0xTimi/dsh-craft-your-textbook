/**
 * 动作族模块（架构评审候选 3，2026-09-01 拆分）：actCollabSignals
 * 从 src/workflow.js 平移（架构评审候选 3，2026-09-01）。
 *
 * ⚠️ 票 `workflow-seams/03`：interface 已收窄成**一个请求对象**
 * （`{ ctx, action, sessionId, project, body }`）并返回 `{status, json}`——
 * `_req` 与 `res` 两个传输参数都已从 interface 上消失（`res` 由 `handleAction` 那一次
 * `sendJson` 写出，落盘边界随它）。
 *
 * ⚠️ **本文件不许删、不许合、不许改名**：动作族 id ≡ 本文件名这一点被
 * `test-contract-action-catalog.mjs` 从**源码文本**锚定（它正则抠 `workflow.js` 的
 * `HANDLER_OF_FAMILY` 字面量表并要求 handler 绑定名匹配 `act[A-Z]\w*`）；
 * 另有 `test-context-vocabulary.mjs` 把「探查」钉在 `gates.js`、
 * `test-gate-write-points.mjs` 点名读本目录下的族文件。
 * ⇒ 改完之后本文件会变得**近乎空壳**——**那是承重件不是忘了删**。
 * 共享工具来自 ../engine.js。
 */
import {
  assertSessionOwned,
  WAIVER_ITEMS,
  updateMeta,
  appendEvent,
  updateStyleLineMirror,
  // ⚠️ 票 `premature-announce/01`：这个函数从本文件**搬进 engine**（暂停与「重做/归档前」两处共用，
  // 生产者仍只有这里那一处消费点，契约登记面跟着搬到 engine）。
  countRunningSubagents,
} from '../engine.js'
// payload 字段词汇层（票 `deep-module-scan/18` 层一）：只管「怎么读一个字段」＋具名上限。
// ⚠️ `textField`（严格 typeof）与 `textFieldRaw`（不裁空白）**不是**同一件事的两种写法，
//   合并会静默改行为——搬动时按原表达式选函数。
import {
  textField,
  textFieldRaw,
  STYLE_NOTE_TEXT_MAX,
  INTERVENE_TEXT_MAX,
  INTERVENE_TARGET_MAX,
  WAIVER_NOTE_MAX,
  PAUSE_REASON_MAX,
} from './payload-fields.js'
import { familyOf, reject, accept } from '../action-runner.js'
// 宿主 `jobs` 契约面的**单点**（票 `chapter-audit-orchestration/04` 收口）：形状的唯一出处是随代码
// 入库的快照 `docs/reference/dsh-cordis/jobs-后台作业契约摘录.md`，本文件与测试探针
// （`workbench-fake-host.mjs` 的 `makeJobsProbe`）共用这一份词表，谁也不手抄第二份。
import { JOB_RUNNING_STATUS } from '../jobs-contract.js'


// ⚠️ 票 `premature-announce/01`：`countRunningSubagents` 已**搬进 `../engine.js`**（暂停与
// 「重做/归档前」两处共用同一份实现，⛔ 不在这里留第二份）。形状与「数不出来记 null 不记 0」的
// 纪律随它一起搬走，注释也只在那一处。


/** 暂停时停掉**这本书 owner 名下在跑的编排脚本**（票 `chapter-audit-orchestration/04`）。
 *
 *  病：宿主**没有**会话级 paused 状态，工作台的暂停从前只 cancel 主笔那一回合，
 *  而编排脚本跑在后台 job 里——于是「界面说已暂停、书还在长」。本函数补上那条 kill 路径。
 *
 *  **为什么由工作台来 kill（owner fence 够得到）**：形状与语义的出处是随代码入库的快照
 *  `docs/reference/dsh-cordis/jobs-后台作业契约摘录.md` §2b（owner fence 是**纯参数比对**：
 *  `owner === caller` 才放行；id 可预测 ⇒ 它是 **authorization, not secrecy**）。
 *  实现行号（本机 dsh 0.2.0-rc.2，升级后按快照复核）：`dsh-jobs-local/lib/index.js:565-567` 的
 *  `assertAccess` 与 `:493-495` 的 `list(caller)` 是同一条口径；`caller` 就是一个会话 id 字符串，
 *  注册表不看它是谁递进来的。而 job 的 owner 是 `parent.id`＝主笔所在会话的 session id
 *  （`dsh-tool-workflow/lib/index.js:223-226`），与工作台 HTTP 动作体里那个 `session` 是同一个
 *  ⇒ 把 `sessionId` 当 `caller` 递进去即可穿过 fence，**不必**从主笔那一侧发起。
 *  ⚠️ 这条 fence 的真实约束不是技术边界而是**授权边界**：本函数只该在
 *  `assertSessionOwned(project, sessionId)`（本文件 pause 分支第一行）之后调用——那才是
 *  「只能停自己那本书」的依据，`jobs` 那一层只是第二道同义校验。
 *
 *  ⚠️ **写直接成员访问 `ctx.jobs.*`，不写 `ctx.get('jobs')`**：本文件已登记在宿主契约闸门的
 *  `dynamicHostEntries` 里（`dev/host-contract-gate/catalog/web-chat.js`）而动态读登记表为空，
 *  多一条 `ctx.get(...)` 会当场判红 `unregistered-dynamic-host-read`——而红点会出现在离这里
 *  很远的一条断言上（「四类契约走同一个 seam」那条）。
 *
 *  **只 kill 三种条件同时成立的那些**（逐条都有契约依据）：
 *  ① `job.owner === sessionId`——`list(caller)` 也返回 **unowned** job（快照 §2b：
 *     「不带 owner 的 job，任何 caller 都看得见」），不归这本书的一律不碰；
 *  ② `job.kind === 'workflow'`——`JobView.kind` 的声明类型是**开字符串**（快照 §3），
 *     `workflow` 这一枚由 `dsh-tool-workflow` 合并进 `JobKindMap`（`dsh-tool-workflow/lib/types/index.d.ts:16-20`）；
 *     只认字面量，别指望类型系统；
 *  ③ `job.status === JOB_RUNNING_STATUS`——取值域是那五枚闭集（快照 §1），「在跑」只指 `running`；
 *     `stopping` 是**取消已经发出、等结算**，再 kill 一次只会把同一个取消请求重复计一遍
 *     （`killJob` 只挡终态，`dsh-jobs-local/lib/index.js:611-622`），所以这里不碰它、也不把它算进返回值。
 *     ⚠️ 状态词表**只此一处**：`JOB_STATUS_VALUES` / `JOB_RUNNING_STATUS` 都从
 *     `src/workflow/jobs-contract.js` 来，本文件与测试探针共用那一份（票 `chapter-audit-orchestration/04`
 *     收口前这里是注释里手抄的一张枚举表）。
 *
 *  ⚠️ **kill 不同步变终态**：`jobs.kill` 只把状态推到 `'stopping'` 并返回 `'requested'`
 *  （快照 §1 与 §4；实现 `dsh-jobs-local/lib/index.js:611-622`），终态 `'killed'` 要等 producer 的
 *  `done` 落定（`dsh-tool-workflow/lib/index.js:237-252`）。⇒ 调用方/判据**不许** kill 完立刻断言
 *  「不跑了」，要么 `jobs.wait(id, timeoutMs, caller)`（注意它要求正数毫秒，
 *  `dsh-jobs-local/lib/index.js:624`），要么轮询到 `status !== 'running'`。
 *  返回值只数真发出取消请求的（`requested`，见 `JOB_KILL_RESULTS`）；
 *  竞态里已经自己结算的那个返回 `already-finished`，不计。
 *
 *  数不出来 / 停不下来时返回 `null`（「不知道」，不是 0）——与 `countRunningSubagents` 同一条纪律：
 *  暂停本身**不许**因为一条附注而失败。缺席与调用抛错走同一个 `catch` 出口。
 *
 *  @returns {number|null} 真发出取消请求的编排脚本条数；服务缺席或调用抛错时 null
 */
function stopRunningWorkflowJobs(ctx, sessionId) {
  try {
    // 「服务缺席」与「确实一条都没在跑」必须是两个可区分的出口：前者抛，后者返回 0。
    // 刻意不写 `?? []`：折成空清单就与「确实没有」不可区分（票 `host-contract-gate/10` 那条纪律）。
    if (ctx === null || ctx === undefined
      || typeof ctx.jobs?.list !== 'function' || typeof ctx.jobs.kill !== 'function') {
      throw new Error('宿主作业服务缺席：ctx.jobs.list / ctx.jobs.kill 不可用')
    }
    const running = ctx.jobs.list(sessionId).filter(
      (job) => job?.owner === sessionId && job.kind === 'workflow' && job.status === JOB_RUNNING_STATUS,
    )
    let requested = 0
    for (const job of running) {
      if (ctx.jobs.kill(job.id, sessionId, '用户在造书工作台点击暂停') === 'requested') requested += 1
    }
    return requested
  } catch (e) {
    ctx?.logger?.warn?.(`textbook: 暂停时没停掉编排脚本（记 null 不记 0）: ${String(e instanceof Error ? e.message : e)}`)
    return null
  }
}


/** 动作族 · 协作信号：'style-note' / 'style-note-revoke' / 'intervene' / 'intervene-done' / 'waive' / 'waive-revoke' / 'pause'。
 *  状态改动一律走 updateMeta 的改法（当场新读）：本族原先清一色「读状态 → 改 → 整份写回 → 再记一笔」，
 *  写回时会把账高带回读状态那一刻的旧值（票 02）。 */
export const actCollabSignals = familyOf('collab-signals', async ({ ctx: ctx, action: action, sessionId: sessionId, project: project, body: body }) => {
  switch (action) {
    case 'style-note': {
      assertSessionOwned(project, sessionId)
      const text = textField(body.text, STYLE_NOTE_TEXT_MAX)
      if (text === '') { return reject(400, '请写下你的风格意见') }
      const source = ['wizard', 'ui', 'chat'].includes(body.source) ? body.source : 'ui'
      const styleNote = { id: `sn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, text, at: Date.now(), source, status: 'active' }
      updateMeta(project, (meta) => { meta.styleNotes = [...(meta.styleNotes ?? []), styleNote] })
      updateStyleLineMirror(project)
      appendEvent(project, 'textbook/style-note', { styleNote })
      return accept({ project, styleNote })
    }
    case 'style-note-revoke': {
      assertSessionOwned(project, sessionId)
      let target
      updateMeta(project, (meta) => {
        target = (meta.styleNotes ?? []).find((n) => n.id === body.id)
        if (target === undefined) return
        target.status = 'superseded'
        target.note = '用户收回'
      })
      if (target === undefined) { return reject(404, '没有这条风格意见') }
      updateStyleLineMirror(project)
      appendEvent(project, 'textbook/style-note', { styleNote: target, revoked: true })
      return accept({ project, styleNote: target })
    }
    case 'intervene': {
      assertSessionOwned(project, sessionId)
      const text = textField(body.text, INTERVENE_TEXT_MAX)
      if (text === '') { return reject(400, '请写下想留言的内容') }
      const intervention = {
        id: `iv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        at: Date.now(), text,
        target: textFieldRaw(body.target, INTERVENE_TARGET_MAX, undefined),
        status: 'pending',
      }
      updateMeta(project, (meta) => { meta.pendingInterventions = [...(meta.pendingInterventions ?? []), intervention] })
      appendEvent(project, 'textbook/intervention', { text: intervention.text, target: intervention.target })
      return accept({ project, intervention })
    }
    case 'intervene-done': {
      assertSessionOwned(project, sessionId)
      let target
      updateMeta(project, (meta) => {
        target = (meta.pendingInterventions ?? []).find((i) => i.id === body.id)
        if (target === undefined) return
        target.status = 'done'
      })
      if (target === undefined) { return reject(404, '没有这条留言') }
      appendEvent(project, 'textbook/intervention-done', { text: target.text })
      return accept({ project })
    }
    case 'waive': {
      assertSessionOwned(project, sessionId)
      const item = typeof body.item === 'string' ? body.item : ''
      if (WAIVER_ITEMS[item] === undefined) { return reject(400, '未知的豁免项') }
      const userNote = textField(body.userNote, WAIVER_NOTE_MAX)
      if (userNote === '') { return reject(400, '豁免必须手输原因（在对话里直接说明即可，由 AI 转交），这是放行的必要条件') }
      const waiver = {
        id: `wv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        item, reason: WAIVER_ITEMS[item].label, risk: WAIVER_ITEMS[item].risk, userNote,
        source: body.source === 'chat' ? 'chat' : 'ui', at: Date.now(),
      }
      updateMeta(project, (meta) => { meta.waivers = [...(meta.waivers ?? []), waiver] })
      appendEvent(project, 'textbook/waiver', { item, userNote })
      return accept({ project, waiver })
    }
    case 'waive-revoke': {
      assertSessionOwned(project, sessionId)
      let removed
      updateMeta(project, (meta) => {
        const idx = (meta.waivers ?? []).findIndex((w) => w.id === body.id)
        if (idx === -1) return
        ;[removed] = meta.waivers.splice(idx, 1)
      })
      if (removed === undefined) { return reject(404, '没有这条豁免') }
      appendEvent(project, 'textbook/waiver-revoke', { item: removed.item })
      return accept({ project })
    }
    case 'pause': {
      // 暂停：记账 pause → 事件 → 取消主 AI（keepInbox）；绝不 followup。
      // **不碰小助手**（票 dsh-contract-drift/01）：收回小助手是主笔 AI 自己的事，工作台只喊主 AI。
      // 票 `chapter-audit-orchestration/04` 起**另外** kill 掉这本书 owner 名下在跑的编排脚本——
      // 那条路径不越过「不许操纵宿主子代理」这条边界：它停的是 **job**（宿主 job 级取消，
      // 见 `stopRunningWorkflowJobs`），一个 `ctx.subagents.interrupt(...)` 都不发。
      // 口径：**「已暂停」现在对主 AI 与编排脚本都成立**——只有小助手还会把手上那段跑完、可能还在往书里写。
      // （本条待人的规矩在 `.scratch/subagent-guidance/issues/08`，不在这里。）
      assertSessionOwned(project, sessionId)
      // 「按下暂停时还有几个小助手在跑」——**只记那个数**，不记名字/编号（主笔 AI 自己有 list_agents）。
      // 这一刻先数（取消主 AI 不影响小助手，但事实说的是「按下暂停时」）。
      // ⚠️ **次序是契约的一部分：先数、再 kill**——编排脚本的成员在 `listDescendants` 眼里与小助手
      // 同形（同 `parentSession`、同 `origin: 'subagent'`、活的时候同 `activity: 'running'`，
      // 见 `CONTEXT.md`「编排脚本」与票 04 的笔记 §7），kill 会连带 abort 它们；次序反了，
      // 「按下暂停时还有几个在跑」这个数的口径就变成「kill 之后还剩几个」。
      const subagentsRunning = await countRunningSubagents(ctx, sessionId)
      const jobsStopped = stopRunningWorkflowJobs(ctx, sessionId)
      const meta = updateMeta(project, (state) => {
        state.pause = {
          at: Date.now(),
          reason: textFieldRaw(body.reason, PAUSE_REASON_MAX, '用户在造书工作台点击暂停'),
          subagentsRunning,
        }
      })
      // 停掉几条编排脚本**只进这一笔账的 data**，不进 `meta.pause`：那个记录的形状由 subagents
      // 契约冻结成 `['at','reason','subagentsRunning']`（`catalog/web-chat.js` 的
      // `SUBAGENT_PAUSE_SHAPE`，期望值从源码 AST 读出来对账），往里加字段是**另一份契约**的事。
      // 人读的两个出口（《过程记录.md》与对话播报）按 `data.jobsStopped` 说话（`engine.js`）。
      appendEvent(project, 'textbook/pause', {
        reason: meta.pause.reason,
        pendingStage: meta.pendingStage ?? null,
        subagentsRunning,
        jobsStopped,
      })
      try {
        ctx?.agents?.get?.(sessionId)?.cancel?.(
          { kind: 'hook', reason: meta.pause.reason },
          { keepInbox: true },
        )
      } catch (e) { ctx?.logger?.warn?.(`textbook: 暂停取消主 AI 失败: ${String(e instanceof Error ? e.message : e)}`) }
      return accept({ project, pause: meta.pause })
    }
  }
})
