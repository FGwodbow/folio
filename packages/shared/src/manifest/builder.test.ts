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
