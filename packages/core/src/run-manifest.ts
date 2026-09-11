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
  revision?: string;
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
