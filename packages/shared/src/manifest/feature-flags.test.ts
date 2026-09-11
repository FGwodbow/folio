import { describe, expect, it } from 'bun:test';
import { collectManifestFeatureFlags } from './feature-flags.ts';

describe('collectManifestFeatureFlags', () => {
  it('keeps only whitelisted, non-empty env keys', () => {
    const flags = collectManifestFeatureFlags({
      FINAGENT_AGENT_PROVIDER: 'pi-runtime',
      FINAGENT_PRIVACY_LEVEL: 'standard',
      FINAGENT_PI_MODEL: '',
      ANTHROPIC_API_KEY: 'sk-must-not-appear',
      LANGSMITH_PI_API_KEY: 'lsv2_must_not_appear',
    });
    expect(flags).toEqual({
      FINAGENT_AGENT_PROVIDER: 'pi-runtime',
      FINAGENT_PRIVACY_LEVEL: 'standard',
    });
    expect(flags).not.toHaveProperty('FINAGENT_PI_MODEL');
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

  it('booleanizes TRACE_TO_LANGSMITH for TRUE and falsy variants, keeping a defined key', () => {
    expect(collectManifestFeatureFlags({ TRACE_TO_LANGSMITH: 'TRUE' }).TRACE_TO_LANGSMITH).toBe(true);
    expect(collectManifestFeatureFlags({ TRACE_TO_LANGSMITH: '0' }).TRACE_TO_LANGSMITH).toBe(false);
    expect(collectManifestFeatureFlags({ TRACE_TO_LANGSMITH: 'false' }).TRACE_TO_LANGSMITH).toBe(false);
    const empty = collectManifestFeatureFlags({ TRACE_TO_LANGSMITH: '' });
    expect('TRACE_TO_LANGSMITH' in empty).toBe(true);
    expect(empty.TRACE_TO_LANGSMITH).toBe(false);
  });
});
