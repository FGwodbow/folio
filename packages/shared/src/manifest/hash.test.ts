import { describe, expect, it } from 'bun:test';
import { fingerprintTools, shortHash } from './hash.ts';

describe('shortHash', () => {
  it('is deterministic and 16 hex chars', () => {
    expect(shortHash('hello')).toBe(shortHash('hello'));
    expect(shortHash('hello')).toMatch(/^[0-9a-f]{16}$/);
    expect(shortHash('hello')).not.toBe(shortHash('hello!'));
  });
});

describe('fingerprintTools', () => {
  const caps = [
    { id: 'market.quote', toolName: 'get_quote' },
    { id: 'research.news', toolName: 'get_news' },
    { id: 'market.quote', toolName: 'get_quote' },
  ];

  it('sorts and dedupes ids and tool names deterministically', () => {
    const a = fingerprintTools(caps);
    const b = fingerprintTools([...caps].reverse());
    expect(a).toEqual(b);
    expect(a.capabilityIds).toEqual(['market.quote', 'research.news']);
    expect(a.toolNames).toEqual(['get_news', 'get_quote']);
    expect(a.capabilityIds).toEqual([...new Set(a.capabilityIds)]);
    expect(a.toolNames).toEqual([...new Set(a.toolNames)]);
    expect(a.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('changes when the tool set changes', () => {
    const a = fingerprintTools(caps);
    const b = fingerprintTools([...caps, { id: 'market.kline', toolName: 'get_kline' }]);
    expect(b.fingerprint).not.toBe(a.fingerprint);
  });
});
