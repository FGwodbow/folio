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
    runtime: { ...context.runtime, ...(request.runtime ?? {}), extensions: [...(request.runtime?.extensions ?? context.runtime.extensions)] },
    tools: {
      registryFingerprint: context.tools.registryFingerprint,
      capabilityIds: [...context.tools.capabilityIds],
      toolNames: [...context.tools.toolNames],
    },
    retrieval: request.retrieval ?? context.retrieval,
    featureFlags: { ...context.featureFlags },
  };
  const prompt = input.prompt ?? request.prompt;
  if (prompt) manifest.prompt = promptInfo(prompt, request.locale);
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
