# Run Manifests 设计（Issue #21）

> 日期：2026-09-11
> 分支：`feat/21-run-manifests`（基于 `upstream/main`）
> 状态：待评审

## 1. 背景与目标

当一个研究报告或 Copilot 回答出现质量问题时，仅知道“用了某个模型”不足以解释或复现结果。最终输出同时受 provider/model、推理参数、system prompt、技能/工具集、检索配置、feature flags 和应用版本影响。

本设计为每次 Agent 聊天 run 与 Deep Research run 生成一份**不可变的、machine-readable 的 manifest**，使任何历史 run/报告都能回答：**当时到底是用什么配置跑出来的？**

同时，这是 #14（Langfuse tracing / eval）、#15（Gold Case baseline）、#20/#29（provenance）、#30/#36（Source Inspector / 导出）的基础设施：manifest 提供稳定的 run identity 与配置快照。

## 2. 范围

**In scope（本次实现）**

- run 开始时采集并持久化 manifest；run 结束时**追加**实际结果（状态、stop reason、预算用量、report id）。
- 覆盖两条 run 路径：Agent 聊天 run（`RunManager.startRun`）与 Deep Research run（`ResearchService.start`），并自然覆盖内部 kernel run（synthesis/thesis/risk/evaluation）。
- `TraceInspector` 增加 Run Info 视图、JSON 导出、与同 session 上一条 manifest 的只读 diff。
- `ResearchReport.manifestId`，使历史报告可反查 manifest。
- 为新字段预埋 #14/#15 对接槽位（不实现 Langfuse 写入与 Gold Case runner）。

**Out of scope / Non-goals**

- 不保存 prompt 原文（只存 hash + 模板版本 + 长度）；不追求 bit-for-bit 复现。
- 不实现 Langfuse metadata 写入（#14）；不实现 Gold Case/dataset runner（#15），只提供字段。
- 不做全量环境变量快照；feature flags 采用白名单。
- 不做 manifest 保留/GC 策略（体积小，先全量保留；后续 issue 可加）。

## 3. 方案选择

| 方案 | 做法 | 结论 |
|---|---|---|
| **A. 统一 recorder 注入（采用）** | 新增 `RunManifestService`（builder + repository）；`RunManager` 与 `ResearchService` 注入可选 `RunManifestRecorder`；`kernelHost` 组装 capture context | 覆盖全部 run 路径，边界清晰、可注入 fake 测试；不阻塞其他子系统 |
| B. 只在 IPC/kernelHost 采集 | 包装 `runs:start` / `research:start` | 内部 run（synthesis/automation/eval）漏采，manifest 与 run 状态脱节 |
| C. runtime 内建写入 | `PiRuntimeAdapter` 自己持久化 | 持久化耦合进 runtime；拿不到 capability/settings，且 local 模式无法统一 |

## 4. 数据模型

新增 `packages/core/src/run-manifest.ts`（type-only，经 `packages/core/src/index.ts` 导出）。

```ts
export const RUN_MANIFEST_SCHEMA_VERSION = 1;

export type RunManifestKind = 'agent' | 'research';
export type RunManifestRuntimeMode = 'pi-runtime' | 'local';

export interface RunManifestApp {
  version: string;              // app.getVersion()
  build: string;                // FINAGENT_BUILD_SHA / folio.buildSha / 'dev'
  channel: string;              // 'beta' | ...
}

export interface RunManifestRuntime {
  mode: RunManifestRuntimeMode;
  provider?: string;            // 实际生效 provider（非当前全局设置）
  model?: string;
  thinkingLevel?: string;
  availableThinkingLevels?: string[];
  modelParams?: Record<string, string | number | boolean>;  // 仅运行时实际暴露的参数
  extensions: string[];         // Pi 扩展列表（顺序敏感，保留原顺序）
  observabilityDegraded?: boolean;
}

export interface RunManifestPrompt {
  templateVersion: string;      // 'pi-agent-prompt@1'
  systemHash: string;           // 静态 system 行
  skillIndexHash?: string;      // 技能索引段（无技能时省略）
  fullPromptHash: string;       // 完整 prompt 的 hash
  promptLength?: number;        // 长度，便于识别变化但不等同原文
  locale?: string;
}

export interface RunManifestTools {
  registryFingerprint: string;  // sha256(sorted capabilityIds + toolNames)
  capabilityIds: string[];
  toolNames: string[];
}

export interface RunManifestResearch {
  strategyId?: string;
  plannedCapabilities: string[];
}

export interface RunManifestRetrieval {
  provider: string;             // 目前恒为 'none'（#39 预留）
  configVersion?: string;
}

export interface RunManifestEvaluation {
  datasetId?: string;           // #15 预留
  datasetVersion?: string;      // #15 预留
  caseId?: string;              // #15 预留
}

export interface RunManifestBudget {
  limits: Partial<Record<BudgetKey, number>>;   // 复用 #17 run-budget 契约（capture 时写入）
  usage?: Record<BudgetKey, number>;            // finalize 时追加
  stopReason?: StopReason;                      // finalize 时追加
  stopDetail?: Record<string, unknown>;         // finalize 时追加
}

export interface RunManifestContext {
  sessionId?: string;
  /** WorkspaceContext 的只读快照（activeSymbol/activeView 等，无敏感内容）。 */
  workspace?: WorkspaceContext;
  locale?: string;
}

export interface RunManifestOutcome {
  status: string;               // RunStatus / ResearchRunStatus / 'running'
  finishedAt?: number;
  errorCode?: string;
  reportId?: string;
}

/** 单次 run 的不可变配置快照 + 追加式 outcome。 */
export interface RunManifest {
  schemaVersion: 1;
  runId: string;
  kind: RunManifestKind;
  createdAt: number;
  app: RunManifestApp;
  runtime: RunManifestRuntime;
  prompt?: RunManifestPrompt;   // local 模式或无 prompt 时省略
  tools: RunManifestTools;
  research?: RunManifestResearch;
  retrieval: RunManifestRetrieval;
  budget?: RunManifestBudget;   // capture 写 limits，finalize 追加 usage/stop
  featureFlags: Record<string, string | number | boolean>;
  evaluation?: RunManifestEvaluation;
  context?: RunManifestContext;
  /** 只在 finalize 时追加；初始 capture 时为 undefined。 */
  outcome?: RunManifestOutcome;
}
```

**诚实语义（与仓库既有原则一致）**

- 拿不到的字段一律 `undefined`/省略，不用当前全局设置或默认值冒充。
- `runtime` 是 run 开始时的**实际生效状态**快照（Pi `get_state`），不是 settings 页面值。
- `featureFlags` 只含白名单字段，且值为标量。

## 5. 采集与哈希

### 5.1 Recorder 契约

`RunManifestRecorder`（core 类型，shared/electron 共用）：

```ts
export interface RunManifestCaptureRequest {
  runId: string;
  kind: RunManifestKind;
  sessionId?: string;
  content?: string;             // 仅用于 prompt descriptor，不落盘
  workspaceContext?: WorkspaceContext;
  locale?: SupportedLocale;
  research?: RunManifestResearch;
  evaluation?: RunManifestEvaluation;   // 实验/eval run 传入
  budgetLimits?: Partial<Record<BudgetKey, number>>;
}

export interface RunManifestRecorder {
  capture(request: RunManifestCaptureRequest): Promise<void>;
  finalize(
    runId: string,
    outcome: RunManifestOutcome,
    budget?: Pick<RunManifestBudget, 'usage' | 'stopReason' | 'stopDetail'>
  ): Promise<void>;
}
```

- `RunManifestService` 实现该契约；`capture`/`finalize` **永不抛出**（best-effort，失败写 diagnostics 回调，不阻塞 run）。
- 未注入 recorder 时行为与现状完全一致（测试/嵌入式）。

### 5.2 Capture context（electron 侧组装）

`kernelHost` 提供：

- `app`：`app.getVersion()` + `readBuildSha()`（about.ts 已有）+ channel。
- `runtime`：`kernel.getLlmApi()?.getState()`（失败则 runtime 字段留空，不触发 runtime 启动）；`listBundledPiExtensions()`（resource-locator.ts）与 `isObservabilityDegraded()`；local 模式给 `{ mode:'local', extensions: [] }`。
- `tools`：`fingerprintTools(this.registry.list())`。
- `featureFlags`：`collectManifestFeatureFlags(process.env)` 白名单（见 5.4）+ evaluation settings 中的 tracing/privacy + runtime degraded。
- `retrieval`：`{ provider: 'none' }`。
- prompt descriptor：`runtime.describePrompt?.(...)`（见 5.3）。

### 5.3 Prompt 描述符

把 `pi-runtime-adapter.ts` 内联的 `buildPrompt` 重构为导出的纯函数：

```ts
export const AGENT_PROMPT_TEMPLATE_VERSION = 'pi-agent-prompt@1';

export function buildAgentPrompt(input: {
  content: string;
  state?: ...;                  // recentSymbols 等
  workspaceContext?: WorkspaceContext;
  skillHub?: SkillHub;
  readinessProvider?: ...;
  locale?: SupportedLocale;
}): {
  text: string;
  templateVersion: string;
  systemText: string;           // 静态 system 行（不含用户内容）
  skillIndexText?: string;      // 技能索引段
};
```

`AgentRuntime` 增加可选方法（core/index.ts）：

```ts
describePrompt?: (input: AgentRunInput) => Promise<{
  templateVersion: string;
  systemText: string;
  skillIndexText?: string;
  text: string;
}>;
```

`PiRuntimeAdapter` 用它组装真实 prompt（行为不变），并实现 `describePrompt`。`RunManifestService` 用 `sha256` 计算：

- `systemHash = hash(systemText)`
- `skillIndexHash = hash(skillIndexText)`（存在时）
- `fullPromptHash = hash(text)`
- `promptLength = text.length`

prompt 文本只存在于内存，绝不写入 manifest/日志/telemetry。

### 5.4 Feature flags 白名单

`collectManifestFeatureFlags(env)` 只读取并返回：

- `FINAGENT_AGENT_PROVIDER`、`FINAGENT_PRIVACY_LEVEL`、`FINAGENT_PACKAGED`
- `FINAGENT_PI_PROVIDER`、`FINAGENT_PI_MODEL`、`FINAGENT_PI_VERSION`
- `TRACE_TO_LANGSMITH`（布尔化）、`LANGSMITH_PI_PROJECT`（非 secret）
- evaluation settings：`privacyLevel`、tracing backend id（来自 `EvaluationStore`，非 env）

任何 secret（API key/token/credential）不在白名单内，且 builder 第一步对全部字符串值再过一遍 `redact()`（diagnostics/redact.ts），双保险。

## 6. 持久化

`RunManifestRepository`（`packages/shared/src/manifest/repository.ts`，复用 `JsonFileStore`）：

```
<storeRoot>/manifests/<runId>.json     # 完整 RunManifest
<storeRoot>/manifests/index.json       # RunManifestSummary[]，newest first
```

```ts
export interface RunManifestSummary {
  runId: string;
  kind: RunManifestKind;
  createdAt: number;
  runtimeMode: RunManifestRuntimeMode;
  provider?: string;
  model?: string;
  status?: string;              // outcome.status（finalize 后）
}
```

API：`save(manifest)`、`get(runId)`、`list(limit?)`、`finalize(runId, outcome, budget?)`。

- `finalize` 读回 manifest → 追加 `outcome`，并把 `budget.usage/stopReason/stopDetail` 合并进 capture 时写入的 `budget.limits` → 原子写回 + 更新 index 摘要。
- 文件损坏/不可读：`get` 返回 `undefined` 并上报 diagnostic，**不抛出**。
- 初始配置字段（含 `budget.limits`、`runtime`、`prompt`）在 finalize 时不被覆盖（append-only 语义），只有 outcome 区与 budget 用量字段变化。

`kernelHost` 使用 `new JsonFileStore(join(userData, 'store'))`（与 kernel/research 一致）。

## 7. 集成

### 7.1 RunManager（Agent 聊天 + 内部 run）

- `RunManagerOptions` 增加 `manifests?: RunManifestRecorder`。
- `startRun`：
  - 现有签名追加可选第 6 参 `manifestExtras?: { evaluation?: RunManifestEvaluation; retrieval?: RunManifestRetrieval; research?: RunManifestResearch }`（实验服务用）。
  - run 落库后（`runs.create`）调用 `void this.manifests?.capture({...})`，附 `budgetLimits: activeRun.limits`。
- `execute` settle 后调用 `await this.manifests?.finalize(run.id, { status, finishedAt, errorCode }, { usage, stopReason, stopDetail })`。
- 记录值同时来自 `run.status`、`run.stopReason/stopDetail`（#17）。

### 7.2 AgentKernel

- `AgentKernelOptions` 增加 `manifests?: RunManifestRecorder`，透传给 `RunManager`。

### 7.3 ResearchService（Deep Research）

- `ResearchServiceOptions` 增加 `manifests?: RunManifestRecorder`。
- `start()` 保存 summary 后 `capture({ kind:'research', research:{ strategyId, plannedCapabilities }, locale })`。
- `execute()` 结束时 `finalize(runId, { status: result.summary.status, finishedAt, reportId: result.report?.id, errorCode? })`。
- `ResearchReport` 增加可选 `manifestId?: string`（= runId），由 `runner.assembleReport` 写入；历史报告缺失时字段省略。

### 7.4 kernelHost 接线

```ts
this.manifestRepository = new RunManifestRepository(new JsonFileStore(join(userData, 'store')));
this.manifestService = new RunManifestService({
  repository: this.manifestRepository,
  captureContext: () => this.captureManifestContext(),       // 见 5.2
  describePrompt: (req) => this.kernel.runtime.describePrompt?.(...),
  now: this.now,
  onError: (error) => this.logDiagnostic(error),              // 已有 diagnostics 通道
});
```

注入：`new AgentKernel({ ..., manifests: this.manifestService })`、`new ResearchService({ ..., manifests: this.manifestService })`。

### 7.5 IPC / preload / client

| 通道 | 入参 | 返回 |
|---|---|---|
| `manifests:get` | `runId` | `RunManifest \| undefined` |
| `manifests:list` | `{ limit?: number }` | `RunManifestSummary[]` |
| `manifests:diff` | `{ beforeRunId, afterRunId }` | `RunManifestChange[]` |

- main：`apps/electron/src/main/index.ts` + `kernelHost` 方法。
- preload：`apps/electron/src/preload/index.ts`。
- renderer client：`apps/electron/src/renderer/finagentClient.ts`。
- UI client 契约：`packages/ui/src/client/manifest.ts`（browser-safe，只依赖 core 类型）。

## 8. Diff

`packages/shared/src/manifest/diff.ts`：

```ts
export type RunManifestCategory =
  | 'app' | 'runtime' | 'prompt' | 'tools' | 'research'
  | 'retrieval' | 'flags' | 'evaluation' | 'context' | 'budget';

export interface RunManifestChange {
  category: RunManifestCategory;
  path: string;                  // 稳定路径，如 'runtime.model'
  before?: unknown;              // JSON-safe 快照
  after?: unknown;
  added?: string[];              // 数组字段的增量
  removed?: string[];
}

export function diffRunManifests(before: RunManifest, after: RunManifest): RunManifestChange[];
```

- 只比较配置类字段；`outcome` 默认排除（run 结果不是配置），`budget` 只比较 `limits`（用量/stop 属于结果）。
- 数组（extensions/capabilityIds/toolNames）按集合比较，输出 added/removed；顺序变化不算变更。
- 标量/对象按值比较；路径稳定、可测试。
- 纯函数，无 I/O；参照 `research-diff` 的确定性风格。

## 9. UI（最小）

新增 `packages/ui/src/components/trace/RunInfoPanel.tsx`：

- 展示：版本/构建/channel、runtime（mode/provider/model/thinking/params/extensions）、prompt（templateVersion/hash/length）、tools（fingerprint + 数量）、research（strategy/plan）、flags、预算/stop reason、report 链接。
- **Export JSON**：把当前 manifest 序列化为 Blob 下载（浏览器 API，无 Node 依赖）。
- **Diff vs previous run**：容器组件通过 `manifests:diff` 获取 `RunManifestChange[]` 后渲染只读列表（按 category 分组）。
- `TraceInspector` 增加 `manifest?`、`manifestDiff?`、`onExport` 相关 props（保持纯展示组件，测试友好）。
- 容器：`AgentPanel.handleOpenTrace` 加载 manifest + 上一 run 的 diff；`ResearchReportView` 通过 `report.manifestId` 加载（按钮打开同一面板）。

UI 不引入 shared 业务逻辑；diff 一律由 main 计算。

## 10. 错误处理

- capture/finalize 失败：吞掉并上报 diagnostic；run 继续，UI 不阻断。
- runtime 状态读取失败（runtime 未启动/崩溃）：runtime 字段按可获取部分记录，其余省略。
- prompt descriptor 失败：manifest 仍保存，`prompt` 省略。
- 损坏 manifest：`get` 返回 undefined；diff 缺任一侧时返回空并提示（不伪造差异）。
- 并发：manifest 与 run 一一对应，`finalize` 以 runId 幂等；同一 run 重复 finalize 覆盖 outcome（结果一致）。

## 11. 测试计划（确定性，bun test）

单测（新增）：

1. `manifest/builder.test.ts`：固定 now 生成确定 manifest；同输入两次相等；hash 格式稳定；canary secret 不出现在任何字段；缺字段省略。
2. `manifest/fingerprint.test.ts`：相同工具集指纹稳定；增删 capability/tool 后指纹变化。
3. `manifest/repository.test.ts`：save/get/list 顺序；finalize 只追加 outcome；新实例重读（模拟重启）仍是原始配置；损坏文件返回 undefined。
4. `manifest/diff.test.ts`：model/thinking/prompt hash/extensions/capability/版本/flag 变化各产生正确 category+path；完全相同 → `[]`；数组顺序变化不算变更。
5. `manifest/service.test.ts`：capture→finalize 全链路；repository 抛错时不外抛；describePrompt 抛错时其余字段仍落盘。
6. `kernel/run-manager.test.ts` 增补：注入 fake recorder，断言 capture（kind=agent、budgetLimits）与 finalize（status/budget/stopReason）。
7. `research/service.test.ts` 增补：recorder capture/finalize；`report.manifestId === runId`。
8. `agent/pi-runtime-adapter` 增补：`buildAgentPrompt` 确定性；locale 变化 → fullPromptHash 变化、templateVersion 不变；`describePrompt` 与实际发送 prompt 一致。
9. `ui/trace/RunInfoPanel.test.tsx`：渲染字段与 diff；无 locale/平台依赖。

E2E：

- **离线可跑（CI 友好）**：`manifest/e2e-fixture.test.ts` 用真实采集的两份 capture context fixture（`manifest/fixtures/manifests-e2e.json`），走 production service+repository+diff，断言两次不同配置的 manifest 与 diff。
- **Live（真实 run，需用户环境）**：`apps/electron/e2e/run-manifests.mjs`（沿现有 Playwright e2e 约定，local provider 可用）：
  1. 第一次 Deep Research → 修改 strategy → 第二次 Deep Research；
  2. 断言两次 manifest 的 `research.strategyId` 差异、restart 后 Run Info 仍显示原始配置、`manifests:diff` 输出正确；
  3. 产物：两份 manifest JSON + diff 输出 + UI 截图路径，供 PR 附件。
- 说明：`pi-runtime` 下的 model/thinking 差异 E2E 需要 API key，脚本同时给出该变体的运行说明；PR 证据由用户在具备环境时执行。

## 12. 验收对照

| Issue #21 验收项 | 对应实现/验证 |
|---|---|
| 每次 Agent / Deep Research run 生成稳定持久 manifest | §7 集成 + 单测 6/7 |
| 重启/配置变更后历史 run 仍显示原始配置 | §6 append-only + 单测 3 + live E2E |
| prompt 有稳定 version/hash，可识别内容变化 | §5.3 + 单测 8 |
| tool/search/retrieval 配置可追踪 | `tools.registryFingerprint` + `retrieval` 槽位 + 单测 2 |
| 两个 run 可读 diff | §8 + 单测 4 + UI §9 |
| eval run 记录 gold case/dataset version，对应 #15 | §4 字段 + `startRun` `manifestExtras.evaluation`；#15 未完成，字段可用但暂未自动填充（文档标注） |
| manifest 无 credential/secret，#19 canary 验证 | §5.4 白名单 + redact + 单测 1 |
| 两次真实 production run + 配置差异证据 | §11 live E2E（PR 附件） |
| Run Info 视图 + JSON 导出 + 重启后可见 | §9 + 单测 9 + live E2E |

## 13. 已知限制

- 只记录运行时**实际暴露**的参数（Pi 目前暴露 model identity + thinkingLevel；sampling 等不可得字段省略）。
- Langfuse metadata 对齐（#14）仅保证同一 run id，未接线；Gold Case（#15）字段预留。
- 不保存 prompt 原文/prompt 模板来源的文本，只保留 `templateVersion` 常量与 hash；“可追踪到模板来源”以版本常量 + 代码位置表达。
- manifest 无保留上限；后续可加 GC/rotation。
- 本机基线测试存在 5 个环境相关预存失败（Windows symlink/locale/electron），与 #21 无关；新测试设计为与 locale/平台无关。

## 14. 版本与演进

- `schemaVersion: 1`；字段只增不减；语义破坏性变更需提升版本并在读取时按版本分支处理。
- `RUN_MANIFEST_SCHEMA_VERSION` 常量与类型同源；repository 读取低版本记录时原样返回（不猜测迁移）。
