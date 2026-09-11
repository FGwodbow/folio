import type {
  AgentPromptDescriptor,
  CapabilityRegistry,
  ResearchReport,
  ResearchRunSummary,
  ResearchSynthesizer,
  RunManifestRuntime,
  StrategyId,
  RunManifestRecorder,
} from '@finagent/core';
import { createCodeError } from '../agent/errors.ts';
import type { SupportedLocale } from '@finagent/core';
import { isStrategyId } from '../strategies/presets.ts';
import { planForStrategy } from './planner.ts';
import { ResearchReportRepository } from './repository.ts';
import { ResearchRunner } from './runner.ts';
import type { RunManifestCaptureContext } from '../manifest/builder.ts';

export interface ResearchServiceOptions {
  registry: CapabilityRegistry;
  synthesizer: ResearchSynthesizer;
  repository: ResearchReportRepository;
  now?: () => number;
  /** V5: called after a report is persisted (opinion creation hook). */
  onReport?: (report: ResearchReport) => Promise<void> | void;
  manifestRecorder?: RunManifestRecorder;
  manifestContext?: RunManifestCaptureContext;
  /** Resolves the effective runtime at start time (provider/model/params). */
  runtimeDescriptor?: () =>
    | Partial<RunManifestRuntime>
    | undefined
    | Promise<Partial<RunManifestRuntime> | undefined>;
  /** Describes the synthesis prompt without persisting prompt content. */
  promptDescriptor?: (input: {
    symbol: string;
    strategyId?: StrategyId;
    plannedCapabilities: string[];
    locale?: SupportedLocale;
  }) => AgentPromptDescriptor | undefined | Promise<AgentPromptDescriptor | undefined>;
}

interface ActiveRun {
  runId: string;
  controller: AbortController;
}

const TERMINAL_STATUSES = new Set<ResearchRunSummary['status']>([
  'completed',
  'partial',
  'failed',
  'cancelled',
]);


/**
 * Application-facing Deep Research API. Owns the run lifecycle: at most one
 * run per symbol at a time, abortable, with progress summaries persisted to
 * the repository for the UI.
 */
export class ResearchService {
  private readonly registry: CapabilityRegistry;
  private readonly synthesizer: ResearchSynthesizer;
  private readonly repository: ResearchReportRepository;
  private readonly now: () => number;
  private readonly runner: ResearchRunner;
  private readonly onReport?: (report: ResearchReport) => Promise<void> | void;
  private readonly manifestRecorder?: RunManifestRecorder;
  private readonly manifestContext?: RunManifestCaptureContext;
  private readonly runtimeDescriptor?: ResearchServiceOptions['runtimeDescriptor'];
  private readonly promptDescriptor?: ResearchServiceOptions['promptDescriptor'];

  private readonly active = new Map<string, ActiveRun>();
  private readonly memory = new Map<string, ResearchRunSummary>();
  private sequence = 0;

  constructor(options: ResearchServiceOptions) {
    this.registry = options.registry;
    this.synthesizer = options.synthesizer;
    this.repository = options.repository;
    this.now = options.now ?? Date.now;
    this.onReport = options.onReport;
    this.manifestRecorder = options.manifestRecorder;
    this.manifestContext = options.manifestContext;
    this.runtimeDescriptor = options.runtimeDescriptor;
    this.promptDescriptor = options.promptDescriptor;
    this.runner = new ResearchRunner({
      registry: this.registry,
      synthesizer: this.synthesizer,
      now: this.now,
    });
    // Runs the previous process left non-terminal crashed with it; recover
    // them so the UI never shows an eternally-active run.
    void this.recoverStaleRuns();
  }

  async start(symbol: string, strategyId?: StrategyId, locale?: SupportedLocale): Promise<ResearchRunSummary> {
    const key = normalizeSymbol(symbol);
    if (!key) {
      throw createCodeError('RESEARCH_SYMBOL_INVALID', 'Research requires a non-empty symbol.');
    }
    if (strategyId !== undefined && !isStrategyId(strategyId)) {
      throw createCodeError(
        'RESEARCH_STRATEGY_INVALID',
        `Unknown research strategy: ${String(strategyId)}.`
      );
    }
    if (this.active.has(key)) {
      throw createCodeError(
        'RESEARCH_RUN_ACTIVE',
        `A research run for ${key} is already active.`
      );
    }

    const runId = this.genRunId(key);
    const summary: ResearchRunSummary = {
      id: runId,
      symbol: key,
      status: 'queued',
      startedAt: this.now(),
      plannedCapabilities: planForStrategy(strategyId, this.registry).map((p) => p.capabilityId),
      completedCapabilities: [],
      failedCapabilities: [],
    };

    const controller = new AbortController();
    this.active.set(key, { runId, controller });
    this.memory.set(runId, summary);
    await this.repository.saveRunSummary(summary);
    if (this.manifestRecorder) {
      // Manifest capture is best-effort for optional descriptors: an adapter
      // that cannot describe itself must not prevent a research run starting.
      let runtime: Partial<RunManifestRuntime> | undefined;
      let prompt: AgentPromptDescriptor | undefined;
      try {
        runtime = await this.runtimeDescriptor?.();
      } catch {
        runtime = undefined;
      }
      try {
        prompt = await this.promptDescriptor?.({
          symbol: key,
          strategyId,
          plannedCapabilities: summary.plannedCapabilities,
          locale,
        });
      } catch {
        prompt = undefined;
      }
      await this.manifestRecorder.capture({
        runId,
        kind: 'research',
        locale,
        research: { strategyId, plannedCapabilities: summary.plannedCapabilities },
        retrieval: { provider: 'capability-registry', configVersion: 'v1' },
        ...(runtime ? { runtime } : {}),
        ...(prompt ? { prompt } : {}),
      });
    }

    void this.execute(key, runId, controller.signal, strategyId, locale);
    return summary;
  }

  async cancel(runId: string): Promise<void> {
    for (const active of this.active.values()) {
      if (active.runId === runId) {
        active.controller.abort();
        return;
      }
    }
    throw createCodeError('RESEARCH_RUN_NOT_FOUND', `No active run with id ${runId}.`);
  }

  async getRun(runId: string): Promise<ResearchRunSummary | undefined> {
    const inMemory = this.memory.get(runId);
    if (inMemory) return inMemory;
    return this.repository.getRunSummary(runId);
  }

  async getReport(reportId: string): Promise<ResearchReport | undefined> {
    return this.repository.getReport(reportId);
  }

  async listReports(symbol?: string): Promise<ResearchReport[]> {
    if (symbol) {
      return this.repository.listBySymbol(normalizeSymbol(symbol));
    }
    const summaries = await this.repository.listSummaries();
    const reports = await Promise.all(summaries.map((s) => this.repository.getReport(s.id)));
    return reports.filter((report): report is ResearchReport => report !== undefined);
  }

  async listRuns(): Promise<ResearchRunSummary[]> {
    const persisted = await this.repository.listRunSummaries();
    const merged = new Map(persisted.map((r) => [r.id, r]));
    for (const [id, summary] of this.memory) {
      merged.set(id, summary);
    }
    return [...merged.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  private async execute(
    key: string,
    runId: string,
    signal: AbortSignal,
    strategyId?: StrategyId,
    locale?: SupportedLocale
  ): Promise<void> {
    try {
      const result = await this.runner.run({
        symbol: key,
        runId,
        strategyId,
        signal,
        locale,
        onStatus: async (summary) => {
          // Publish the terminal summary only after execute() has persisted
          // the report and finalized its manifest. This keeps consumers from
          // observing a completed run whose durable artifacts are incomplete.
          if (TERMINAL_STATUSES.has(summary.status)) return;
          this.memory.set(runId, summary);
          await this.repository.saveRunSummary(summary);
        },
      });
      if (result.report) {
        await this.repository.saveReport(result.report);
        await this.onReport?.(result.report);
      }
      await this.manifestRecorder?.finalize(runId, {
        status: result.summary.status,
        finishedAt: result.summary.finishedAt,
        reportId: result.summary.reportId,
      });
      this.memory.set(runId, result.summary);
      await this.repository.saveRunSummary(result.summary);
    } catch (error) {
      await this.manifestRecorder?.finalize(runId, {
        status: 'failed',
        finishedAt: this.now(),
        errorCode: error instanceof Error ? error.name : 'RESEARCH_RUN_FAILED',
      }).catch(() => undefined);
      throw error;
    } finally {
      this.active.delete(key);
    }
  }

  /**
   * Runs persisted in a non-terminal status belong to a process that died
   * mid-run. Mark them failed so restart never resurrects a zombie run.
   */
  private async recoverStaleRuns(): Promise<void> {
    try {
      const summaries = await this.repository.listRunSummaries();
      for (const summary of summaries) {
        if (
          summary.status === 'completed' ||
          summary.status === 'partial' ||
          summary.status === 'failed' ||
          summary.status === 'cancelled'
        ) {
          continue;
        }
        const recovered: ResearchRunSummary = {
          ...summary,
          status: 'failed',
          finishedAt: summary.finishedAt ?? this.now(),
        };
        this.memory.set(recovered.id, recovered);
        await this.repository.saveRunSummary(recovered);
      }
    } catch {
      // Recovery is best-effort; a corrupt run index must not block startup.
    }
  }

  private genRunId(key: string): string {
    this.sequence += 1;
    const slug = key.replace(/\./g, '_');
    return `research-${slug}-${this.now()}-${this.sequence}`;
  }
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}
