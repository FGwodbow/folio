import React from 'react';
import type { RunManifest } from '@finagent/core';

export const RunInfo: React.FC<{ manifest: RunManifest }> = ({ manifest }) => {
  const exportJson = () => {
    const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${manifest.runId}.manifest.json`;
    link.click();
    URL.revokeObjectURL(url);
  };
  return <details data-testid="run-info" className="rounded-[10px] border border-border bg-surface-muted px-3 py-2">
    <summary className="cursor-pointer text-[11px] font-semibold text-foreground/64">Run Info</summary>
    <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] text-foreground/58">
      <span>Run</span><span className="truncate font-mono">{manifest.runId}</span>
      <span>Created</span><span>{new Date(manifest.createdAt).toLocaleString()}</span>
      <span>Runtime</span><span>{manifest.runtime.provider ?? '—'} / {manifest.runtime.model ?? '—'}</span>
      <span>App</span><span>{manifest.app.version} ({manifest.app.build})</span>
      <span>Prompt</span><span className="truncate font-mono">{manifest.prompt?.fullPromptHash ?? '—'}</span>
      <span>Tools</span><span className="truncate font-mono">{manifest.tools.registryFingerprint}</span>
      <span>Status</span><span>{manifest.outcome?.status ?? 'running'}</span>
    </div>
    <button type="button" onClick={exportJson} className="mt-2 rounded-[7px] border border-border px-2 py-1 text-[10px] font-medium text-foreground/64 hover:text-foreground">Export JSON</button>
  </details>;
};
