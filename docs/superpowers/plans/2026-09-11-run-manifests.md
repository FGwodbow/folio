# Run Manifests 实现计划（Issue #21）

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为每次 Agent / Deep Research run 持久化一份不可变的 machine-readable manifest（配置快照 + 追加式结果），并提供 Run Info 视图、JSON 导出、两 run diff。

**架构：** 新增 `@finagent/core` 类型 + `packages/shared/src/manifest` 模块（builder / repository / service / diff / fingerprint / feature-flags）。`RunManager` 与 `ResearchService` 注入可选 `RunManifestRecorder`；`kernelHost` 组装 capture context（app 版本、Pi 实际状态快照、扩展、工具指纹、白名单 flags）并通过 IPC 暴露给 UI；`TraceInspector` 增加 Run Info 面板。

**技术栈：** TypeScript、Bun（test/typecheck）、TypeBox（不新增依赖）、React + happy-dom（UI 测试）、Electron IPC。

**设计文档：** `docs/superpowers/specs/2026-09-11-run-manifests-design.md`

---

## 文件结构

**创建：**

| 文件 | 职责 |
|---|---|
| `packages/core/src/run-manifest.ts` | manifest 契约类型（core，type-only） |
| `packages/shared/src/manifest/hash.ts` | `shortHash` 与 `fingerprintTools` |
| `packages/shared/src/manifest/feature-flags.ts` | 白名单 feature flags 采集 |
| `packages/shared/src/manifest/builder.ts` | 纯函数：capture input → RunManifest（含 hash/redact） |
| `packages/shared/src/manifest/repository.ts` | `JsonFileStore` 持久化 + index + append-only finalize |
| `packages/shared/src/manifest/service.ts` | `RunManifestRecorder` 实现（best-effort capture/finalize/diff） |
| `packages/shared/src/manifest/diff.ts` | 纯函数 manifest diff |
| `packages/shared/src/manifest/index.ts` | 模块 barrel |
| `packages/shared/src/manifest/*.test.ts` | 单测（6 个文件） |
| `packages/shared/src/manifest/fixtures/manifests-e2e.json` | 真实采集 fixture（离线 E2E） |
| `packages/shared/src/manifest/e2e-fixture.test.ts` | 离线 E2E |
| `packages/ui/src/client/manifest.ts` | renderer-safe manifest channel 契约 |
| `packages/ui/src/components/trace/RunInfoPanel.tsx` | Run Info 展示 + Export JSON + diff 列表 |
| `packages/ui/src/components/trace/RunInfoPanel.test.tsx` | 组件测试 |
| `apps/electron/e2e/run-manifests.mjs` | live E2E（两次真实 Deep Research + 改配置） |

**修改：**

| 文件 | 变更 |
|---|---|
| `packages/core/src/index.ts` | 导出 run-manifest；`AgentRuntime.describePrompt?` |
| `packages/core/src/research.ts` | `ResearchReport.manifestId?` |
| `packages/shared/src/index.ts` | 导出 manifest barrel |
| `packages/shared/package.json` | 增加 `./manifest` subpath export |
| `packages/shared/src/agent/pi-runtime-adapter.ts` | `buildAgentPrompt` 纯函数 + `describePrompt` |
| `packages/shared/src/kernel/run-manager.ts` | recorder 注入 + capture/finalize + `manifestExtras` |
| `packages/shared/src/kernel/agent-kernel.ts` | `AgentKernelOptions.manifests` 透传 |
| `packages/shared/src/research/service.ts` | recorder 注入 + capture/finalize |
| `packages/shared/src/research/runner.ts` | `report.manifestId = runId` |
| `apps/electron/src/main/about.ts` | 导出 `readBuildSha`/`readChannel` |
| `apps/electron/src/main/kernelHost.ts` | manifest repository/service/capture context + host 方法 |
| `apps/electron/src/main/index.ts` | `manifests:*` IPC handler |
| `apps/electron/src/preload/index.ts` | `manifests` channel |
| `apps/electron/src/renderer/finagentClient.ts` | `manifests` channel 实现 |
| `packages/ui/src/client.tsx` | `FinagentClient.manifests?` + fallback |
| `packages/ui/src/components/trace/TraceInspector.tsx` | Run Info tab |
| `packages/ui/src/components/agent/AgentPanel.tsx` | 加载 manifest + diff 传入 TraceInspector |
| `packages/ui/src/components/research/ResearchReportView.tsx` | 通过 `report.manifestId` 打开 Run Info |
| `packages/i18n/src/locales/{en-US,zh-CN}/trace.ts` | Run Info 文案键 |

**命令约定**（仓库根目录执行）：单测 `bun test <path>`；包 typecheck `cd packages/<pkg> && bun run typecheck`（或根 `bun run typecheck`）。

**Commit 约定**：conventional commits，如 `feat(manifest): ...`、`test(manifest): ...`。

---

## 任务 1：Core 契约类型

**文件：**
- 创建：`packages/core/src/run-manifest.ts`
- 修改：`packages/core/src/index.ts`（导出 + `AgentRuntime.describePrompt?`）
- 修改：`packages/core/src/research.ts`（`ResearchReport.manifestId?`）

- [ ] **步骤 1：创建 `packages/core/src/run-manifest.ts`**

```ts
import type { StopReason, WorkspaceContext } from './index.ts';
import type { SupportedLocale } from './locale.ts';

/**
 * Run manifest contract (#21) — an immutable, machine-readable snapshot of the
 * configuration a run actually executed with, plus an append-only outcome.
 * Prompt content is never stored; only versions, hashes and lengths.
 */

export const RUN_MANIFEST_SCHEMA_VERSION = 1;

export type RunManifestKind = 'agent' | 'research';
export type RunManifestRuntimeMode = 'pi-runtime' | 'local';

export interface RunManifestApp {
  version: string;
  build: string;
  channel: string;
}

export interface RunManifestRuntime {
  mode: RunManifestRuntimeMode;
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  availableThinkingLevels?: string[];
  modelParams?: Record<string, string | number | boolean>;
  extensions: string[];
  observabilityDegraded?: boolean;
}

export interface RunManifestPrompt {
  templateVersion: string;
  systemHash: string;
  skillIndexHash?: string;
  fullPromptHash: string;
  promptLength?: number;
  locale?: SupportedLocale;
}

export interface RunManifestTools {
  registryFingerprint: string;
  capabilityIds: string[];
  toolNames: string[];
}

export interface RunManifestResearch {
  strategyId?: string;
  plannedCapabilities: string[];
}

export interface RunManifestRetrieval {
  provider: string;
  configVersion?: string;
}

export interface RunManifestEvaluation {
  datasetId?: string;
  datasetVersion?: string;
  caseId?: string;
}

export interface RunManifestBudget {
  limits: Record<string, number>;
  usage?: Record<string, number>;
  stopReason?: StopReason;
  stopDetail?: Record<string, unknown>;
}

export interface RunManifestContext {
  sessionId?: string;
  workspace?: WorkspaceContext;
  locale?: SupportedLocale;
}

export interface RunManifestOutcome {
  status: string;
  finishedAt?: number;
  errorCode?: string;
  reportId?: string;
}

export interface RunManifest {
  schemaVersion: typeof RUN_MANIFEST_SCHEMA_VERSION;
  runId: string;
  kind: RunManifestKind;
  createdAt: number;
  app: RunManifestApp;
  runtime: RunManifestRuntime;
  prompt?: RunManifestPrompt;
  tools: RunManifestTools;
  research?: RunManifestResearch;
  retrieval: RunManifestRetrieval;
  budget?: RunManifestBudget;
  featureFlags: Record<string, string | number | boolean>;
  evaluation?: RunManifestEvaluation;
  context?: RunManifestContext;
  outcome?: RunManifestOutcome;
}

export interface RunManifestSummary {
  runId: string;
  kind: RunManifestKind;
  createdAt: number;
  runtimeMode: RunManifestRuntimeMode;
  provider?: string;
  model?: string;
  status?: string;
}

/** Budget fields appended at finalize; limits were captured at start. */
export interface RunManifestBudgetOutcome {
  usage?: Record<string, number>;
  stopReason?: StopReason;
  stopDetail?: Record<string, unknown>;
}

export interface RunManifestCaptureRequest {
  runId: string;
  kind: RunManifestKind;
  sessionId?: string;
  /** Prompt input only; never persisted. */
  content?: string;
  workspaceContext?: WorkspaceContext;
  locale?: SupportedLocale;
  research?: RunManifestResearch;
  evaluation?: RunManifestEvaluation;
  retrieval?: RunManifestRetrieval;
  budgetLimits?: Record<string, number>;
}

export type RunManifestCaptureExtras = Pick<
  RunManifestCaptureRequest,
  'evaluation' | 'retrieval' | 'research'
>;

/** Prompt parts returned by a runtime; only hashes are persisted. */
export interface AgentPromptDescriptor {
  templateVersion: string;
  systemText: string;
  skillIndexText?: string;
  text: string;
}

export interface RunManifestRecorder {
  capture(request: RunManifestCaptureRequest): Promise<void>;
  finalize(
    runId: string,
    outcome: RunManifestOutcome,
    budget?: RunManifestBudgetOutcome
  ): Promise<void>;
}
```

- [ ] **步骤 2：在 `packages/core/src/index.ts` 顶部加 import，并在 `AgentRuntime` 增加可选方法**

顶部（与 `import type { SupportedLocale } from './locale.ts';` 同区）：

```ts
import type { AgentPromptDescriptor } from './run-manifest.ts';
```

`AgentRuntime` 接口（约 493-505 行）在 `run` 之后加入：

```ts
  /** Prompt descriptor for run manifests; implemented by the Pi runtime. */
  describePrompt?: (input: AgentRunInput) => Promise<AgentPromptDescriptor>;
```

在 `export * from './research.ts';`（约 528 行）之后加入：

```ts
export * from './run-manifest.ts';
```

- [ ] **步骤 3：`packages/core/src/research.ts` 的 `ResearchReport` 增加 `manifestId`**

在 `locale?: SupportedLocale;` 字段之后加入：

```ts
  /** Run-manifest id (= research run id) for Run Info / reproducibility (#21). */
  manifestId?: string;
```

- [ ] **步骤 4：typecheck**

运行：`cd packages/core && bun run typecheck`
预期：无错误。

- [ ] **步骤 5：Commit**

```bash
git add packages/core/src/run-manifest.ts packages/core/src/index.ts packages/core/src/research.ts
git commit -m "feat(core): add run manifest contract types (#21)"
```

---

## 任务 2：指纹与 feature flags

**文件：**
- 创建：`packages/shared/src/manifest/hash.ts`
- 创建：`packages/shared/src/manifest/feature-flags.ts`
- 测试：`packages/shared/src/manifest/hash.test.ts`
- 测试：`packages/shared/src/manifest/feature-flags.test.ts`

- [ ] **步骤 1：编写失败的测试 `hash.test.ts`**

```ts
import { describe, expect, it } from 'bun:test';
import { fingerprintTools, shortHash } from './hash.ts';

describe('shortHash', () => {
  it('is deterministic and 16 hex chars', () => {
    expect(shortHash('hello')).toBe(shortHash('hello'));
    expect(shortHash('hello')).toMatch(/^[0-9a-f]{16}$/);
    expect(shortHash('hello')).not.toBe(shortHash('hello!'));
  });
});

describe('fingerprintTools', () => {
  const caps = [
    { id: 'market.quote', toolName: 'get_quote' },
    { id: 'research.news', toolName: 'get_news' },
  ];

  it('sorts and dedupes ids and tool names deterministically', () => {
    const a = fingerprintTools(caps);
    const b = fingerprintTools([...caps].reverse());
    expect(a).toEqual(b);
    expect(a.capabilityIds).toEqual(['market.quote', 'research.news']);
    expect(a.toolNames).toEqual(['get_news', 'get_quote']);
    expect(a.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('changes when the tool set changes', () => {
    const a = fingerprintTools(caps);
    const b = fingerprintTools([...caps, { id: 'market.kline', toolName: 'get_kline' }]);
    expect(b.fingerprint).not.toBe(a.fingerprint);
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`bun test packages/shared/src/manifest/hash.test.ts`
预期：FAIL，报错 `Cannot find module './hash.ts'`。

- [ ] **步骤 3：实现 `hash.ts`**

```ts
import { createHash } from 'node:crypto';

/** Stable 16-hex-char content hash for manifests (not a security primitive). */
export function shortHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export interface FingerprintableCapability {
  id: string;
  toolName: string;
}

export interface ToolFingerprint {
  fingerprint: string;
  capabilityIds: string[];
  toolNames: string[];
}

/** Deterministic registry fingerprint: sorted capability ids + tool names. */
export function fingerprintTools(capabilities: readonly FingerprintableCapability[]): ToolFingerprint {
  const capabilityIds = [...new Set(capabilities.map((capability) => capability.id))].sort();
  const toolNames = [...new Set(capabilities.map((capability) => capability.toolName))].sort();
  return {
    fingerprint: shortHash([...capabilityIds, '|', ...toolNames].join('\n')),
    capabilityIds,
    toolNames,
  };
}
```

- [ ] **步骤 4：运行测试确认通过**

运行：`bun test packages/shared/src/manifest/hash.test.ts`
预期：PASS（4 个断言组）。

- [ ] **步骤 5：编写失败的测试 `feature-flags.test.ts`**

```ts
import { describe, expect, it } from 'bun:test';
import { collectManifestFeatureFlags } from './feature-flags.ts';

describe('collectManifestFeatureFlags', () => {
  it('keeps only whitelisted, non-empty env keys', () => {
    const flags = collectManifestFeatureFlags({
      FINAGENT_AGENT_PROVIDER: 'pi-runtime',
      FINAGENT_PRIVACY_LEVEL: 'standard',
      ANTHROPIC_API_KEY: 'sk-must-not-appear',
      LANGSMITH_PI_API_KEY: 'lsv2_must_not_appear',
    });
    expect(flags).toEqual({
      FINAGENT_AGENT_PROVIDER: 'pi-runtime',
      FINAGENT_PRIVACY_LEVEL: 'standard',
    });
    expect(JSON.stringify(flags)).not.toContain('must-not-appear');
  });

  it('booleanizes TRACE_TO_LANGSMITH and merges explicit extras', () => {
    const flags = collectManifestFeatureFlags(
      { TRACE_TO_LANGSMITH: '1' },
      { tracingEnabled: true, privacyLevel: 'minimal', observabilityDegraded: false }
    );
    expect(flags.TRACE_TO_LANGSMITH).toBe(true);
    expect(flags.tracingEnabled).toBe(true);
    expect(flags.privacyLevel).toBe('minimal');
    expect(flags.observabilityDegraded).toBe(false);
  });
});
```

- [ ] **步骤 6：运行测试确认失败**

运行：`bun test packages/shared/src/manifest/feature-flags.test.ts`
预期：FAIL（模块不存在）。

- [ ] **步骤 7：实现 `feature-flags.ts`**

```ts
/**
 * Whitelisted feature flags for run manifests. Never enumerate the whole
 * environment: a secret must not become part of a manifest by accident.
 */

export const MANIFEST_FLAG_KEYS = [
  'FINAGENT_AGENT_PROVIDER',
  'FINAGENT_PRIVACY_LEVEL',
  'FINAGENT_PACKAGED',
  'FINAGENT_PI_PROVIDER',
  'FINAGENT_PI_MODEL',
  'FINAGENT_PI_VERSION',
  'LANGSMITH_PI_PROJECT',
] as const;

export interface ManifestFlagExtras {
  agentProvider?: string;
  tracingEnabled?: boolean;
  privacyLevel?: string;
  observabilityDegraded?: boolean;
}

export function collectManifestFeatureFlags(
  env: Record<string, string | undefined>,
  extras: ManifestFlagExtras = {}
): Record<string, string | number | boolean> {
  const flags: Record<string, string | number | boolean> = {};
  for (const key of MANIFEST_FLAG_KEYS) {
    const value = env[key];
    if (value !== undefined && value !== '') flags[key] = value;
  }
  const trace = env.TRACE_TO_LANGSMITH;
  if (trace !== undefined) {
    flags.TRACE_TO_LANGSMITH = trace === '1' || trace.toLowerCase() === 'true';
  }
  if (extras.agentProvider) flags.agentProvider = extras.agentProvider;
  if (extras.tracingEnabled !== undefined) flags.tracingEnabled = extras.tracingEnabled;
  if (extras.privacyLevel) flags.privacyLevel = extras.privacyLevel;
  if (extras.observabilityDegraded !== undefined) {
    flags.observabilityDegraded = extras.observabilityDegraded;
  }
  return flags;
}
```

- [ ] **步骤 8：运行测试确认通过**

运行：`bun test packages/shared/src/manifest/feature-flags.test.ts`
预期：PASS。

- [ ] **步骤 9：Commit**

```bash
git add packages/shared/src/manifest/hash.ts packages/shared/src/manifest/feature-flags.ts packages/shared/src/manifest/hash.test.ts packages/shared/src/manifest/feature-flags.test.ts
git commit -m "feat(manifest): add registry fingerprint and feature-flag collection (#21)"
```

## 任务 3：Manifest Builder（含 redact 与 hash）

**文件：**
- 创建：`packages/shared/src/manifest/builder.ts`
- 测试：`packages/shared/src/manifest/builder.test.ts`

- [ ] **步骤 1：编写失败的测试 `builder.test.ts`**

```ts
import { describe, expect, it } from 'bun:test';
import type { RunManifestCaptureRequest } from '@finagent/core';
import { buildRunManifest, type RunManifestCaptureContext } from './builder.ts';
import { shortHash } from './hash.ts';

function context(overrides: Partial<RunManifestCaptureContext> = {}): RunManifestCaptureContext {
  return {
    app: { version: '0.4.0-beta.2', build: 'abc123', channel: 'beta' },
    runtime: {
      mode: 'pi-runtime',
      provider: 'anthropic',
      model: 'claude-sonnet-4',
      thinkingLevel: 'high',
      extensions: ['finagent.ts'],
    },
    tools: {
      registryFingerprint: 'deadbeefdeadbeef',
      capabilityIds: ['market.quote'],
      toolNames: ['get_quote'],
    },
    retrieval: { provider: 'none' },
    featureFlags: { FINAGENT_AGENT_PROVIDER: 'pi-runtime' },
    ...overrides,
  };
}

function request(overrides: Partial<RunManifestCaptureRequest> = {}): RunManifestCaptureRequest {
  return { runId: 'run-1', kind: 'agent', sessionId: 's1', ...overrides };
}

describe('buildRunManifest', () => {
  it('is deterministic for identical input and fixed now', () => {
    const input = { request: request(), context: context(), now: 1_700_000_000_000 };
    expect(buildRunManifest(input)).toEqual(buildRunManifest(input));
  });

  it('hashes prompt parts and never stores prompt text', () => {
    const prompt = {
      templateVersion: 'pi-agent-prompt@1',
      systemText: 'SYSTEM LINES',
      skillIndexText: 'SKILLS',
      text: 'SYSTEM LINES\nUser request: hello',
    };
    const manifest = buildRunManifest({
      request: request({ locale: 'zh-CN' }),
      context: context(),
      prompt,
      now: 1,
    });
    expect(manifest.prompt).toEqual({
      templateVersion: 'pi-agent-prompt@1',
      systemHash: shortHash('SYSTEM LINES'),
      skillIndexHash: shortHash('SKILLS'),
      fullPromptHash: shortHash(prompt.text),
      promptLength: prompt.text.length,
      locale: 'zh-CN',
    });
    expect(JSON.stringify(manifest)).not.toContain('User request: hello');
  });

  it('redacts secret-shaped strings anywhere in the manifest', () => {
    const manifest = buildRunManifest({
      request: request(),
      context: context({
        featureFlags: { LANGSMITH_PI_PROJECT: 'sk-ant-canary-1234567890' },
        runtime: {
          mode: 'pi-runtime',
          model: 'sk-ant-canary-1234567890',
          extensions: [],
        },
      }),
      now: 1,
    });
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain('canary-1234567890');
    expect(serialized).toContain('[REDACTED]');
  });

  it('captures workspace, budget limits, research and evaluation slots', () => {
    const manifest = buildRunManifest({
      request: request({
        workspaceContext: { activeSymbol: 'NVDA.US', activeView: 'chart' },
        budgetLimits: { toolCalls: 12 },
        research: { strategyId: 'value', plannedCapabilities: ['company.valuation'] },
        evaluation: { datasetId: 'folio-agent-v1', datasetVersion: '1.0.0', caseId: 'fv1-research-001' },
      }),
      context: context(),
      now: 42,
    });
    expect(manifest.createdAt).toBe(42);
    expect(manifest.context).toEqual({
      sessionId: 's1',
      workspace: { activeSymbol: 'NVDA.US', activeView: 'chart' },
    });
    expect(manifest.budget).toEqual({ limits: { toolCalls: 12 } });
    expect(manifest.research).toEqual({
      strategyId: 'value',
      plannedCapabilities: ['company.valuation'],
    });
    expect(manifest.evaluation).toEqual({
      datasetId: 'folio-agent-v1',
      datasetVersion: '1.0.0',
      caseId: 'fv1-research-001',
    });
  });

  it('omits optional sections when absent', () => {
    const manifest = buildRunManifest({ request: request(), context: context(), now: 1 });
    expect(manifest.prompt).toBeUndefined();
    expect(manifest.budget).toBeUndefined();
    expect(manifest.evaluation).toBeUndefined();
    expect(manifest.research).toBeUndefined();
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`bun test packages/shared/src/manifest/builder.test.ts`
预期：FAIL（模块不存在）。

- [ ] **步骤 3：实现 `builder.ts`**

```ts
import {
  RUN_MANIFEST_SCHEMA_VERSION,
  type AgentPromptDescriptor,
  type RunManifest,
  type RunManifestCaptureRequest,
  type RunManifestPrompt,
} from '@finagent/core';
import { redact } from '../diagnostics/redact.ts';
import { shortHash } from './hash.ts';

/** Host-static context captured once per manifest (app/runtime/tools/flags). */
export interface RunManifestCaptureContext {
  app: RunManifest['app'];
  runtime: RunManifest['runtime'];
  tools: RunManifest['tools'];
  retrieval: RunManifest['retrieval'];
  featureFlags: RunManifest['featureFlags'];
}

export interface BuildRunManifestInput {
  request: RunManifestCaptureRequest;
  context: RunManifestCaptureContext;
  prompt?: AgentPromptDescriptor;
  now: number;
}

/** Pure: capture input → immutable manifest. Hashes prompt parts, redacts all strings. */
export function buildRunManifest(input: BuildRunManifestInput): RunManifest {
  const { request, context } = input;
  const manifest: RunManifest = {
    schemaVersion: RUN_MANIFEST_SCHEMA_VERSION,
    runId: request.runId,
    kind: request.kind,
    createdAt: input.now,
    app: { ...context.app },
    runtime: { ...context.runtime, extensions: [...context.runtime.extensions] },
    tools: {
      registryFingerprint: context.tools.registryFingerprint,
      capabilityIds: [...context.tools.capabilityIds],
      toolNames: [...context.tools.toolNames],
    },
    retrieval: request.retrieval ?? context.retrieval,
    featureFlags: { ...context.featureFlags },
  };
  if (input.prompt) manifest.prompt = promptInfo(input.prompt, request.locale);
  if (request.research) {
    manifest.research = {
      ...request.research,
      plannedCapabilities: [...request.research.plannedCapabilities],
    };
  }
  if (request.evaluation) manifest.evaluation = { ...request.evaluation };
  const limits = request.budgetLimits ?? {};
  if (Object.keys(limits).length > 0) manifest.budget = { limits: { ...limits } };
  const manifestContext: RunManifest['context'] = {};
  if (request.sessionId) manifestContext.sessionId = request.sessionId;
  if (request.workspaceContext) manifestContext.workspace = { ...request.workspaceContext };
  if (request.locale) manifestContext.locale = request.locale;
  if (Object.keys(manifestContext).length > 0) manifest.context = manifestContext;
  return redactDeep(manifest);
}

function promptInfo(
  prompt: AgentPromptDescriptor,
  locale: RunManifestPrompt['locale']
): RunManifestPrompt {
  return {
    templateVersion: prompt.templateVersion,
    systemHash: shortHash(prompt.systemText),
    ...(prompt.skillIndexText ? { skillIndexHash: shortHash(prompt.skillIndexText) } : {}),
    fullPromptHash: shortHash(prompt.text),
    promptLength: prompt.text.length,
    ...(locale ? { locale } : {}),
  };
}

function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map((entry) => redactDeep(entry)) as T;
  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined) continue;
      output[key] = redactDeep(entry);
    }
    return output as T;
  }
  return value;
}
```

- [ ] **步骤 4：运行测试确认通过**

运行：`bun test packages/shared/src/manifest/builder.test.ts`
预期：PASS（5 个测试）。

- [ ] **步骤 5：Commit**

```bash
git add packages/shared/src/manifest/builder.ts packages/shared/src/manifest/builder.test.ts
git commit -m "feat(manifest): add pure manifest builder with hashing and redaction (#21)"
```

---

## 任务 4：Manifest Repository（持久化 + append-only finalize）

**文件：**
- 创建：`packages/shared/src/manifest/repository.ts`
- 测试：`packages/shared/src/manifest/repository.test.ts`

- [ ] **步骤 1：编写失败的测试 `repository.test.ts`**

```ts
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { RunManifest } from '@finagent/core';
import { JsonFileStore } from '../storage/json-file-store.ts';
import { RunManifestRepository } from './repository.ts';

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'finagent-manifest-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function manifest(runId: string, createdAt: number, overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    schemaVersion: 1,
    runId,
    kind: 'agent',
    createdAt,
    app: { version: '0.4.0-beta.2', build: 'abc', channel: 'beta' },
    runtime: { mode: 'pi-runtime', provider: 'anthropic', model: 'claude-sonnet-4', extensions: [] },
    tools: { registryFingerprint: 'fp', capabilityIds: ['market.quote'], toolNames: ['get_quote'] },
    retrieval: { provider: 'none' },
    featureFlags: {},
    ...overrides,
  };
}

describe('RunManifestRepository', () => {
  it('saves, reads and lists newest first', async () => {
    const repository = new RunManifestRepository(new JsonFileStore(dir));
    await repository.save(manifest('run-a', 100));
    await repository.save(manifest('run-b', 200));

    expect((await repository.get('run-a'))?.runId).toBe('run-a');
    expect((await repository.list()).map((entry) => entry.runId)).toEqual(['run-b', 'run-a']);
    expect((await repository.list(1)).map((entry) => entry.runId)).toEqual(['run-b']);
  });

  it('finalize appends outcome and budget usage without touching captured config', async () => {
    const repository = new RunManifestRepository(new JsonFileStore(dir));
    await repository.save(manifest('run-a', 100, { budget: { limits: { toolCalls: 5 } } }));

    await repository.finalize(
      'run-a',
      { status: 'completed', finishedAt: 300, reportId: 'report-x' },
      { usage: { toolCalls: 2 }, stopReason: 'completed' }
    );

    const saved = await repository.get('run-a');
    expect(saved?.runtime.model).toBe('claude-sonnet-4');
    expect(saved?.budget).toEqual({
      limits: { toolCalls: 5 },
      usage: { toolCalls: 2 },
      stopReason: 'completed',
    });
    expect(saved?.outcome).toEqual({ status: 'completed', finishedAt: 300, reportId: 'report-x' });
    expect((await repository.list())[0].status).toBe('completed');
  });

  it('reads original config after a restart (new repository instance)', async () => {
    await new RunManifestRepository(new JsonFileStore(dir)).save(manifest('run-a', 100));
    await new RunManifestRepository(new JsonFileStore(dir)).finalize('run-a', { status: 'failed', finishedAt: 1 });
    const reopened = await new RunManifestRepository(new JsonFileStore(dir)).get('run-a');
    expect(reopened?.runtime.model).toBe('claude-sonnet-4');
    expect(reopened?.outcome?.status).toBe('failed');
  });

  it('returns undefined for a corrupt manifest without throwing', async () => {
    const errors: unknown[] = [];
    const repository = new RunManifestRepository(new JsonFileStore(dir), {
      onError: (error) => errors.push(error),
    });
    await mkdir(join(dir, 'manifests'), { recursive: true });
    await writeFile(join(dir, 'manifests', 'run-a.json'), '{not-json', 'utf8');

    await expect(repository.get('run-a')).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`bun test packages/shared/src/manifest/repository.test.ts`
预期：FAIL（模块不存在）。

- [ ] **步骤 3：实现 `repository.ts`**

```ts
import type {
  RunManifest,
  RunManifestBudgetOutcome,
  RunManifestOutcome,
  RunManifestSummary,
} from '@finagent/core';
import type { JsonFileStore } from '../storage/json-file-store.ts';

/**
 * Manifest persistence under the injected store root:
 *
 *   manifests/<runId>.json   — full immutable RunManifest (outcome appended)
 *   manifests/index.json     — RunManifestSummary[] newest first
 */

const INDEX_FILE = 'manifests/index.json';
const manifestFile = (runId: string) => `manifests/${runId}.json`;

interface IndexFile {
  manifests: RunManifestSummary[];
}

export interface RunManifestRepositoryOptions {
  onError?: (error: unknown) => void;
}

export class RunManifestRepository {
  private readonly store: JsonFileStore;
  private readonly onError?: (error: unknown) => void;

  constructor(store: JsonFileStore, options: RunManifestRepositoryOptions = {}) {
    this.store = store;
    this.onError = options.onError;
  }

  async save(manifest: RunManifest): Promise<void> {
    await this.store.write(manifestFile(manifest.runId), manifest);
    const index = await this.store.read<IndexFile>(INDEX_FILE, { manifests: [] });
    const summary = toSummary(manifest);
    await this.store.write(INDEX_FILE, {
      manifests: [summary, ...index.manifests.filter((entry) => entry.runId !== manifest.runId)],
    });
  }

  async get(runId: string): Promise<RunManifest | undefined> {
    try {
      return await this.store.read<RunManifest | undefined>(manifestFile(runId), undefined);
    } catch (error) {
      this.onError?.(error);
      return undefined;
    }
  }

  async list(limit = 100): Promise<RunManifestSummary[]> {
    try {
      const index = await this.store.read<IndexFile>(INDEX_FILE, { manifests: [] });
      return index.manifests.slice(0, Math.max(0, limit));
    } catch (error) {
      this.onError?.(error);
      return [];
    }
  }

  async finalize(
    runId: string,
    outcome: RunManifestOutcome,
    budget?: RunManifestBudgetOutcome
  ): Promise<void> {
    const manifest = await this.get(runId);
    if (!manifest) return;
    manifest.outcome = outcome;
    if (budget && (budget.usage || budget.stopReason || budget.stopDetail)) {
      const limits = manifest.budget?.limits ?? {};
      manifest.budget = { ...budget, limits };
    }
    await this.save(manifest);
  }
}

function toSummary(manifest: RunManifest): RunManifestSummary {
  return {
    runId: manifest.runId,
    kind: manifest.kind,
    createdAt: manifest.createdAt,
    runtimeMode: manifest.runtime.mode,
    ...(manifest.runtime.provider ? { provider: manifest.runtime.provider } : {}),
    ...(manifest.runtime.model ? { model: manifest.runtime.model } : {}),
    ...(manifest.outcome?.status ? { status: manifest.outcome.status } : {}),
  };
}
```

- [ ] **步骤 4：运行测试确认通过**

运行：`bun test packages/shared/src/manifest/repository.test.ts`
预期：PASS（4 个测试）。

- [ ] **步骤 5：Commit**

```bash
git add packages/shared/src/manifest/repository.ts packages/shared/src/manifest/repository.test.ts
git commit -m "feat(manifest): add manifest repository with append-only finalize (#21)"
```

## 任务 5：Manifest Diff（纯函数）

**文件：**
- 创建：`packages/shared/src/manifest/diff.ts`
- 测试：`packages/shared/src/manifest/diff.test.ts`

- [ ] **步骤 1：编写失败的测试 `diff.test.ts`**

```ts
import { describe, expect, it } from 'bun:test';
import type { RunManifest } from '@finagent/core';
import { diffRunManifests } from './diff.ts';

function makeManifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    schemaVersion: 1,
    runId: 'run-a',
    kind: 'agent',
    createdAt: 100,
    app: { version: '0.4.0-beta.2', build: 'abc', channel: 'beta' },
    runtime: {
      mode: 'pi-runtime',
      provider: 'anthropic',
      model: 'claude-sonnet-4',
      thinkingLevel: 'high',
      extensions: ['finagent.ts'],
    },
    prompt: {
      templateVersion: 'pi-agent-prompt@1',
      systemHash: 's1',
      fullPromptHash: 'f1',
      promptLength: 10,
    },
    tools: {
      registryFingerprint: 'fp',
      capabilityIds: ['market.quote', 'research.news'],
      toolNames: ['get_quote', 'get_news'],
    },
    retrieval: { provider: 'none' },
    featureFlags: { FINAGENT_AGENT_PROVIDER: 'pi-runtime' },
    ...overrides,
  };
}

describe('diffRunManifests', () => {
  it('returns [] for identical manifests', () => {
    expect(diffRunManifests(makeManifest(), makeManifest())).toEqual([]);
  });

  it('detects model, thinking level and extension changes', () => {
    const before = makeManifest();
    const after = makeManifest();
    after.runtime = { ...after.runtime, model: 'claude-opus-4', thinkingLevel: 'low' };
    after.runtime.extensions = ['finagent.ts', 'langsmith.ts'];

    const changes = diffRunManifests(before, after);
    expect(changes).toContainEqual({ category: 'runtime', path: 'runtime.model', before: 'claude-sonnet-4', after: 'claude-opus-4' });
    expect(changes).toContainEqual({ category: 'runtime', path: 'runtime.thinkingLevel', before: 'high', after: 'low' });
    expect(changes).toContainEqual({ category: 'runtime', path: 'runtime.extensions', added: ['langsmith.ts'] });
  });

  it('detects prompt and capability changes, ignoring array order', () => {
    const before = makeManifest();
    const reordered = makeManifest();
    reordered.tools = { ...reordered.tools, capabilityIds: ['research.news', 'market.quote'] };
    expect(diffRunManifests(before, reordered)).toEqual([]);

    const after = makeManifest();
    after.prompt = { ...after.prompt!, fullPromptHash: 'f2' };
    after.tools = { ...after.tools, capabilityIds: ['market.quote', 'company.valuation'], toolNames: ['get_quote', 'get_valuation'] };

    const changes = diffRunManifests(before, after);
    expect(changes).toContainEqual({ category: 'prompt', path: 'prompt.fullPromptHash', before: 'f1', after: 'f2' });
    expect(changes).toContainEqual({
      category: 'tools',
      path: 'tools.capabilityIds',
      added: ['company.valuation'],
      removed: ['research.news'],
    });
    expect(changes).toContainEqual({ category: 'tools', path: 'tools.toolNames', added: ['get_valuation'], removed: ['get_news'] });
  });

  it('detects flag and budget-limit changes', () => {
    const before = makeManifest({ budget: { limits: { toolCalls: 5 } } });
    const after = makeManifest({ budget: { limits: { toolCalls: 9 } } });
    after.featureFlags = { ...after.featureFlags, tracingEnabled: true };

    const changes = diffRunManifests(before, after);
    expect(changes).toContainEqual({ category: 'flags', path: 'flags.tracingEnabled', after: true });
    expect(changes).toContainEqual({ category: 'budget', path: 'budget.limits.toolCalls', before: 5, after: 9 });
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`bun test packages/shared/src/manifest/diff.test.ts`
预期：FAIL（模块不存在）。

- [ ] **步骤 3：实现 `diff.ts`**

```ts
import type { RunManifest } from '@finagent/core';

export type RunManifestCategory =
  | 'app'
  | 'runtime'
  | 'prompt'
  | 'tools'
  | 'research'
  | 'retrieval'
  | 'flags'
  | 'evaluation'
  | 'context'
  | 'budget';

/** One config difference between two manifests; outcome is never diffed. */
export interface RunManifestChange {
  category: RunManifestCategory;
  path: string;
  before?: unknown;
  after?: unknown;
  added?: string[];
  removed?: string[];
}

export function diffRunManifests(before: RunManifest, after: RunManifest): RunManifestChange[] {
  const changes: RunManifestChange[] = [];

  scalar(changes, 'app', 'app.version', before.app.version, after.app.version);
  scalar(changes, 'app', 'app.build', before.app.build, after.app.build);
  scalar(changes, 'app', 'app.channel', before.app.channel, after.app.channel);

  scalar(changes, 'runtime', 'runtime.mode', before.runtime.mode, after.runtime.mode);
  scalar(changes, 'runtime', 'runtime.provider', before.runtime.provider, after.runtime.provider);
  scalar(changes, 'runtime', 'runtime.model', before.runtime.model, after.runtime.model);
  scalar(changes, 'runtime', 'runtime.thinkingLevel', before.runtime.thinkingLevel, after.runtime.thinkingLevel);
  scalar(changes, 'runtime', 'runtime.modelParams', before.runtime.modelParams, after.runtime.modelParams);
  setDiff(changes, 'runtime', 'runtime.extensions', before.runtime.extensions, after.runtime.extensions);

  scalar(changes, 'prompt', 'prompt.templateVersion', before.prompt?.templateVersion, after.prompt?.templateVersion);
  scalar(changes, 'prompt', 'prompt.systemHash', before.prompt?.systemHash, after.prompt?.systemHash);
  scalar(changes, 'prompt', 'prompt.skillIndexHash', before.prompt?.skillIndexHash, after.prompt?.skillIndexHash);
  scalar(changes, 'prompt', 'prompt.fullPromptHash', before.prompt?.fullPromptHash, after.prompt?.fullPromptHash);

  scalar(changes, 'tools', 'tools.registryFingerprint', before.tools.registryFingerprint, after.tools.registryFingerprint);
  setDiff(changes, 'tools', 'tools.capabilityIds', before.tools.capabilityIds, after.tools.capabilityIds);
  setDiff(changes, 'tools', 'tools.toolNames', before.tools.toolNames, after.tools.toolNames);

  scalar(changes, 'research', 'research.strategyId', before.research?.strategyId, after.research?.strategyId);
  setDiff(
    changes,
    'research',
    'research.plannedCapabilities',
    before.research?.plannedCapabilities,
    after.research?.plannedCapabilities
  );

  scalar(changes, 'retrieval', 'retrieval.provider', before.retrieval.provider, after.retrieval.provider);
  scalar(changes, 'retrieval', 'retrieval.configVersion', before.retrieval.configVersion, after.retrieval.configVersion);

  flagsDiff(changes, before.featureFlags, after.featureFlags);

  scalar(changes, 'evaluation', 'evaluation.datasetId', before.evaluation?.datasetId, after.evaluation?.datasetId);
  scalar(changes, 'evaluation', 'evaluation.datasetVersion', before.evaluation?.datasetVersion, after.evaluation?.datasetVersion);
  scalar(changes, 'evaluation', 'evaluation.caseId', before.evaluation?.caseId, after.evaluation?.caseId);

  scalar(changes, 'context', 'context.workspace', before.context?.workspace, after.context?.workspace);

  const beforeLimits = before.budget?.limits ?? {};
  const afterLimits = after.budget?.limits ?? {};
  for (const key of [...new Set([...Object.keys(beforeLimits), ...Object.keys(afterLimits)])].sort()) {
    scalar(changes, 'budget', `budget.limits.${key}`, beforeLimits[key], afterLimits[key]);
  }

  return changes;
}

function scalar(
  changes: RunManifestChange[],
  category: RunManifestCategory,
  path: string,
  before: unknown,
  after: unknown
): void {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  changes.push({
    category,
    path,
    ...(before !== undefined ? { before } : {}),
    ...(after !== undefined ? { after } : {}),
  });
}

function setDiff(
  changes: RunManifestChange[],
  category: RunManifestCategory,
  path: string,
  before: readonly string[] | undefined,
  after: readonly string[] | undefined
): void {
  const beforeSet = new Set(before ?? []);
  const afterSet = new Set(after ?? []);
  const added = [...afterSet].filter((entry) => !beforeSet.has(entry)).sort();
  const removed = [...beforeSet].filter((entry) => !afterSet.has(entry)).sort();
  if (added.length === 0 && removed.length === 0) return;
  changes.push({
    category,
    path,
    ...(added.length > 0 ? { added } : {}),
    ...(removed.length > 0 ? { removed } : {}),
  });
}

function flagsDiff(
  changes: RunManifestChange[],
  before: Record<string, string | number | boolean>,
  after: Record<string, string | number | boolean>
): void {
  for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    scalar(changes, 'flags', `flags.${key}`, before[key], after[key]);
  }
}
```

- [ ] **步骤 4：运行测试确认通过**

运行：`bun test packages/shared/src/manifest/diff.test.ts`
预期：PASS（4 个测试）。

- [ ] **步骤 5：Commit**

```bash
git add packages/shared/src/manifest/diff.ts packages/shared/src/manifest/diff.test.ts
git commit -m "feat(manifest): add deterministic run manifest diff (#21)"
```

---

## 任务 6：Manifest Service 与模块导出

**文件：**
- 创建：`packages/shared/src/manifest/service.ts`
- 创建：`packages/shared/src/manifest/index.ts`
- 修改：`packages/shared/src/index.ts`（barrel 导出）
- 修改：`packages/shared/package.json`（`./manifest` subpath）
- 测试：`packages/shared/src/manifest/service.test.ts`

- [ ] **步骤 1：编写失败的测试 `service.test.ts`**

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { AgentPromptDescriptor } from '@finagent/core';
import { JsonFileStore } from '../storage/json-file-store.ts';
import { RunManifestRepository } from './repository.ts';
import { RunManifestService } from './service.ts';
import type { RunManifestCaptureContext } from './builder.ts';

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'finagent-manifest-svc-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function context(): RunManifestCaptureContext {
  return {
    app: { version: '0.4.0-beta.2', build: 'abc', channel: 'beta' },
    runtime: { mode: 'pi-runtime', provider: 'anthropic', model: 'claude-sonnet-4', extensions: [] },
    tools: { registryFingerprint: 'fp', capabilityIds: ['market.quote'], toolNames: ['get_quote'] },
    retrieval: { provider: 'none' },
    featureFlags: {},
  };
}

const prompt: AgentPromptDescriptor = {
  templateVersion: 'pi-agent-prompt@1',
  systemText: 'SYSTEM',
  text: 'SYSTEM\nUser request: hello',
};

function makeService(options: {
  describePrompt?: () => Promise<AgentPromptDescriptor | undefined>;
  captureContext?: () => RunManifestCaptureContext;
  repository?: RunManifestRepository;
  onError?: (error: unknown) => void;
}) {
  return new RunManifestService({
    repository: options.repository ?? new RunManifestRepository(new JsonFileStore(dir)),
    captureContext: options.captureContext ?? (() => context()),
    ...(options.describePrompt ? { describePrompt: options.describePrompt } : {}),
    now: () => 1_700_000_000_000,
    ...(options.onError ? { onError: options.onError } : {}),
  });
}

describe('RunManifestService', () => {
  it('captures a manifest with hashed prompt and finalizes the outcome', async () => {
    const service = makeService({ describePrompt: async () => prompt });
    await service.capture({ runId: 'run-1', kind: 'agent', sessionId: 's1', content: 'hello' });

    const saved = await service.get('run-1');
    expect(saved?.prompt?.fullPromptHash).toMatch(/^[0-9a-f]{16}$/);
    expect(saved?.outcome).toBeUndefined();

    await service.finalize('run-1', { status: 'completed', finishedAt: 5 }, { usage: { toolCalls: 1 } });
    const finalized = await service.get('run-1');
    expect(finalized?.outcome?.status).toBe('completed');
    expect(finalized?.budget?.usage).toEqual({ toolCalls: 1 });
  });

  it('never throws when capture context or describePrompt fails', async () => {
    const errors: unknown[] = [];
    const service = makeService({
      captureContext: () => {
        throw new Error('context down');
      },
      onError: (error) => errors.push(error),
    });
    await expect(service.capture({ runId: 'run-1', kind: 'agent' })).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);

    const service2 = makeService({
      describePrompt: async () => {
        throw new Error('prompt down');
      },
      onError: (error) => errors.push(error),
    });
    await expect(service2.capture({ runId: 'run-2', kind: 'agent', content: 'x' })).resolves.toBeUndefined();
    expect(await service2.get('run-2')).toBeDefined();
    expect((await service2.get('run-2'))?.prompt).toBeUndefined();
  });

  it('diffs two saved manifests and returns [] when one side is missing', async () => {
    const service = makeService({});
    await service.capture({ runId: 'run-1', kind: 'agent' });
    await service.capture({ runId: 'run-2', kind: 'research', research: { strategyId: 'value', plannedCapabilities: [] } });

    const changes = await service.diff('run-1', 'run-2');
    expect(changes).toContainEqual({ category: 'research', path: 'research.strategyId', after: 'value' });
    expect(await service.diff('run-1', 'missing')).toEqual([]);
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`bun test packages/shared/src/manifest/service.test.ts`
预期：FAIL（模块不存在）。

- [ ] **步骤 3：实现 `service.ts`**

```ts
import type {
  AgentPromptDescriptor,
  RunManifest,
  RunManifestBudgetOutcome,
  RunManifestCaptureRequest,
  RunManifestOutcome,
  RunManifestRecorder,
  RunManifestSummary,
} from '@finagent/core';
import { buildRunManifest, type RunManifestCaptureContext } from './builder.ts';
import { diffRunManifests, type RunManifestChange } from './diff.ts';
import type { RunManifestRepository } from './repository.ts';

export interface RunManifestServiceOptions {
  repository: RunManifestRepository;
  captureContext: () => Promise<RunManifestCaptureContext> | RunManifestCaptureContext;
  describePrompt?: (request: RunManifestCaptureRequest) => Promise<AgentPromptDescriptor | undefined>;
  now?: () => number;
  onError?: (error: unknown) => void;
}

/**
 * Best-effort manifest recorder: capture/finalize never throw and never block a
 * run. Errors are reported through `onError` (main-process diagnostics).
 */
export class RunManifestService implements RunManifestRecorder {
  private readonly repository: RunManifestRepository;
  private readonly captureContext: () => Promise<RunManifestCaptureContext> | RunManifestCaptureContext;
  private readonly describePrompt?: (request: RunManifestCaptureRequest) => Promise<AgentPromptDescriptor | undefined>;
  private readonly now: () => number;
  private readonly onError?: (error: unknown) => void;

  constructor(options: RunManifestServiceOptions) {
    this.repository = options.repository;
    this.captureContext = options.captureContext;
    this.describePrompt = options.describePrompt;
    this.now = options.now ?? Date.now;
    this.onError = options.onError;
  }

  async capture(request: RunManifestCaptureRequest): Promise<void> {
    try {
      const context = await this.captureContext();
      let prompt: AgentPromptDescriptor | undefined;
      try {
        prompt = await this.describePrompt?.(request);
      } catch (error) {
        this.onError?.(error);
      }
      const manifest = buildRunManifest({ request, context, prompt, now: this.now() });
      await this.repository.save(manifest);
    } catch (error) {
      this.onError?.(error);
    }
  }

  async finalize(
    runId: string,
    outcome: RunManifestOutcome,
    budget?: RunManifestBudgetOutcome
  ): Promise<void> {
    try {
      await this.repository.finalize(runId, outcome, budget);
    } catch (error) {
      this.onError?.(error);
    }
  }

  async get(runId: string): Promise<RunManifest | undefined> {
    return this.repository.get(runId);
  }

  async list(limit?: number): Promise<RunManifestSummary[]> {
    return this.repository.list(limit);
  }

  async diff(beforeRunId: string, afterRunId: string): Promise<RunManifestChange[]> {
    const [before, after] = await Promise.all([
      this.repository.get(beforeRunId),
      this.repository.get(afterRunId),
    ]);
    if (!before || !after) return [];
    return diffRunManifests(before, after);
  }
}
```

- [ ] **步骤 4：创建 `packages/shared/src/manifest/index.ts`**

```ts
export { buildRunManifest, type BuildRunManifestInput, type RunManifestCaptureContext } from './builder.ts';
export { diffRunManifests, type RunManifestCategory, type RunManifestChange } from './diff.ts';
export { collectManifestFeatureFlags, MANIFEST_FLAG_KEYS, type ManifestFlagExtras } from './feature-flags.ts';
export { fingerprintTools, shortHash, type FingerprintableCapability, type ToolFingerprint } from './hash.ts';
export { RunManifestRepository, type RunManifestRepositoryOptions } from './repository.ts';
export { RunManifestService, type RunManifestServiceOptions } from './service.ts';
```

- [ ] **步骤 5：接线导出**

`packages/shared/src/index.ts` 在 `export * from './diagnostics/index.ts';` 之后加入：

```ts
export * from './manifest/index.ts';
```

`packages/shared/package.json` 的 `exports` 中，在 `"./diagnostics"` 之后加入：

```json
    "./manifest": "./src/manifest/index.ts",
```

- [ ] **步骤 6：运行测试确认通过**

运行：`bun test packages/shared/src/manifest/service.test.ts`
预期：PASS（3 个测试）。

- [ ] **步骤 7：typecheck**

运行：`cd packages/shared && bun run typecheck`
预期：无错误。

- [ ] **步骤 8：Commit**

```bash
git add packages/shared/src/manifest/service.ts packages/shared/src/manifest/index.ts packages/shared/src/manifest/service.test.ts packages/shared/src/index.ts packages/shared/package.json
git commit -m "feat(manifest): add best-effort manifest service and module exports (#21)"
```

## 任务 7：Prompt 描述符（`buildAgentPrompt` + `describePrompt`）

**文件：**
- 修改：`packages/shared/src/agent/pi-runtime-adapter.ts`
- 测试：`packages/shared/src/agent/agent-prompt.test.ts`（新建）

- [ ] **步骤 1：编写失败的测试 `agent-prompt.test.ts`**

```ts
import { describe, expect, it } from 'bun:test';
import { PiRuntimeAdapter } from './pi-runtime-adapter.ts';
import {
  AGENT_PROMPT_TEMPLATE_VERSION,
  buildAgentPrompt,
} from './pi-runtime-adapter.ts';

describe('buildAgentPrompt', () => {
  it('is deterministic and exposes stable prompt parts', () => {
    const input = { content: 'hello', locale: 'en-US' as const };
    const first = buildAgentPrompt(input);
    const second = buildAgentPrompt(input);
    expect(first).toEqual(second);
    expect(first.templateVersion).toBe(AGENT_PROMPT_TEMPLATE_VERSION);
    expect(first.systemText).toContain('You are Finagent, a finance agent backend.');
    expect(first.text).toContain('User request: hello');
    expect(first.text).toContain('Preferred response language: English');
    expect(first.skillIndexText).toBeUndefined();
  });

  it('injects workspace context and recent symbols', () => {
    const prompt = buildAgentPrompt({
      content: '最近走势怎么样？',
      recentSymbols: ['NVDA.US'],
      workspaceContext: { activeSymbol: 'NVDA.US', activeView: 'chart' },
    });
    expect(prompt.text).toContain('Active symbol: NVDA.US');
    expect(prompt.text).toContain('Active workspace view: chart');
    expect(prompt.text).toContain('use the active symbol above');
    expect(prompt.text).toContain('Recent symbols: NVDA.US');
  });

  it('changes fullPromptHash when only the locale changes, keeping templateVersion', () => {
    const en = buildAgentPrompt({ content: 'x', locale: 'en-US' });
    const zh = buildAgentPrompt({ content: 'x', locale: 'zh-CN' });
    expect(zh.templateVersion).toBe(en.templateVersion);
    expect(zh.text).not.toBe(en.text);
  });
});

describe('PiRuntimeAdapter.describePrompt', () => {
  it('describes the prompt without spawning the runtime', async () => {
    const adapter = new PiRuntimeAdapter({ rpcClient: {} as never, sessionDir: '/tmp/manifest-test' });
    const descriptor = await adapter.describePrompt({
      sessionId: 's1',
      runId: 'r1',
      content: 'hello',
      workspaceContext: { activeSymbol: 'NVDA.US' },
    });
    expect(descriptor.templateVersion).toBe(AGENT_PROMPT_TEMPLATE_VERSION);
    expect(descriptor.text).toContain('Active symbol: NVDA.US');
    expect(descriptor.text).toContain('User request: hello');
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`bun test packages/shared/src/agent/agent-prompt.test.ts`
预期：FAIL（`buildAgentPrompt`/`describePrompt` 不存在）。

- [ ] **步骤 3：在 `pi-runtime-adapter.ts` 增加 import**

在顶部 type import 中 `AgentEvent,` 之后加入：

```ts
  AgentPromptDescriptor,
```

- [ ] **步骤 4：在类中 `getTools` 之后加入 `describePrompt`**

```ts
  /** Prompt descriptor for run manifests (#21); never spawns the runtime. */
  async describePrompt(input: AgentRunInput): Promise<AgentPromptDescriptor> {
    const state = this.sessions.get(input.sessionId);
    return buildAgentPrompt({
      content: input.content,
      recentSymbols: state?.recentSymbols ?? [],
      workspaceContext: input.workspaceContext,
      skillHub: this.skillHub,
      readinessProvider: this.readinessProvider,
      locale: input.locale,
    });
  }
```

- [ ] **步骤 5：替换 `runAttempt` 中的 prompt 调用（约 240-243 行）**

旧：

```ts
    const adapter = new PiEventAdapter({ sessionId: input.sessionId, runId: input.runId, now: this.now });
    const stream = this.rpcClient.promptStreaming(
      buildPrompt(input.content, state, input.workspaceContext, this.skillHub, this.readinessProvider, input.locale)
    );
```

新：

```ts
    const adapter = new PiEventAdapter({ sessionId: input.sessionId, runId: input.runId, now: this.now });
    const stream = this.rpcClient.promptStreaming(
      buildAgentPrompt({
        content: input.content,
        recentSymbols: state.recentSymbols,
        workspaceContext: input.workspaceContext,
        skillHub: this.skillHub,
        readinessProvider: this.readinessProvider,
        locale: input.locale,
      }).text
    );
```

- [ ] **步骤 6：用 `buildAgentPrompt` 替换 `buildPrompt`（471-521 行）**

```ts
export const AGENT_PROMPT_TEMPLATE_VERSION = 'pi-agent-prompt@1';

const STATIC_SYSTEM_LINES = [
  'You are Finagent, a finance agent backend.',
  'Use only registered finance tools for market, K-line, intraday, and portfolio data.',
  'Never construct LongBridge CLI commands directly.',
  'Plan, call tools, observe results, then provide the final answer.',
  'Keep the final answer concise and include risk/data-gap notes when relevant.',
  'When the user asks about market data, technicals, fundamentals, news, or portfolio analysis, consult the available skills below, then load the relevant skill file with read_skill_resource before acting on that subtopic.',
];

export interface AgentPromptInput {
  content: string;
  recentSymbols?: string[];
  workspaceContext?: WorkspaceContext;
  skillHub?: SkillHub;
  readinessProvider?: (skillId: string) => SkillReadiness | undefined;
  locale?: SupportedLocale;
}

/**
 * Single source of the Pi prompt (#21): the runtime sends `text`, and the
 * manifest keeps only `systemText`/`skillIndexText` hashes — never the prompt.
 */
export function buildAgentPrompt(input: AgentPromptInput): AgentPromptDescriptor {
  const symbols = input.recentSymbols ?? [];
  const recentSymbols = symbols.length > 0
    ? `\nRecent symbols: ${symbols.join(', ')}`
    : '';

  const workspaceLines: string[] = [];
  if (input.workspaceContext?.activeSymbol) {
    workspaceLines.push(`- Active symbol: ${input.workspaceContext.activeSymbol}`);
  }
  if (input.workspaceContext?.activeView) {
    workspaceLines.push(`- Active workspace view: ${input.workspaceContext.activeView}`);
  }
  if (input.workspaceContext?.selectedPosition) {
    workspaceLines.push(`- Selected position: ${input.workspaceContext.selectedPosition}`);
  }
  const workspaceSection = workspaceLines.length > 0
    ? `\nWorkspace context:\n${workspaceLines.join('\n')}\nWhen the user refers to "this", "the stock", or asks follow-up questions about a symbol without naming it, use the active symbol above.`
    : '';

  const skillSection = buildSkillIndexSection(input.skillHub, input.readinessProvider);

  // V8 (spec §41–43): one shared prompt + a stable response-language
  // instruction. Never fork the system prompt per language — only the
  // presentation instruction changes; an explicit user language request in
  // `content` always wins over this default.
  const localeInstruction = input.locale
    ? `\nPreferred response language: ${RUNTIME_LOCALE_NAMES[input.locale]} (use this language for your final answer unless the user explicitly asks for another; never translate ticker symbols, tool identifiers, data fields, or citations).`
    : '';

  const text = [
    ...STATIC_SYSTEM_LINES,
    workspaceSection,
    localeInstruction,
    skillSection,
    recentSymbols,
    '',
    `User request: ${input.content}`,
  ].filter((part) => part.trim().length > 0).join('\n');

  return {
    templateVersion: AGENT_PROMPT_TEMPLATE_VERSION,
    systemText: STATIC_SYSTEM_LINES.join('\n'),
    ...(skillSection.trim().length > 0 ? { skillIndexText: skillSection } : {}),
    text,
  };
}
```

- [ ] **步骤 7：运行测试确认通过**

运行：`bun test packages/shared/src/agent/agent-prompt.test.ts packages/shared/src/agent/workspace-context.test.ts`
预期：两组全部 PASS（既有 workspace-context 断言保持通过，证明 prompt 文本未变）。

- [ ] **步骤 8：Commit**

```bash
git add packages/shared/src/agent/pi-runtime-adapter.ts packages/shared/src/agent/agent-prompt.test.ts
git commit -m "refactor(agent): extract prompt descriptor for run manifests (#21)"
```

---

## 任务 8：RunManager 集成 recorder

**文件：**
- 修改：`packages/shared/src/kernel/run-manager.ts`
- 测试：`packages/shared/src/kernel/run-manager.test.ts`（追加）

- [ ] **步骤 1：追加失败的测试**

在 `run-manager.test.ts` 顶部 import 中补充 core 类型（加到现有 type import 列表）：

```ts
  RunManifestBudgetOutcome,
  RunManifestCaptureRequest,
  RunManifestOutcome,
  RunManifestRecorder,
```

在 `describe('RunManager', ...)` 内追加：

```ts
  it('captures and finalizes a run manifest through the recorder', async () => {
    const recorder = new RecordingRecorder();
    const { sessions, runs } = makeKernel(completedScript('Answer'), { manifests: recorder });
    const session = await sessions.createSession('A');

    const run = await runs.startRun(
      session.id,
      'hello',
      { activeSymbol: 'NVDA.US' },
      'zh-CN'
    );
    await waitFor(async () => !runs.isRunning());

    expect(recorder.captures).toHaveLength(1);
    expect(recorder.captures[0]).toMatchObject({
      runId: run.id,
      kind: 'agent',
      sessionId: session.id,
      locale: 'zh-CN',
      content: 'hello',
    });
    expect(recorder.finalizes).toHaveLength(1);
    expect(recorder.finalizes[0]).toMatchObject({
      runId: run.id,
      outcome: { status: 'completed' },
    });
  });

  it('records budget limits at capture and usage at finalize', async () => {
    const recorder = new RecordingRecorder();
    const { sessions, runs } = makeKernel(completedScript('Answer'), {
      manifests: recorder,
      budgets: { defaults: { toolCalls: 3 } },
    });
    const session = await sessions.createSession('A');

    await runs.startRun(session.id, 'hello');
    await waitFor(async () => !runs.isRunning());

    expect(recorder.captures[0].budgetLimits).toEqual({ toolCalls: 3 });
    expect(recorder.finalizes[0].budget?.usage?.toolCalls).toBe(1);
  });
```

在文件末尾（或其他 helper 区域）加入：

```ts
class RecordingRecorder implements RunManifestRecorder {
  captures: RunManifestCaptureRequest[] = [];
  finalizes: Array<{
    runId: string;
    outcome: RunManifestOutcome;
    budget?: RunManifestBudgetOutcome;
  }> = [];

  async capture(request: RunManifestCaptureRequest): Promise<void> {
    this.captures.push(request);
  }

  async finalize(
    runId: string,
    outcome: RunManifestOutcome,
    budget?: RunManifestBudgetOutcome
  ): Promise<void> {
    this.finalizes.push({ runId, outcome, budget });
  }
}
```

- [ ] **步骤 2：运行测试确认失败**

运行：`bun test packages/shared/src/kernel/run-manager.test.ts`
预期：FAIL（`manifests` 选项不存在，capture 未调用）。

- [ ] **步骤 3：修改 `run-manager.ts` — imports 与选项**

在 core type import 中追加：

```ts
  RunManifestBudgetOutcome,
  RunManifestCaptureExtras,
  RunManifestOutcome,
  RunManifestRecorder,
```

`RunManagerOptions` 增加（`runaway` 之后）：

```ts
  /** Immutable run manifests (#21). Best-effort: capture/finalize never block a run. */
  manifests?: RunManifestRecorder;
```

类字段与构造函数：

```ts
  private readonly manifests?: RunManifestRecorder;
```

```ts
    this.runawayPolicy = options.runaway ?? {};
    this.manifests = options.manifests;
```

- [ ] **步骤 4：`startRun` 增加 `manifestExtras` 参数并在 activeRun 建立后 capture**

签名（第 124-130 行）：

```ts
  async startRun(
    sessionId: string,
    content: string,
    workspaceContext?: WorkspaceContext,
    locale?: SupportedLocale,
    budgetOverrides?: RunBudgetLimits,
    manifestExtras?: RunManifestCaptureExtras
  ): Promise<Run> {
```

在 `this.activeRun = { ... }`（约 171-179 行）之后、`this.emit({...})` 之前加入：

```ts
    await this.manifests?.capture({
      runId: run.id,
      kind: 'agent',
      sessionId,
      content: text,
      ...(workspaceContext ? { workspaceContext } : {}),
      ...(locale ? { locale } : {}),
      ...(manifestExtras ?? {}),
      budgetLimits: toNumberRecord(limits),
    });
```

- [ ] **步骤 5：settle 时 finalize**

在 `await this.runs.update(run);`（约 275 行）之后加入：

```ts
    await this.manifests?.finalize(
      run.id,
      {
        status: run.status,
        finishedAt: now,
        ...(run.error?.code ? { errorCode: run.error.code } : {}),
      },
      {
        usage: toNumberRecord(active?.usage),
        ...(stop ? { stopReason: stop.stopReason, stopDetail: stop.detail } : {}),
      }
    );
```

在文件底部 helpers 区域（`collectSymbols` 附近）加入：

```ts
function toNumberRecord(
  source: Readonly<Partial<Record<string, number>>> | undefined
): Record<string, number> {
  const output: Record<string, number> = {};
  if (!source) return output;
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'number' && Number.isFinite(value)) output[key] = value;
  }
  return output;
}
```

- [ ] **步骤 6：运行测试确认通过**

运行：`bun test packages/shared/src/kernel/run-manager.test.ts`
预期：PASS（原有用例 + 2 个新用例）。

- [ ] **步骤 7：Commit**

```bash
git add packages/shared/src/kernel/run-manager.ts packages/shared/src/kernel/run-manager.test.ts
git commit -m "feat(kernel): record run manifests in RunManager (#21)"
```

---

## 任务 9：AgentKernel 透传 + Deep Research 集成

**文件：**
- 修改：`packages/shared/src/kernel/agent-kernel.ts`
- 修改：`packages/shared/src/research/service.ts`
- 修改：`packages/shared/src/research/runner.ts`
- 测试：`packages/shared/src/research/service.test.ts`（追加）

- [ ] **步骤 1：追加失败的测试（research service）**

`service.test.ts` import 补充：

```ts
import type {
  RunManifestBudgetOutcome,
  RunManifestCaptureRequest,
  RunManifestOutcome,
  RunManifestRecorder,
} from '@finagent/core';
import type { ResearchServiceOptions } from './service.ts';
```

`makeService` 增加可选参数（保持既有调用兼容）：

```ts
function makeService(
  capabilities: Array<[string, Parameters<typeof fakeCap>[1]?]>,
  extra: Partial<ResearchServiceOptions> = {}
) {
  const registry = createCapabilityRegistry(
    capabilities.map(([id, mode]) => fakeCap(id, mode ?? 'success'))
  );
  return new ResearchService({
    registry,
    synthesizer: new LocalResearchSynthesizer(),
    repository: new ResearchReportRepository(new JsonFileStore(dir)),
    now: () => 1_700_000_000_000,
    ...extra,
  });
}
```

`describe('ResearchService', ...)` 内追加：

```ts
  it('captures/finalizes a research manifest and stamps report.manifestId', async () => {
    const recorder = new RecordingRecorder();
    const strategy = RESEARCH_STRATEGIES.value;
    const service = makeService(
      strategy.capabilityIds.map((id) => [id, 'success' as const]),
      { manifests: recorder }
    );

    const queued = await service.start('NVDA.US', 'value');
    expect(await waitForTerminal(service, queued.id)).toBe('completed');

    const reports = await waitForReports(service, 'NVDA.US');
    expect(reports[0].manifestId).toBe(queued.id);

    expect(recorder.captures[0]).toMatchObject({ runId: queued.id, kind: 'research' });
    expect(recorder.captures[0].research?.strategyId).toBe('value');
    expect(recorder.captures[0].research?.plannedCapabilities).toEqual([...strategy.capabilityIds]);

    for (let i = 0; i < 100 && recorder.finalizes.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(recorder.finalizes[0].runId).toBe(queued.id);
    expect(recorder.finalizes[0].outcome.reportId).toBe(reports[0].id);
    expect(recorder.finalizes[0].outcome.status).toBe('completed');
  });
```

文件末尾加入：

```ts
class RecordingRecorder implements RunManifestRecorder {
  captures: RunManifestCaptureRequest[] = [];
  finalizes: Array<{
    runId: string;
    outcome: RunManifestOutcome;
    budget?: RunManifestBudgetOutcome;
  }> = [];

  async capture(request: RunManifestCaptureRequest): Promise<void> {
    this.captures.push(request);
  }

  async finalize(
    runId: string,
    outcome: RunManifestOutcome,
    budget?: RunManifestBudgetOutcome
  ): Promise<void> {
    this.finalizes.push({ runId, outcome, budget });
  }
}
```

- [ ] **步骤 2：运行测试确认失败**

运行：`bun test packages/shared/src/research/service.test.ts`
预期：FAIL（`manifests` 选项不存在 / `manifestId` 未定义）。

- [ ] **步骤 3：`agent-kernel.ts` 透传**

core type import 增加 `RunManifestRecorder`；`AgentKernelOptions` 增加：

```ts
  /** Immutable run manifests (#21), passed through to the RunManager. */
  manifests?: RunManifestRecorder;
```

`new RunManager({...})` 增加：

```ts
      manifests: options.manifests,
```

- [ ] **步骤 4：`research/service.ts` 集成**

core type import 增加 `RunManifestRecorder`；`ResearchServiceOptions` 增加：

```ts
  /** Immutable run manifests (#21). Best-effort: never blocks a run. */
  manifests?: RunManifestRecorder;
```

类字段 + 构造函数赋值：

```ts
  private readonly manifests?: RunManifestRecorder;
```

```ts
    this.onReport = options.onReport;
    this.manifests = options.manifests;
```

`start()` 在 `await this.repository.saveRunSummary(summary);` 之后加入：

```ts
    await this.manifests?.capture({
      runId,
      kind: 'research',
      ...(locale ? { locale } : {}),
      research: {
        ...(strategyId ? { strategyId } : {}),
        plannedCapabilities: [...summary.plannedCapabilities],
      },
    });
```

`execute()` 在 `await this.onReport?.(result.report);` 之后加入：

```ts
      await this.manifests?.finalize(runId, {
        status: result.summary.status,
        ...(result.summary.finishedAt !== undefined ? { finishedAt: result.summary.finishedAt } : {}),
        ...(result.report ? { reportId: result.report.id } : {}),
      });
```

- [ ] **步骤 5：`research/runner.ts` 写入 manifestId**

`assembleReport` 的返回对象（约 276-296 行）在 `locale: ...` 之后加入：

```ts
    manifestId: runId,
```

- [ ] **步骤 6：运行测试确认通过**

运行：`bun test packages/shared/src/research`
预期：PASS（原有用例 + 新用例；此前已知的偶发异步写竞态与本次无关）。

- [ ] **步骤 7：Commit**

```bash
git add packages/shared/src/kernel/agent-kernel.ts packages/shared/src/research/service.ts packages/shared/src/research/runner.ts packages/shared/src/research/service.test.ts
git commit -m "feat(research): record manifests for deep research runs (#21)"
```

## 任务 10：Electron 主进程接线（capture context + IPC）

**文件：**
- 修改：`apps/electron/src/main/about.ts`
- 修改：`apps/electron/src/main/kernelHost.ts`
- 修改：`apps/electron/src/main/index.ts`
- 修改：`apps/electron/src/preload/index.ts`
- 修改：`apps/electron/src/renderer/finagentClient.ts`

- [ ] **步骤 1：导出 build 信息（about.ts）**

`function readChannel(): string {` 改为 `export function readChannel(): string {`；
`function readBuildSha(): string {` 改为 `export function readBuildSha(): string {`。

- [ ] **步骤 2：kernelHost — imports**

新增一条 import（放在其他 `@finagent/shared` 导入附近）：

```ts
import {
  RunManifestRepository,
  RunManifestService,
  collectManifestFeatureFlags,
  fingerprintTools,
  type RunManifestCaptureContext,
} from '@finagent/shared/manifest';
```

在 `@finagent/core` 的 type import 区加入：

```ts
  AgentPromptDescriptor,
  RunManifest,
  RunManifestCaptureRequest,
  RunManifestChange,
  RunManifestSummary,
```

在本地 import 区加入：

```ts
import { readBuildSha, readChannel } from './about.ts';
```

- [ ] **步骤 3：kernelHost — 字段与服务构造**

字段（`private readonly providerRouter: ProviderRouter;` 之后）：

```ts
  private readonly manifestRepository: RunManifestRepository;
  private readonly manifestService: RunManifestService;
```

在 `this.researchService = new ResearchService({`（约 320 行）之前插入：

```ts
    this.manifestRepository = new RunManifestRepository(new JsonFileStore(join(userData, 'store')));
    this.manifestService = new RunManifestService({
      repository: this.manifestRepository,
      captureContext: () => this.captureManifestContext(),
      describePrompt: (request) => this.describeRunPrompt(request),
      onError: (error) => {
        mainErrorLog.push({
          at: Date.now(),
          source: 'run-manifest',
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? (error.stack ?? null) : null,
        });
      },
    });
```

- [ ] **步骤 4：kernelHost — 注入两个服务**

`new ResearchService({` 的 options 中（`repository:` 之后）加入：

```ts
      manifests: this.manifestService,
```

`new AgentKernel({` 的 options 中（`skillHub: this.skillHub,` 之后）加入：

```ts
      manifests: this.manifestService,
```

- [ ] **步骤 5：kernelHost — 新增方法（`researchGetReport` 之后）**

```ts
  // -- Run manifests (#21) ---------------------------------------------------

  async getRunManifest(input: unknown): Promise<RunManifest | undefined> {
    const request = requireObject(input);
    return this.manifestService.get(requireString(request.runId, 'runId'));
  }

  async listRunManifests(input: unknown): Promise<RunManifestSummary[]> {
    const request =
      input !== null && typeof input === 'object' ? (input as { limit?: unknown }) : {};
    const limit =
      typeof request.limit === 'number' && Number.isFinite(request.limit)
        ? request.limit
        : undefined;
    return this.manifestService.list(limit);
  }

  async diffRunManifests(input: unknown): Promise<RunManifestChange[]> {
    const request = requireObject(input);
    return this.manifestService.diff(
      requireString(request.beforeRunId, 'beforeRunId'),
      requireString(request.afterRunId, 'afterRunId')
    );
  }

  private currentTracingExtensions(): string[] {
    return this.evaluationSettings.tracingEnabled ? [getLangSmithExtensionEntry()] : [];
  }

  private async captureManifestContext(): Promise<RunManifestCaptureContext> {
    const tools = fingerprintTools(this.registry.list());
    const extensions = listBundledPiExtensions(this.currentTracingExtensions());
    const degraded =
      this.kernel.runtime instanceof PiRuntimeAdapter
        ? this.kernel.runtime.isObservabilityDegraded()
        : undefined;

    let runtime: RunManifestCaptureContext['runtime'];
    const runtimeApi = this.kernel.getLlmApi();
    if (runtimeApi) {
      runtime = {
        mode: 'pi-runtime',
        extensions,
        ...(degraded !== undefined ? { observabilityDegraded: degraded } : {}),
      };
      try {
        const state = await runtimeApi.getState();
        const params = modelParamsOf(state.model);
        runtime = {
          ...runtime,
          ...(state.model ? { provider: state.model.provider, model: state.model.id } : {}),
          thinkingLevel: state.thinkingLevel,
          availableThinkingLevels: state.availableThinkingLevels,
          ...(params ? { modelParams: params } : {}),
        };
      } catch {
        // Runtime not reachable: keep the honest, partial snapshot above.
      }
    } else {
      runtime = { mode: 'local', extensions: [] };
    }

    return {
      app: { version: app.getVersion(), build: readBuildSha(), channel: readChannel() },
      runtime,
      tools: {
        registryFingerprint: tools.fingerprint,
        capabilityIds: tools.capabilityIds,
        toolNames: tools.toolNames,
      },
      retrieval: { provider: 'none' },
      featureFlags: collectManifestFeatureFlags(process.env, {
        agentProvider: readAgentProvider(),
        tracingEnabled: this.evaluationSettings.tracingEnabled,
        privacyLevel: this.evaluationSettings.privacyLevel,
        ...(degraded !== undefined ? { observabilityDegraded: degraded } : {}),
      }),
    };
  }

  private async describeRunPrompt(
    request: RunManifestCaptureRequest
  ): Promise<AgentPromptDescriptor | undefined> {
    const describe = this.kernel.runtime.describePrompt;
    if (!describe) return undefined;
    return describe({
      sessionId: request.sessionId ?? request.runId,
      runId: request.runId,
      content: request.content ?? '',
      ...(request.workspaceContext ? { workspaceContext: request.workspaceContext } : {}),
      ...(request.locale ? { locale: request.locale } : {}),
    });
  }
```

文件底部 helpers 区（`readAgentProvider` 附近）加入：

```ts
function modelParamsOf(
  model: { contextWindow?: number; maxTokens?: number } | undefined
): Record<string, number> | undefined {
  if (!model) return undefined;
  const params: Record<string, number> = {};
  if (typeof model.contextWindow === 'number') params.contextWindow = model.contextWindow;
  if (typeof model.maxTokens === 'number') params.maxTokens = model.maxTokens;
  return Object.keys(params).length > 0 ? params : undefined;
}
```

- [ ] **步骤 6：main/index.ts — IPC handlers**

在 `research:getReport` handler 之后加入：

```ts
ipcMain.handle('manifests:get', async (_event, input: unknown) =>
  toIpcResult(() => agentKernelHost.getRunManifest(input))
);

ipcMain.handle('manifests:list', async (_event, input: unknown) =>
  toIpcResult(() => agentKernelHost.listRunManifests(input))
);

ipcMain.handle('manifests:diff', async (_event, input: unknown) =>
  toIpcResult(() => agentKernelHost.diffRunManifests(input))
);
```

- [ ] **步骤 7：preload/index.ts — channel**

`ElectronAPI` 的 `research: {...}` 之后加入：

```ts
  manifests: {
    get: (input: { runId: string }) => Promise<unknown>;
    list: (input?: { limit?: number }) => Promise<unknown>;
    diff: (input: { beforeRunId: string; afterRunId: string }) => Promise<unknown>;
  };
```

实现对象中 `research: {...}` 之后加入：

```ts
  manifests: {
    get: (input: { runId: string }) => ipcRenderer.invoke('manifests:get', input),
    list: (input?: { limit?: number }) => ipcRenderer.invoke('manifests:list', input),
    diff: (input: { beforeRunId: string; afterRunId: string }) =>
      ipcRenderer.invoke('manifests:diff', input),
  },
```

- [ ] **步骤 8：renderer/finagentClient.ts — channel 实现**

返回对象中 `research: {...}` 之后加入：

```ts
    manifests: {
      get: (input: { runId: string }) => ipcResult(window.electronAPI.manifests.get(input)),
      list: (input?: { limit?: number }) => ipcResult(window.electronAPI.manifests.list(input)),
      diff: (input: { beforeRunId: string; afterRunId: string }) =>
        ipcResult(window.electronAPI.manifests.diff(input)),
    },
```

- [ ] **步骤 9：typecheck + 单元测试**

运行：

```bash
cd apps/electron && bun run typecheck
bun test packages/shared/src/kernel packages/shared/src/research
```

预期：typecheck 无错误；测试 PASS。

- [ ] **步骤 10：Commit**

```bash
git add apps/electron/src/main/about.ts apps/electron/src/main/kernelHost.ts apps/electron/src/main/index.ts apps/electron/src/preload/index.ts apps/electron/src/renderer/finagentClient.ts
git commit -m "feat(electron): wire run manifests into the main process and IPC (#21)"
```

---

## 任务 11：UI — Run Info 面板、TraceInspector、报告入口

**文件：**
- 修改：`packages/ui/src/client.tsx`
- 创建：`packages/ui/src/components/trace/RunInfoPanel.tsx`
- 创建：`packages/ui/src/components/trace/RunInfoPanel.test.tsx`
- 修改：`packages/ui/src/components/trace/TraceInspector.tsx`
- 修改：`packages/ui/src/components/agent/AgentPanel.tsx`
- 修改：`packages/ui/src/components/research/ResearchReportView.tsx`
- 修改：`packages/i18n/src/locales/en-US/trace.ts`
- 修改：`packages/i18n/src/locales/zh-CN/trace.ts`

- [ ] **步骤 1：`client.tsx` — ManifestChannel**

core import 列表加入 `RunManifest, RunManifestChange, RunManifestSummary`；在 `EvaluationChannel` 之后加入：

```ts
export interface ManifestChannel {
  get: (input: { runId: string }) => Promise<ApiResult<RunManifest | undefined>>;
  list: (input?: { limit?: number }) => Promise<ApiResult<RunManifestSummary[]>>;
  diff: (input: { beforeRunId: string; afterRunId: string }) => Promise<ApiResult<RunManifestChange[]>>;
}
```

`FinagentClient` 中 `evaluation?: EvaluationChannel;` 之后加入：

```ts
  manifests?: ManifestChannel;
```

`fallbackClient` 中 `evaluation: {...}` 之后加入：

```ts
  manifests: {
    get: missingClient('manifests.get'),
    list: missingClient('manifests.list'),
    diff: missingClient('manifests.diff'),
  },
```

- [ ] **步骤 2：i18n — en-US/trace.ts**

`tabs` 中加入：

```ts
    runInfo: 'Run Info',
```

在 `notRecorded` 之前加入：

```ts
  runInfo: {
    title: 'Run Info',
    exportJson: 'Export JSON',
    notRecorded: 'No manifest recorded for this run.',
    version: 'Version',
    build: 'Build',
    channel: 'Channel',
    runtime: 'Runtime',
    provider: 'Provider',
    model: 'Model',
    thinking: 'Thinking',
    extensions: 'Extensions',
    prompt: 'Prompt',
    template: 'Template',
    promptHash: 'Prompt hash',
    promptLength: 'Prompt length',
    tools: 'Tools',
    fingerprint: 'Registry fingerprint',
    capabilities: 'Capabilities',
    research: 'Research',
    strategy: 'Strategy',
    flags: 'Feature flags',
    budget: 'Budget',
    stopReason: 'Stop reason',
    reportId: 'Report',
    diff: 'Changes vs previous run',
    noDiff: 'No differences from the previous run.',
  },
```

- [ ] **步骤 3：i18n — zh-CN/trace.ts**

`tabs` 加入 `runInfo: '运行信息'`；在 `notRecorded` 之前加入：

```ts
  runInfo: {
    title: '运行信息',
    exportJson: '导出 JSON',
    notRecorded: '该 run 没有 manifest 记录。',
    version: '版本',
    build: '构建',
    channel: '渠道',
    runtime: '运行时',
    provider: 'Provider',
    model: '模型',
    thinking: '推理等级',
    extensions: '扩展',
    prompt: 'Prompt',
    template: '模板版本',
    promptHash: 'Prompt 哈希',
    promptLength: 'Prompt 长度',
    tools: '工具',
    fingerprint: '注册表指纹',
    capabilities: 'Capabilities',
    research: '研究',
    strategy: '策略',
    flags: 'Feature flags',
    budget: '预算',
    stopReason: '停止原因',
    reportId: '报告',
    diff: '与上一条 run 的差异',
    noDiff: '与上一条 run 无差异。',
  },
```

- [ ] **步骤 4：编写失败的组件测试 `RunInfoPanel.test.tsx`**

```tsx
import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { RunManifest, RunManifestChange } from '@finagent/core';
import { installHappyDom } from '../../test/setupHappyDom';
import { TestI18n } from '../../test/testI18n';
import { RunInfoPanel } from './RunInfoPanel';

let restoreDom: (() => void) | undefined;

beforeAll(() => {
  restoreDom = installHappyDom().restore;
});

afterAll(() => {
  restoreDom?.();
});

function manifest(): RunManifest {
  return {
    schemaVersion: 1,
    runId: 'run-1',
    kind: 'agent',
    createdAt: 100,
    app: { version: '0.4.0-beta.2', build: 'abc123', channel: 'beta' },
    runtime: { mode: 'pi-runtime', provider: 'anthropic', model: 'claude-sonnet-4', thinkingLevel: 'high', extensions: ['finagent.ts'] },
    prompt: { templateVersion: 'pi-agent-prompt@1', systemHash: 's1', fullPromptHash: 'f1', promptLength: 42 },
    tools: { registryFingerprint: 'fp', capabilityIds: ['market.quote'], toolNames: ['get_quote'] },
    retrieval: { provider: 'none' },
    featureFlags: {},
  };
}

function render(element: React.ReactElement): string {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<TestI18n>{element}</TestI18n>);
  });
  return container.textContent ?? '';
}

describe('RunInfoPanel', () => {
  it('renders manifest fields and diff entries', () => {
    const diff: RunManifestChange[] = [
      { category: 'runtime', path: 'runtime.model', before: 'claude-sonnet-4', after: 'claude-opus-4' },
    ];
    const text = render(<RunInfoPanel manifest={manifest()} diff={diff} />);
    expect(text).toContain('claude-sonnet-4');
    expect(text).toContain('runtime.model');
    expect(text).toContain('0.4.0-beta.2');
    expect(text).toContain('pi-agent-prompt@1');
  });

  it('renders the empty state without a manifest', () => {
    const text = render(<RunInfoPanel manifest={null} />);
    expect(text.length).toBeGreaterThan(0);
  });

  it('calls onExport when the export button is clicked', () => {
    const onExport = mock(() => undefined);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(<TestI18n><RunInfoPanel manifest={manifest()} onExport={onExport} /></TestI18n>);
    });
    const button = container.querySelector('[data-testid="run-info-export"]');
    expect(button).not.toBeNull();
    act(() => {
      (button as HTMLButtonElement).click();
    });
    expect(onExport).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **步骤 5：运行测试确认失败**

运行：`bun test packages/ui/src/components/trace/RunInfoPanel.test.tsx`
预期：FAIL（组件不存在）。

- [ ] **步骤 6：实现 `RunInfoPanel.tsx`**

```tsx
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Download } from 'lucide-react';
import type { RunManifest, RunManifestChange } from '@finagent/core';

export interface RunInfoPanelProps {
  manifest?: RunManifest | null;
  diff?: RunManifestChange[];
  onExport?: () => void;
}

const Row: React.FC<{ label: string; value?: string | number }> = ({ label, value }) => (
  <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-1.5 last:border-b-0">
    <span className="text-[11.5px] font-medium text-foreground/60">{label}</span>
    <span className="truncate font-mono text-[11.5px] text-foreground/80">{value ?? '—'}</span>
  </div>
);

function changeText(change: RunManifestChange): string {
  if (change.added || change.removed) {
    return `+[${(change.added ?? []).join(', ')}] -[${(change.removed ?? []).join(', ')}]`;
  }
  return `${JSON.stringify(change.before ?? null)} → ${JSON.stringify(change.after ?? null)}`;
}

/** Run manifest inspector (#21): read-only fields, JSON export, config diff. */
export const RunInfoPanel: React.FC<RunInfoPanelProps> = ({ manifest, diff, onExport }) => {
  const { t } = useTranslation();
  if (!manifest) {
    return (
      <p className="text-[12px] text-foreground/46" data-testid="run-info-empty">
        {t('trace.runInfo.notRecorded')}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3" data-testid="run-info-panel">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground/46">
          {t('trace.runInfo.title')}
        </div>
        {onExport && (
          <button
            type="button"
            onClick={onExport}
            data-testid="run-info-export"
            className="flex items-center gap-1.5 rounded-[8px] border border-border px-2.5 py-1.5 text-[11.5px] font-medium text-foreground/70 transition-smooth hover:border-border-strong hover:text-foreground"
          >
            <Download className="h-3 w-3" />
            {t('trace.runInfo.exportJson')}
          </button>
        )}
      </div>

      <div className="overflow-hidden rounded-[10px] border mac-list-row">
        <Row label={t('trace.runInfo.version')} value={manifest.app.version} />
        <Row label={t('trace.runInfo.build')} value={manifest.app.build} />
        <Row label={t('trace.runInfo.channel')} value={manifest.app.channel} />
        <Row label={t('trace.runInfo.runtime')} value={manifest.runtime.mode} />
        <Row label={t('trace.runInfo.provider')} value={manifest.runtime.provider} />
        <Row label={t('trace.runInfo.model')} value={manifest.runtime.model} />
        <Row label={t('trace.runInfo.thinking')} value={manifest.runtime.thinkingLevel} />
        <Row label={t('trace.runInfo.extensions')} value={manifest.runtime.extensions.join(', ')} />
        {manifest.prompt && (
          <>
            <Row label={t('trace.runInfo.template')} value={manifest.prompt.templateVersion} />
            <Row label={t('trace.runInfo.promptHash')} value={manifest.prompt.fullPromptHash} />
            <Row label={t('trace.runInfo.promptLength')} value={manifest.prompt.promptLength} />
          </>
        )}
        <Row label={t('trace.runInfo.fingerprint')} value={manifest.tools.registryFingerprint} />
        <Row label={t('trace.runInfo.capabilities')} value={manifest.tools.capabilityIds.length} />
        <Row label={t('trace.runInfo.strategy')} value={manifest.research?.strategyId} />
        <Row label={t('trace.runInfo.stopReason')} value={manifest.budget?.stopReason} />
        <Row label={t('trace.runInfo.reportId')} value={manifest.outcome?.reportId} />
      </div>

      {diff && diff.length > 0 && (
        <div className="rounded-[10px] border mac-list-row p-3" data-testid="run-info-diff">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground/46">
            {t('trace.runInfo.diff')}
          </div>
          <div className="mt-1.5 flex flex-col gap-1">
            {diff.map((change) => (
              <div key={change.path} className="flex items-start justify-between gap-3 text-[11.5px]">
                <span className="font-mono text-foreground/70">{change.path}</span>
                <span className="min-w-0 flex-1 truncate text-right font-mono text-foreground/54">
                  {changeText(change)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      {diff && diff.length === 0 && (
        <p className="text-[11.5px] text-foreground/46">{t('trace.runInfo.noDiff')}</p>
      )}
    </div>
  );
};
```

- [ ] **步骤 7：运行测试确认通过**

运行：`bun test packages/ui/src/components/trace/RunInfoPanel.test.tsx`
预期：PASS（3 个测试）。

- [ ] **步骤 8：TraceInspector 增加 Run Info tab**

core type import 增加 `RunManifest, RunManifestChange`；引入 `RunInfoPanel`。

`type TraceTab` 增加 `'run'`；`TAB_KEYS` 在 details 之后增加：

```ts
  { id: 'run', labelKey: 'trace.tabs.runInfo' },
```

组件 props 改为：

```tsx
export const TraceInspector: React.FC<{
  trace: FolioTrace | null;
  onClose: () => void;
  onOpenLangSmith?: (url: string) => void;
  manifest?: RunManifest | null;
  manifestDiff?: RunManifestChange[];
  onExportManifest?: () => void;
}> = ({ trace, onClose, onOpenLangSmith, manifest, manifestDiff, onExportManifest }) => {
```

在 `{tab === 'details' && <DetailsTab trace={trace} />}` 之后加入：

```tsx
        {tab === 'run' && (
          <RunInfoPanel manifest={manifest} diff={manifestDiff} onExport={onExportManifest} />
        )}
```

- [ ] **步骤 9：新增导出工具 `packages/ui/src/lib/manifestExport.ts`**

```ts
import type { RunManifest } from '@finagent/core';

/** Browser-only JSON download for a run manifest; never touches Node APIs. */
export function downloadManifestJson(manifest: RunManifest): void {
  const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `run-manifest-${manifest.runId}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
```

- [ ] **步骤 10：AgentPanel 接线**

core type import 增加 `RunManifest, RunManifestChange`；引入 `downloadManifestJson`。

`traceDialog` state 类型改为：

```ts
  const [traceDialog, setTraceDialog] = useState<{
    runId: string;
    trace: FolioTrace | null;
    manifest: RunManifest | null;
    manifestDiff: RunManifestChange[];
  } | null>(null);
```

`handleOpenTrace` 中 `setTraceDialog({ runId: lastRun.runId, trace: null });` 改为：

```ts
    setTraceDialog({ runId: lastRun.runId, trace: null, manifest: null, manifestDiff: [] });
```

`loadSessionTraceSources` 之后加入：

```ts
      const runsResult = await client.kernel.listRuns(activeSessionId);
      const runs = runsResult.ok ? runsResult.data : [];
      const index = runs.findIndex((entry) => entry.id === lastRun.runId);
      const previousRun = index >= 0 ? runs[index + 1] : undefined;
      const manifestResult = await client.manifests?.get({ runId: lastRun.runId });
      const manifest = manifestResult?.ok ? manifestResult.data ?? null : null;
      let manifestDiff: RunManifestChange[] = [];
      if (manifest && previousRun) {
        const diffResult = await client.manifests?.diff({
          beforeRunId: previousRun.id,
          afterRunId: lastRun.runId,
        });
        manifestDiff = diffResult?.ok ? diffResult.data : [];
      }
```

`setTraceDialog({ runId: lastRun.runId, trace });` 改为：

```ts
      setTraceDialog({ runId: lastRun.runId, trace, manifest, manifestDiff });
```

TraceInspector 渲染处改为：

```tsx
        <TraceInspector
          trace={traceDialog.trace}
          onClose={() => setTraceDialog(null)}
          onOpenLangSmith={handleOpenLangSmith}
          manifest={traceDialog.manifest}
          manifestDiff={traceDialog.manifestDiff}
          onExportManifest={
            traceDialog.manifest
              ? () => downloadManifestJson(traceDialog.manifest as RunManifest)
              : undefined
          }
        />
```

- [ ] **步骤 11：ResearchReportView 增加 Run Info 入口**

imports 增加：

```tsx
import type { RunManifest } from '@finagent/core';
import { useFinagentClient } from '../../client';
import { Dialog } from '../primitives/Dialog';
import { RunInfoPanel } from '../trace/RunInfoPanel';
import { downloadManifestJson } from '../../lib/manifestExport';
```

组件内（`const [previousReport, setPreviousReport] = ...` 之后）加入：

```tsx
  const client = useFinagentClient();
  const [manifest, setManifest] = useState<RunManifest | null>(null);
  const [manifestOpen, setManifestOpen] = useState(false);

  const openRunInfo = async (): Promise<void> => {
    if (!report.manifestId) return;
    setManifestOpen(true);
    const result = await client.manifests?.get({ runId: report.manifestId });
    if (result?.ok) setManifest(result.data ?? null);
  };
```

`<ExportMenu report={report} />` 之前加入：

```tsx
            {report.manifestId && (
              <button
                type="button"
                onClick={() => void openRunInfo()}
                data-testid="research-open-run-info"
                className="rounded-[8px] border border-border px-2.5 py-1.5 text-[11.5px] font-medium text-foreground/70 transition-smooth hover:border-border-strong hover:text-foreground"
              >
                {t('trace.runInfo.title')}
              </button>
            )}
```

在组件返回的根 `<div ...>` 关闭前加入：

```tsx
      {manifestOpen && (
        <Dialog open onClose={() => setManifestOpen(false)} title={t('trace.runInfo.title')} className="max-w-2xl">
          <RunInfoPanel manifest={manifest} onExport={manifest ? () => downloadManifestJson(manifest) : undefined} />
        </Dialog>
      )}
```

- [ ] **步骤 12：i18n 检查 + UI 测试**

运行：

```bash
bun run i18n:check
bun test packages/ui/src/components/trace
```

预期：i18n 键对齐检查通过；组件测试 PASS。

- [ ] **步骤 13：Commit**

```bash
git add packages/ui/src/client.tsx packages/ui/src/components/trace packages/ui/src/components/agent/AgentPanel.tsx packages/ui/src/components/research/ResearchReportView.tsx packages/ui/src/lib/manifestExport.ts packages/i18n/src/locales
git commit -m "feat(ui): add run info panel, JSON export and manifest diff (#21)"
```

## 任务 12：E2E（真实采集 fixture 重放 + 手动 live 清单 + 校验脚本）

**说明（对 spec §11 的偏差，任务 13 会同步 spec）：** 仓库现有 Electron e2e harness 绑定 macOS 路径（`Electron.app/Contents/MacOS/Electron`），且 #21 的 live E2E 需要交互式切换 model/strategy。因此交付：离线可跑的 fixture 重放测试 + `scripts/manifest-e2e-verify.ts` 校验真实导出的两份 manifest；真实两次 production run 通过手动清单完成并把产物附 PR。

**文件：**
- 创建：`packages/shared/src/manifest/fixtures/manifests-e2e.json`
- 创建：`packages/shared/src/manifest/e2e-fixture.test.ts`
- 创建：`scripts/manifest-e2e-verify.ts`

- [ ] **步骤 1：创建 fixture `manifests-e2e.json`**

```json
[
  {
    "schemaVersion": 1,
    "runId": "research-NVDA_US-1700000000000-1",
    "kind": "research",
    "createdAt": 1700000000000,
    "app": { "version": "0.4.0-beta.2", "build": "dev", "channel": "beta" },
    "runtime": {
      "mode": "pi-runtime",
      "provider": "anthropic",
      "model": "claude-sonnet-4",
      "thinkingLevel": "high",
      "extensions": ["finagent.ts"]
    },
    "prompt": {
      "templateVersion": "pi-agent-prompt@1",
      "systemHash": "1111111111111111",
      "fullPromptHash": "aaaaaaaaaaaaaaaa",
      "promptLength": 800
    },
    "tools": {
      "registryFingerprint": "ffffffffffffffff",
      "capabilityIds": ["company.profile", "research.news"],
      "toolNames": ["get_profile", "get_news"]
    },
    "research": { "strategyId": "comprehensive", "plannedCapabilities": ["company.profile", "research.news"] },
    "retrieval": { "provider": "none" },
    "featureFlags": { "FINAGENT_AGENT_PROVIDER": "pi-runtime" },
    "budget": { "limits": { "toolCalls": 12 } },
    "outcome": { "status": "completed", "finishedAt": 1700000001000, "reportId": "report-research-NVDA_US-1700000000000-1" }
  },
  {
    "schemaVersion": 1,
    "runId": "research-NVDA_US-1700000100000-2",
    "kind": "research",
    "createdAt": 1700000100000,
    "app": { "version": "0.4.0-beta.2", "build": "dev", "channel": "beta" },
    "runtime": {
      "mode": "pi-runtime",
      "provider": "anthropic",
      "model": "claude-sonnet-4",
      "thinkingLevel": "low",
      "extensions": ["finagent.ts"]
    },
    "prompt": {
      "templateVersion": "pi-agent-prompt@1",
      "systemHash": "1111111111111111",
      "fullPromptHash": "bbbbbbbbbbbbbbbb",
      "promptLength": 640
    },
    "tools": {
      "registryFingerprint": "ffffffffffffffff",
      "capabilityIds": ["company.profile", "research.news"],
      "toolNames": ["get_profile", "get_news"]
    },
    "research": { "strategyId": "value", "plannedCapabilities": ["company.profile", "research.news"] },
    "retrieval": { "provider": "none" },
    "featureFlags": { "FINAGENT_AGENT_PROVIDER": "pi-runtime" },
    "budget": { "limits": { "toolCalls": 12 } },
    "outcome": { "status": "completed", "finishedAt": 1700000101000, "reportId": "report-research-NVDA_US-1700000100000-2" }
  }
]
```

- [ ] **步骤 2：编写测试 `e2e-fixture.test.ts`**

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import type { RunManifest } from '@finagent/core';
import { diffRunManifests } from './diff.ts';

function loadFixture(): [RunManifest, RunManifest] {
  const path = join(import.meta.dir, 'fixtures', 'manifests-e2e.json');
  return JSON.parse(readFileSync(path, 'utf8')) as [RunManifest, RunManifest];
}

describe('run manifest E2E fixture (real-capture replay)', () => {
  it('reproduces the config diff of two production runs', () => {
    const [before, after] = loadFixture();
    const changes = diffRunManifests(before, after);
    const paths = changes.map((change) => change.path);

    expect(paths).toContain('runtime.thinkingLevel');
    expect(paths).toContain('research.strategyId');
    expect(paths).toContain('prompt.fullPromptHash');
    expect(changes).toContainEqual({
      category: 'runtime',
      path: 'runtime.thinkingLevel',
      before: 'high',
      after: 'low',
    });
    expect(changes).toContainEqual({
      category: 'research',
      path: 'research.strategyId',
      before: 'comprehensive',
      after: 'value',
    });
  });

  it('is stable: replaying the same pair yields the same diff', () => {
    const [before, after] = loadFixture();
    expect(diffRunManifests(before, after)).toEqual(diffRunManifests(before, after));
  });
});
```

- [ ] **步骤 3：运行测试确认通过**

运行：`bun test packages/shared/src/manifest/e2e-fixture.test.ts`
预期：PASS（2 个测试）。

- [ ] **步骤 4：创建校验脚本 `scripts/manifest-e2e-verify.ts`**

```ts
/**
 * Verifies two exported run manifests (real production runs) actually differ
 * in the config the PR claims. Usage:
 *
 *   bun scripts/manifest-e2e-verify.ts run-1.json run-2.json
 *
 * Exit codes: 0 = differences found (expected for the E2E), 1 = identical,
 * 2 = usage error.
 */
import { readFileSync } from 'node:fs';
import type { RunManifest } from '../packages/core/src/index.ts';
import { diffRunManifests } from '../packages/shared/src/manifest/index.ts';

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  console.error('usage: bun scripts/manifest-e2e-verify.ts <before.json> <after.json>');
  process.exit(2);
}

const before = JSON.parse(readFileSync(beforePath, 'utf8')) as RunManifest;
const after = JSON.parse(readFileSync(afterPath, 'utf8')) as RunManifest;
const changes = diffRunManifests(before, after);

console.log(`manifest diff: ${changes.length} change(s)`);
for (const change of changes) {
  const detail = change.added || change.removed
    ? `+[${(change.added ?? []).join(', ')}] -[${(change.removed ?? []).join(', ')}]`
    : `${JSON.stringify(change.before ?? null)} -> ${JSON.stringify(change.after ?? null)}`;
  console.log(`- [${change.category}] ${change.path}: ${detail}`);
}

process.exit(changes.length > 0 ? 0 : 1);
```

- [ ] **步骤 5：运行脚本自检（fixture 当输入）**

运行：

```bash
bun scripts/manifest-e2e-verify.ts packages/shared/src/manifest/fixtures/manifests-e2e.json packages/shared/src/manifest/fixtures/manifests-e2e.json
```

预期：identical → 输出 `manifest diff: 0 change(s)`，退出码 1（这是脚本自身用法验证）。

- [ ] **步骤 6：Commit**

```bash
git add packages/shared/src/manifest/fixtures/manifests-e2e.json packages/shared/src/manifest/e2e-fixture.test.ts scripts/manifest-e2e-verify.ts
git commit -m "test(manifest): add real-capture fixture E2E and verify CLI (#21)"
```

### 手动 live E2E 清单（PR 证据，需你的环境）

- [ ] 启动 `bun run dev`（pi-runtime + 可用 model），对 `NVDA.US` 跑一次 Deep Research（默认/comprehensive）。
- [ ] 打开报告 → Run Info → **Export JSON** → 保存为 `run-1.json`；截图 Run Info。
- [ ] 修改配置（thinking level，或 strategy 改为 `value`），重启应用。
- [ ] 再跑一次 Deep Research → Export JSON → `run-2.json`。
- [ ] `bun scripts/manifest-e2e-verify.ts run-1.json run-2.json` → 输出 `runtime.thinkingLevel` / `research.strategyId` 差异，退出码 0。
- [ ] 重启后重新打开 run-1 的报告 → Run Info 仍显示**原始** model/prompt hash/工具指纹（证明不被当前设置覆盖）；截图。
- [ ] 把两份真实 manifest（去敏后）替换 `manifests-e2e.json`，重跑 fixture 测试；PR 附两份 JSON + diff 输出 + 截图。

---

## 任务 13：全量验证、spec 修订与收尾

**文件：**
- 修改：`docs/superpowers/specs/2026-09-11-run-manifests-design.md`（E2E 偏差修订）

- [ ] **步骤 1：修订 spec §11 的 live E2E 表述**

把 “Live（真实 run，需用户环境）：`apps/electron/e2e/run-manifests.mjs` …” 一段替换为：

```markdown
- **Live（真实 run，需用户环境）**：`scripts/manifest-e2e-verify.ts` 校验两次真实 Deep Research run 导出的 manifest；真实运行按本计划“手动 live E2E 清单”执行（现有 Electron e2e harness 绑定 macOS 路径，且切换 model/strategy 是交互行为）。PR 附两份 manifest JSON、diff 输出与 Run Info 截图。
```

- [ ] **步骤 2：全量 typecheck**

运行：`bun run typecheck`
预期：所有 workspace 无错误。

- [ ] **步骤 3：全量单测**

运行：`bun test --isolate`
预期：新增测试全部 PASS；允许存在基线已知的 5 个环境相关失败（Windows symlink/locale/electron）与 research service 的异步写竞态，PR 说明中列出。

- [ ] **步骤 4：i18n 与 lint**

运行：

```bash
bun run i18n:check
bun run lint
```

预期：i18n 键双语对齐；lint 无新增错误。

- [ ] **步骤 5：Commit**

```bash
git add docs/superpowers/specs/2026-09-11-run-manifests-design.md
git commit -m "docs(manifest): record E2E deviation for run manifests (#21)"
```

---

## 自检

**1. 规格覆盖度**

| Spec 章节 | 实现任务 |
|---|---|
| §4 数据模型 | 任务 1 |
| §5.1 Recorder 契约 | 任务 1（类型）+ 6（实现） |
| §5.2 capture context | 任务 10 |
| §5.3 prompt 描述符 | 任务 7 |
| §5.4 feature flags | 任务 2 + 10 |
| §6 持久化 | 任务 4 |
| §7.1/7.2 RunManager/AgentKernel | 任务 8 + 9 |
| §7.3 ResearchService/runner | 任务 9 |
| §7.4 kernelHost | 任务 10 |
| §7.5 IPC/preload/client | 任务 10 + 11 |
| §8 diff | 任务 5 |
| §9 UI | 任务 11 |
| §10 错误处理 | 任务 4/6/10（catch + onError） |
| §11 测试/E2E | 任务 2–9 + 12 |
| §12 验收对照 | 任务 12 手动清单 + 任务 13 |
| §14 版本 | 任务 1（`RUN_MANIFEST_SCHEMA_VERSION`） |

**2. 占位符扫描**：本计划所有代码/命令均为完整内容；无 TODO/待定/“类似上文”。

**3. 类型一致性核对**

- `RunManifestCaptureExtras`：任务 1 定义，任务 8 使用。
- `RunManifestBudgetOutcome`：任务 1 定义，任务 4/6/8/9 使用。
- `AgentPromptDescriptor`：任务 1 定义，任务 7/10 使用。
- `RunManifestCaptureContext`：任务 3 定义并导出，任务 6/10 使用。
- `buildAgentPrompt` / `AGENT_PROMPT_TEMPLATE_VERSION`：任务 7 定义并用测试引用。
- `fingerprintTools` 返回 `{ fingerprint, capabilityIds, toolNames }`：任务 2 定义，任务 10 映射为 `registryFingerprint`。
- `manifestId`：任务 1 定义字段，任务 9 写入。
- UI channel 名称 `manifests.get/list/diff`：任务 10（IPC/preload/renderer）与任务 11（client + 组件）一致。

---

## 执行交接

计划已完成并保存到 `docs/superpowers/plans/2026-09-11-run-manifests.md`。两种执行方式：

1. **子代理驱动（推荐）** — 每个任务调度一个新的子代理，任务间进行审查，快速迭代（需使用 `superpowers:subagent-driven-development`）。
2. **内联执行** — 在当前会话中使用 `superpowers:executing-plans` 执行任务，批量执行并设有检查点。

选哪种方式？
