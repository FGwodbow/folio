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
