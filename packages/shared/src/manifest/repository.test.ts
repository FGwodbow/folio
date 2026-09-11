import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonFileStore } from '../storage/json-file-store.ts';
import type { RunManifest } from '@finagent/core';
import { RunManifestRepository, compareRunManifests } from './repository.ts';

const manifest = (runId: string, model = 'model-a'): RunManifest => ({
  schemaVersion: 1, runId, kind: 'agent', createdAt: 1,
  app: { version: '1', build: 'b', channel: 'test' },
  runtime: { mode: 'local', provider: 'local', model, extensions: [] },
  tools: { registryFingerprint: 'tools-v1', capabilityIds: ['quote'], toolNames: ['get_quote'] },
  retrieval: { provider: 'none', configVersion: 'v1' }, featureFlags: {},
});

describe('RunManifestRepository', () => {
  it('round trips an immutable manifest and appends outcome without replacing capture data', async () => {
    const dir = await mkdtemp(join(process.env.TEMP ?? process.env.TMP ?? '.', 'folio-manifest-'));
    try {
      const repo = new RunManifestRepository(new JsonFileStore(dir));
      await repo.capture(manifest('run-1'));
      await repo.finalize('run-1', { status: 'completed', finishedAt: 2 }, { usage: { modelCalls: 1 } });
      const restored = await repo.get('run-1');
      expect(restored?.runtime.model).toBe('model-a');
      expect(restored?.outcome?.status).toBe('completed');
      expect(restored?.budget?.usage).toEqual({ modelCalls: 1 });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('lists summaries and compares configuration differences', async () => {
    const dir = await mkdtemp(join(process.env.TEMP ?? process.env.TMP ?? '.', 'folio-manifest-'));
    try {
      const repo = new RunManifestRepository(new JsonFileStore(dir));
      await repo.capture(manifest('a', 'model-a'));
      await repo.capture(manifest('b', 'model-b'));
      expect((await repo.listSummaries()).map(s => s.runId)).toEqual(['b', 'a']);
      expect(compareRunManifests(await repo.get('a'), await repo.get('b')).some(item => item.startsWith('runtime.model'))).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('rejects duplicate capture and missing finalize', async () => {
    const dir = await mkdtemp(join(process.env.TEMP ?? process.env.TMP ?? '.', 'folio-manifest-'));
    try {
      const repo = new RunManifestRepository(new JsonFileStore(dir));
      await repo.capture(manifest('run-1'));
      await expect(repo.capture(manifest('run-1'))).rejects.toThrow('already exists');
      await expect(repo.finalize('missing', { status: 'failed' })).rejects.toThrow('not found');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
