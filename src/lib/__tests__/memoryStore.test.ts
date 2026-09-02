import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  MEMORY_STORE_KEY,
  clearMemories,
  loadMemories,
  migrateMemories,
  saveMemories,
  type MemoryCard,
} from '../memoryStore';

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => { map.delete(k); },
    setItem: (k: string, v: string) => { map.set(k, v); },
  };
}

const card: MemoryCard = {
  id: 'm1',
  title: 'Product launch table',
  createdAt: '2026-04-27T10:00:00.000Z',
  takeaways: ['Start with the smallest shippable slice.'],
};

describe('memoryStore ()', () => {
  let storage: Storage;

  beforeEach(() => {
    storage = fakeStorage();
  });

  it('saves and loads a roundtrip through the versioned envelope', () => {
    saveMemories([card], storage);
    const raw = JSON.parse(storage.getItem(MEMORY_STORE_KEY)!);
    expect(raw.version).toBe(1);
    expect(raw.memories).toHaveLength(1);
    expect(loadMemories(storage)).toEqual([card]);
  });

  it('returns empty for missing key and corrupt JSON', () => {
    expect(loadMemories(storage)).toEqual([]);
    storage.setItem(MEMORY_STORE_KEY, '{not json at all');
    expect(loadMemories(storage)).toEqual([]);
  });

  it('migrates the v0 legacy bare-array shape', () => {
    storage.setItem(MEMORY_STORE_KEY, JSON.stringify([card]));
    expect(loadMemories(storage)).toEqual([card]);
    expect(migrateMemories([card])).toEqual([card]);
  });

  it('drops malformed entries instead of throwing', () => {
    const raw = JSON.stringify({
      version: 1,
      memories: [card, { id: 42 }, null, { ...card, takeaways: 'oops' }],
    });
    storage.setItem(MEMORY_STORE_KEY, raw);
    expect(loadMemories(storage)).toEqual([card]);
  });

  it('unknown shapes migrate to empty array', () => {
    expect(migrateMemories('garbage')).toEqual([]);
    expect(migrateMemories({ version: 99, memories: [card] })).toEqual([]);
  });

  it('bounds the store to the newest 50 memories', () => {
    const many: MemoryCard[] = Array.from({ length: 60 }, (_, i) => ({
      id: `m${i}`,
      title: `t${i}`,
      createdAt: '2026-04-27T10:00:00.000Z',
      takeaways: [],
    }));
    saveMemories(many, storage);
    const loaded = loadMemories(storage);
    expect(loaded).toHaveLength(50);
    expect(loaded[0].id).toBe('m0');
  });

  it('never throws on quota/private-mode failures', () => {
    const broken: Storage = {
      ...fakeStorage(),
      setItem: () => { throw new Error('QuotaExceededError'); },
      getItem: () => { throw new Error('denied'); },
      removeItem: () => { throw new Error('denied'); },
    };
    expect(() => saveMemories([card], broken)).not.toThrow();
    expect(() => loadMemories(broken)).not.toThrow();
    expect(() => clearMemories(broken)).not.toThrow();
  });

  it('clearMemories removes the key', () => {
    saveMemories([card], storage);
    clearMemories(storage);
    expect(storage.getItem(MEMORY_STORE_KEY)).toBeNull();
  });

  it('real localStorage integration: load after save in the same origin', () => {
    // Uses the actual jsdom localStorage through the default parameter.
    vi.spyOn(Storage.prototype, 'setItem');
    saveMemories([card]);
    expect(loadMemories()).toEqual([card]);
    clearMemories();
    expect(loadMemories()).toEqual([]);
  });
});
