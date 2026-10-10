/**
 * 宿主 `jobs`（后台作业）服务里**本仓真正消费**的那一小片形状——单点。
 *
 * 形状的唯一出处是随代码入库的契约快照
 * `docs/reference/dsh-cordis/jobs-后台作业契约摘录.md`（**dsh 0.2.0-rc.2**，头部三件齐：
 * 来源路径／上游版本／快照日期）。本模块只是那份快照的**消费面**：生产
 * （`src/workflow/actions/collab-signals.js` 的暂停路径）与测试探针
 * （`workbench-fake-host.mjs` 的 `makeJobsProbe`）都从这里读词表，谁也不手抄第二份
 * （票 `chapter-audit-orchestration/04` 收口：原先是**两处**——一处是注释里的枚举，
 * 一处是数组字面量——而两边的形状都逐条引安装树行号现造，正是 AGENTS.md「宿主契约」
 * 第 2 条点名的病因「照代码的形状造出来的绿」）。
 *
 * ⚠️ **本模块的枚举面比现实窄**（票 `dev-gate-scan/17` 那条纪律）：
 *  · `JOB_VIEW_FIELDS` 是 `JobView` 的**全部**字段，但生产与探针今天只读
 *    `JOB_CONSUMED_VIEW_FIELDS` 那四位——其余七位登记在这里只为「快照 ↔ 单点对得上」，
 *    **不代表**有人消费它们（快照 §3 与那道判据都这样写着）。
 *  · `JOB_CALLER_SEMANTICS` 只登记本仓消费的 `list` / `kill` 两个方法的 caller 规范词；
 *    另外七个方法的 caller 语义写在快照里，本模块不复制（复制了就是第二份会漂的清单）。
 *  · `JobOutcome.status` 那三枚与 `JOB_TERMINAL_STATUSES` 逐字相同（快照 §1 注明），
 *    所以**不另立一份**；`JobChunk` / `JobEvent` / `JobSettleCause` 那些面本仓今天一条都不读，
 *    整片不进这个模块。
 */

/** `JobStatus` 的取值域闭集（快照 §1／`dsh-jobs/lib/types/view.d.ts:15`）：两枚活态 ＋ 三枚终态。
 *  下面那几枚具名常量都指向这里的一员，五枚状态词**只在这个数组里各写一次**。 */
export const JOB_STATUS_VALUES = ['running', 'stopping', 'completed', 'killed', 'failed']

/** 终态那三枚（快照 §1；`JobOutcome.status` 就是这三枚，逐字相同）。 */
export const JOB_TERMINAL_STATUSES = ['completed', 'killed', 'failed']

/** 「在跑」那一枚——生产那条过滤条件用它（`job.status === JOB_RUNNING_STATUS`）。 */
export const JOB_RUNNING_STATUS = 'running'

/** `kill` 之后、producer 结算之前的那一枚（取消已发出、等结算）。探针用它扮演宿主那一步。 */
export const JOB_STOPPING_STATUS = 'stopping'

/** `kill` 结算之后的终态那一枚。探针的 `settle()`（＝ producer 的 `done`）用它。 */
export const JOB_KILLED_STATUS = 'killed'

/** `kill` 的返回闭集（快照 §4／`dsh-jobs/lib/types/index.d.ts:116`）：
 *  活的返回 `requested`，已经终态的返回 `already-finished`。 */
export const JOB_KILL_RESULTS = ['requested', 'already-finished']

/** `ctx.jobs` 挂在服务上的那九个抽象方法（快照 §2／`index.d.ts:59-146`）。 */
export const JOB_METHOD_NAMES = [
  'list', 'kill', 'get', 'read', 'readAt', 'wait', 'remove', 'start', 'attachController',
]

/** 本仓**真调**的那两个方法（快照 §2b 的 caller 规范词射程就是它们）。 */
export const JOB_CONSUMED_METHODS = ['list', 'kill']

/** `JobView` 的字段名（快照 §3／`view.d.ts:55-94`），十一枚。 */
export const JOB_VIEW_FIELDS = [
  'id', 'kind', 'label', 'owner', 'outputLimitBytes', 'status',
  'progress', 'detail', 'startedAt', 'finishedAt', 'output',
]

/** 生产与探针今天**真读**的那四位（其余七位没有消费者，见头部 ⚠️ 第一条）。 */
export const JOB_CONSUMED_VIEW_FIELDS = ['id', 'kind', 'status', 'owner']

/** `list` / `kill` 的 caller 规范词（快照 §2b，**逐字双向**对账）——只有这两枚方法。 */
export const JOB_CALLER_SEMANTICS = {
  list: ['caller', 'unowned'],
  kill: ['caller', 'owner', 'owner === caller'],
}

/** owner fence 的性质那一句（快照正文逐字写着它）：id 可预测 ⇒ 它是**授权边界，不是保密边界**。
 *  正是这句话让「插件把 owner 的 session id 当 caller 递进去」成立（票 04 的结论）。 */
export const JOB_OWNER_FENCE_QUOTE = 'authorization, not secrecy'
