import type { RunManifest } from '@finagent/core';

export function runManifestToJson(manifest: RunManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
