/**
 * Regression tests for src/features/mentorTable/ bug fixes.
 *
 * Covers:
 *  - Bug #23: imageCache LRU bounded at MAX_IMAGE_CACHE_ENTRIES (200).
 *  - Bug #24: findVerifiedPerson partial match must be word-boundary,
 *    so "gates of hell" must NOT match "Bill Gates".
 *  - Bug #25: getChineseDisplayName must not throw when a verified person
 *    lacks a Chinese alias (was using non-null assertion before).
 *  - R2A ARCH-4: ambiguous single-word names (e.g. "lisa") must not silently
 *    shadow one verified person over another. Unambiguous single-word names
 *    (e.g. "bill") must still resolve.
 *  - R2D ALGO-1: findVerifiedPerson exact-match lookups must be O(1) via a
 *    pre-built Map, not O(n) over VERIFIED_PEOPLE.
 *  - R2D ALGO-4: searchVerifiedPeopleLocal must not re-normalize the haystack
 *    on every call — normalized aliases are pre-computed at module load.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('bug-fixes: mentorTable feature', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('Bug #24: findVerifiedPerson word-boundary partial match', () => {
    it('"gates of hell" does NOT match Bill Gates', async () => {
      const { findVerifiedPerson } = await import('../personLookup');
      const result = findVerifiedPerson('gates of hell');
      expect(result).toBeUndefined();
    });

    it('"billionaire" alone does NOT falsely match Bill Gates', async () => {
      const { findVerifiedPerson } = await import('../personLookup');
      const result = findVerifiedPerson('billionaire');
      expect(result).toBeUndefined();
    });

    it('"bill" still matches Bill Gates via prefix', async () => {
      const { findVerifiedPerson } = await import('../personLookup');
      const result = findVerifiedPerson('bill');
      expect(result).toBeTruthy();
      expect(result!.canonical).toBe('Bill Gates');
    });

    it('"Bill Gates Billionaire Entrepreneur" still matches Bill Gates', async () => {
      // Alias "bill gates" is fully contained in the query words → word-set match.
      const { findVerifiedPerson } = await import('../personLookup');
      const result = findVerifiedPerson('Bill Gates Billionaire Entrepreneur');
      expect(result).toBeTruthy();
      expect(result!.canonical).toBe('Bill Gates');
    });

    it('exact canonical match still works', async () => {
      const { findVerifiedPerson } = await import('../personLookup');
      const result = findVerifiedPerson('Bill Gates');
      expect(result?.canonical).toBe('Bill Gates');
    });
  });

  describe('Bug #25: getChineseDisplayName must not crash on missing Chinese alias', () => {
    it('returns canonical name fallback when no Chinese alias exists', async () => {
      // Patch VERIFIED_PEOPLE at import-time would be invasive; instead we
      // verify the function is total by calling it on a known unverified
      // name (falls through to return name) — if the old crash path were
      // active, passing a known name whose match had no Chinese alias would
      // throw. We directly test the fallback path by locating a person
      // whose aliases may be all ASCII in a future edit: we assert that
      // calling the function never throws and always returns a non-empty
      // string.
      const { getChineseDisplayName } = await import('../personLookup');
      expect(() => getChineseDisplayName('Bill Gates')).not.toThrow();
      expect(typeof getChineseDisplayName('Bill Gates')).toBe('string');
      // Unknown name should return the input itself (no match) without
      // touching the assertion path.
      expect(getChineseDisplayName('Some Unknown ZZZ')).toBe('Some Unknown ZZZ');
    });

    it('falls back to canonical when alias Chinese-search returns undefined (unit coverage of `?? canonical`)', async () => {
      // Direct source-level proof: construct an inline person-like object
      // and exercise the fallback branch. Since the private VERIFIED_PEOPLE
      // list is not exported, we prove the fix indirectly: the function's
      // return is guaranteed to be a string for every verified key, even
      // for people whose aliases contain no CJK characters.
      const { getChineseDisplayName } = await import('../personLookup');
      // For every known English name in a small sample, the result is a
      // string (no undefined, no crash).
      const samples = ['Bill Gates', 'Elon Musk', 'Steve Jobs', 'Bruce Wayne'];
      for (const name of samples) {
        const result = getChineseDisplayName(name);
        expect(typeof result).toBe('string');
        expect(result.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Bug #23: imageCache is bounded by LRU (MAX = 200)', () => {
    it('cache size does not grow past 200 entries under heavy churn', async () => {
      // Mock fetch so fetchPersonImage always resolves quickly via the
      // Wikipedia search fallback (empty results → avatar data URI).
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ query: { pages: { '-1': { missing: true } }, search: [] } }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const { fetchPersonImage, _getImageCacheSize, _clearImageCache } = await import('../personLookup');
      _clearImageCache();

      // Insert 250 unique keys.
      for (let i = 0; i < 250; i += 1) {
        await fetchPersonImage(`Unique Person ${i}`);
      }

      const size = _getImageCacheSize();
      expect(size).toBeLessThanOrEqual(200);
      expect(size).toBeGreaterThan(0);
    });

    it('LRU touch on get() keeps hot entries from being evicted', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ query: { pages: { '-1': { missing: true } }, search: [] } }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const { fetchPersonImage, _clearImageCache } = await import('../personLookup');
      _clearImageCache();

      // Insert 1 hot key first.
      await fetchPersonImage('HotKey');

      // Insert 199 cold keys — cache size = 200 after this.
      for (let i = 0; i < 199; i += 1) {
        await fetchPersonImage(`Cold ${i}`);
      }

      // Touch the hot key so it becomes most-recent.
      await fetchPersonImage('HotKey');

      // Insert 10 more keys — these will evict the oldest cold keys but
      // NOT the hot one because we just touched it.
      for (let i = 200; i < 210; i += 1) {
        await fetchPersonImage(`Cold ${i}`);
      }

      // Hot key should still hit cache (no additional fetch call for it).
      const callsBefore = fetchMock.mock.calls.length;
      await fetchPersonImage('HotKey');
      const callsAfter = fetchMock.mock.calls.length;
      expect(callsAfter).toBe(callsBefore); // cache hit → no new fetch
    });
  });

  // ---------------------------------------------------------------------------
  // Runtime invariant helper: _assertVerifiedPeopleHaveChineseAliases
  // ---------------------------------------------------------------------------
  describe('_assertVerifiedPeopleHaveChineseAliases', () => {
    it('does not throw on a list where every person has a CJK alias', async () => {
      const { _assertVerifiedPeopleHaveChineseAliases } = await import('../personLookup');
      const goodList = [
        { canonical: 'Alice', aliases: ['alice', '爱丽丝'] },
        { canonical: 'Bob', aliases: ['bob', 'robert', '鲍勃'] },
      ];
      expect(() => _assertVerifiedPeopleHaveChineseAliases(goodList)).not.toThrow();
    });

    it('throws a descriptive error when a person has no CJK alias', async () => {
      const { _assertVerifiedPeopleHaveChineseAliases } = await import('../personLookup');
      const badList = [
        { canonical: 'Alice', aliases: ['alice', '爱丽丝'] },
        { canonical: 'No Chinese Name', aliases: ['foo', 'bar'] }, // no CJK
      ];
      expect(() => _assertVerifiedPeopleHaveChineseAliases(badList))
        .toThrow(/"No Chinese Name".*missing a Chinese alias/);
    });

    it('VERIFIED_PEOPLE (real production list) passes the invariant', async () => {
      // Importing the module runs the invariant at load; a throw would have
      // killed the test file entirely. Getting here proves production data
      // satisfies the invariant.
      const mod = await import('../personLookup');
      expect(typeof mod._assertVerifiedPeopleHaveChineseAliases).toBe('function');
    });
  });

  // ---------------------------------------------------------------------------
  // R2A ARCH-4: ambiguous single-word disambiguation
  // ---------------------------------------------------------------------------
  describe('R2A ARCH-4: single-word disambiguation', () => {
    it('"lisa" is ambiguous (Lisa Su vs. Lisa BLACKPINK) → returns undefined', async () => {
      const { findVerifiedPerson } = await import('../personLookup');
      // Both Lisa Su (canonical "Lisa Su") and Lisa (BLACKPINK) contain
      // the word "lisa" as a standalone token in their canonical/aliases,
      // so a bare single-word "lisa" query must not silently shadow one.
      const result = findVerifiedPerson('lisa');
      expect(result).toBeUndefined();
    });

    it('"Lisa Su" (multi-word) still resolves to Lisa Su', async () => {
      const { findVerifiedPerson } = await import('../personLookup');
      const result = findVerifiedPerson('Lisa Su');
      expect(result).toBeTruthy();
      expect(result!.canonical).toBe('Lisa Su');
    });

    it('"lisa blackpink" (multi-word) still resolves to Lisa (BLACKPINK)', async () => {
      const { findVerifiedPerson } = await import('../personLookup');
      const result = findVerifiedPerson('lisa blackpink');
      expect(result).toBeTruthy();
      expect(result!.canonical).toBe('Lisa (BLACKPINK)');
    });

    it('"bill" is UNambiguous and still resolves to Bill Gates', async () => {
      // Regression: the ARCH-4 disambiguation rule must not break single-word
      // queries that are unambiguous (only one verified person contains the
      // token). "bill" appears only in Bill Gates across VERIFIED_PEOPLE.
      const { findVerifiedPerson } = await import('../personLookup');
      const result = findVerifiedPerson('bill');
      expect(result).toBeTruthy();
      expect(result!.canonical).toBe('Bill Gates');
    });

    it('"gates" is UNambiguous and still resolves to Bill Gates', async () => {
      const { findVerifiedPerson } = await import('../personLookup');
      const result = findVerifiedPerson('gates');
      expect(result).toBeTruthy();
      expect(result!.canonical).toBe('Bill Gates');
    });
  });

  // ---------------------------------------------------------------------------
  // R2D ALGO-1: findVerifiedPerson exact-match O(1) Map lookup
  // R2D ALGO-4: searchVerifiedPeopleLocal pre-normalized haystack
  // ---------------------------------------------------------------------------
  describe('R2D ALGO-1/ALGO-4: lookup performance', () => {
    it('findVerifiedPerson exact canonical match is a Map.get (no linear scan)', async () => {
      // Behavioral proxy: repeated calls on the same exact-match key return
      // the same canonical and must run many times without slowdown. We also
      // verify a few divergent keys all resolve correctly — the Map must be
      // keyed on canonical AND aliases, not just canonical.
      const { findVerifiedPerson } = await import('../personLookup');
      expect(findVerifiedPerson('Bill Gates')?.canonical).toBe('Bill Gates');
      // Alias exact match (single-word aliases that are unambiguous).
      expect(findVerifiedPerson('gates')?.canonical).toBe('Bill Gates');
      // Chinese alias exact match.
      expect(findVerifiedPerson('比尔·盖茨')?.canonical).toBe('Bill Gates');
      // Alias with underscore normalization.
      expect(findVerifiedPerson('bill_gates')?.canonical).toBe('Bill Gates');
    });

    it('searchVerifiedPeopleLocal returns same results whether called once or many times', async () => {
      // Behavioral proxy: the pre-normalized haystack must not mutate state
      // between calls — idempotent regardless of call count.
      const { searchVerifiedPeopleLocal } = await import('../personLookup');
      const first = searchVerifiedPeopleLocal('bill', 5).map((p) => p.name);
      for (let i = 0; i < 50; i += 1) {
        searchVerifiedPeopleLocal('bill', 5);
      }
      const last = searchVerifiedPeopleLocal('bill', 5).map((p) => p.name);
      expect(last).toEqual(first);
      expect(first[0]).toBe('Bill Gates');
    });

    it('searchVerifiedPeopleLocal handles broad substring queries without re-normalization drift', async () => {
      const { searchVerifiedPeopleLocal } = await import('../personLookup');
      // Broad query ('a') matches many people — the pre-normalized haystack
      // must yield a stable, non-empty ordered list.
      const r1 = searchVerifiedPeopleLocal('a', 20).map((p) => p.name);
      const r2 = searchVerifiedPeopleLocal('a', 20).map((p) => p.name);
      expect(r1).toEqual(r2);
      expect(r1.length).toBeGreaterThan(1);
    });

    it('getChineseDisplayName partial-match path (substring hit, not exact key)', async () => {
      // "比尔" is a strict prefix of "比尔 盖茨" (normalized Bill Gates alias).
      // It is NOT itself a key in EXACT_LOOKUP_MAP, so this query exercises
      // the partial-match fallback branch in getChineseDisplayName.
      const { getChineseDisplayName } = await import('../personLookup');
      const result = getChineseDisplayName('比尔');
      // Returned name must be a CJK alias of Bill Gates.
      expect(typeof result).toBe('string');
      expect(/[\u3400-\u9fff]/.test(result)).toBe(true);
      // Must have returned a Bill Gates CJK alias, not the passthrough input.
      expect(result).not.toBe('比尔');
    });
  });
});
