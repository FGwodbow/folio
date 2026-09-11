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

/**
 * Collects flags from the whitelisted env keys, skipping empty values, and
 * booleanizes TRACE_TO_LANGSMITH whenever it is defined (any value, including '').
 * Explicit runtime-derived extras are overlaid last and take precedence.
 */
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
