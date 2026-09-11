import type { RunManifest, RunManifestBudgetOutcome, RunManifestCaptureRequest, RunManifestOutcome, RunManifestRecorder, RunManifestSummary } from '@finagent/core';
import type { JsonFileStore } from '../storage/json-file-store.ts';
import { buildRunManifest, type RunManifestCaptureContext } from './builder.ts';
interface ManifestIndex { manifests: RunManifestSummary[] }
const indexFile = 'manifests/index.json';
const manifestFile = (id: string) => `manifests/${id}.json`;
export class RunManifestRepository implements RunManifestRecorder {
  constructor(private readonly store: JsonFileStore, private readonly context?: RunManifestCaptureContext) {}
  async capture(request: RunManifestCaptureRequest | RunManifest, captureContext?: RunManifestCaptureContext): Promise<void> {
    const runId = request.runId;
    if (await this.get(runId)) throw new Error(`Run manifest ${runId} already exists`);
    const manifest = 'schemaVersion' in request
      ? structuredClone(request)
      : buildRunManifest({ request, context: captureContext ?? this.context!, now: Date.now() });
    await this.store.write(manifestFile(request.runId), manifest);
    const index = await this.store.read<ManifestIndex>(indexFile, { manifests: [] });
    await this.store.write(indexFile, { manifests: [summaryOf(manifest), ...index.manifests] });
  }
  async finalize(runId: string, outcome: RunManifestOutcome, budget?: RunManifestBudgetOutcome): Promise<void> {
    const manifest = await this.get(runId);
    if (!manifest) throw new Error(`Run manifest ${runId} not found`);
    const next: RunManifest = { ...manifest, outcome: { ...outcome } };
    if (budget && (budget.usage || budget.stopReason || budget.stopDetail)) next.budget = { ...(manifest.budget ?? { limits: {} }), ...budget };
    await this.store.write(manifestFile(runId), next);
    const index = await this.store.read<ManifestIndex>(indexFile, { manifests: [] });
    await this.store.write(indexFile, { manifests: index.manifests.map(item => item.runId === runId ? summaryOf(next) : item) });
  }
  async get(runId: string): Promise<RunManifest | undefined> { return this.store.read(manifestFile(runId), undefined); }
  async listSummaries(): Promise<RunManifestSummary[]> { return (await this.store.read<ManifestIndex>(indexFile, { manifests: [] })).manifests; }
}
function summaryOf(manifest: RunManifest): RunManifestSummary {
  return { runId: manifest.runId, kind: manifest.kind, createdAt: manifest.createdAt, runtimeMode: manifest.runtime.mode, provider: manifest.runtime.provider, model: manifest.runtime.model, status: manifest.outcome?.status };
}
export function compareRunManifests(left: RunManifest | undefined, right: RunManifest | undefined): string[] {
  if (!left || !right) return ['manifest missing'];
  const paths = ['app.version','app.build','app.revision','runtime.mode','runtime.provider','runtime.model','runtime.thinkingLevel','runtime.availableThinkingLevels','runtime.modelParams','prompt.templateVersion','prompt.systemHash','prompt.skillIndexHash','prompt.fullPromptHash','tools.registryFingerprint','tools.capabilityIds','tools.toolNames','retrieval.provider','retrieval.configVersion','featureFlags','budget.limits','research.strategyId','research.plannedCapabilities'];
  return paths.filter(path => JSON.stringify(readPath(left, path)) !== JSON.stringify(readPath(right, path))).map(path => `${path}: ${JSON.stringify(readPath(left, path))} -> ${JSON.stringify(readPath(right, path))}`);
}
function readPath(value: unknown, path: string): unknown { let current: unknown = value; for (const key of path.split('.')) { if (!current || typeof current !== 'object') return undefined; current = (current as Record<string, unknown>)[key]; } return current; }
