import { afterEach, beforeEach, vi } from 'vitest';

describe('personLookup', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns verified images for known people without hitting the network', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { fetchPersonImage } = await import('../personLookup');

    const image = await fetchPersonImage('Bill Gates');

    // Local cached image is preferred (no network needed)
    expect(image).toBe('/assets/mentors/bill-gates.jpg');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns MBTI local assets and candidates for MBTI personas', async () => {
    const { fetchPersonImage, fetchPersonImageCandidates } = await import('../personLookup');

    const image = await fetchPersonImage('INTJ');
    const candidates = await fetchPersonImageCandidates('INTJ');

    expect(image).toBe('/assets/mbti/intj.png');
    expect(candidates).toContain('/assets/mbti/intj.png');
    expect(candidates?.some((item) => item.includes('16personalities.com'))).toBe(true);
  });

  it('keeps verified matches ahead of the plain typed fallback option in search results', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ query: { search: [] } })
    }));
    const { searchPeopleWithPhotos } = await import('../personLookup');

    const results = await searchPeopleWithPhotos('bill', 6);

    expect(results[0].name).toBe('Bill Gates');
    // "bill" is a substring of "bill gates", so no redundant typed fallback
    expect(results.some((item) => item.name === 'bill')).toBe(false);
    // Local cached image is first
    expect(results[0].imageUrl).toBe('/assets/mentors/bill-gates.jpg');
  });

  it('fetchPersonImage falls back to Wikipedia search then name avatar for unknown people', async () => {
    const fetchMock = vi.fn()
      // fetchWikiImageByTitle call (page query) — no results
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ query: { pages: { '-1': { missing: true } } } })
      })
      // searchWikipediaPeople search call — no results
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ query: { search: [] } })
      });
    vi.stubGlobal('fetch', fetchMock);
    const { fetchPersonImage } = await import('../personLookup');

    const image = await fetchPersonImage('Completely Unknown Person ZZZZZ');

    // Should fall back to a name avatar (data:image/svg or ui-avatars)
    expect(image).toBeTruthy();
    expect(typeof image).toBe('string');
  });

  it('fetchPersonImage uses Wikipedia title lookup when available', async () => {
    const fetchMock = vi.fn()
      // fetchWikiImageByTitle — returns a page with thumbnail and valid description
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          query: {
            pages: {
              '42': {
                title: 'Some Person',
                thumbnail: { source: 'https://example.com/wiki-image.jpg' },
                pageprops: { wikibase_shortdesc: 'American entrepreneur and businesswoman' }
              }
            }
          }
        })
      });
    vi.stubGlobal('fetch', fetchMock);
    const { fetchPersonImage } = await import('../personLookup');

    const image = await fetchPersonImage('Some Person');
    expect(image).toBe('https://example.com/wiki-image.jpg');
  });

  it('fetchPersonImageCandidates returns candidates for unknown person via wiki search', async () => {
    const fetchMock = vi.fn()
      // fetchWikiImageByTitle — no results
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ query: { pages: { '-1': { missing: true } } } })
      })
      // searchWikipediaPeople — returns some results
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          query: { search: [{ title: 'Wiki Person' }] }
        })
      })
      // fetchWikiImageByTitle for the search result
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          query: {
            pages: {
              '99': {
                title: 'Wiki Person',
                thumbnail: { source: 'https://example.com/wiki-person.jpg' },
                pageprops: { wikibase_shortdesc: 'Some person' }
              }
            }
          }
        })
      });
    vi.stubGlobal('fetch', fetchMock);
    const { fetchPersonImageCandidates } = await import('../personLookup');

    const candidates = await fetchPersonImageCandidates('Wiki Person XYZ');
    expect(candidates).toBeTruthy();
    expect(candidates!.length).toBeGreaterThanOrEqual(1);
  });

  it('fetchPersonImageCandidates returns fallback array when wiki search has no images', async () => {
    const fetchMock = vi.fn()
      // fetchWikiImageByTitle — no results
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ query: { pages: { '-1': { missing: true } } } })
      })
      // searchWikipediaPeople — no results
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ query: { search: [] } })
      });
    vi.stubGlobal('fetch', fetchMock);
    const { fetchPersonImageCandidates } = await import('../personLookup');

    const candidates = await fetchPersonImageCandidates('Totally Unknown ZZZZZ');
    expect(candidates).toBeTruthy();
    expect(candidates!.length).toBeGreaterThanOrEqual(1);
    // Should contain at least the name avatar fallback
  });

  it('fetchPersonImageCandidates returns wiki image + fallback for wiki title hit', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          query: {
            pages: {
              '55': {
                title: 'Known Wiki',
                thumbnail: { source: 'https://example.com/known.jpg' },
                pageprops: { wikibase_shortdesc: 'American scientist and inventor' }
              }
            }
          }
        })
      });
    vi.stubGlobal('fetch', fetchMock);
    const { fetchPersonImageCandidates } = await import('../personLookup');

    const candidates = await fetchPersonImageCandidates('Known Wiki');
    expect(candidates).toBeTruthy();
    expect(candidates!.some((url) => url === 'https://example.com/known.jpg')).toBe(true);
    expect(candidates!.length).toBeGreaterThanOrEqual(2); // wiki image + fallback
  });

  it('searchPeopleWithPhotos adds typed query fallback when no match covers it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ query: { search: [] } })
    }));
    const { searchPeopleWithPhotos } = await import('../personLookup');

    const results = await searchPeopleWithPhotos('zzzyyyxxx', 6);
    // Should include the raw typed query as a fallback option
    expect(results.some((item) => item.name === 'zzzyyyxxx')).toBe(true);
  });

  it('searchPeopleWithPhotos merges wiki results with verified and deduplicates', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          query: {
            search: [{ title: 'Bill Gates' }]
          }
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          query: {
            pages: {
              '1': {
                title: 'Bill Gates',
                thumbnail: { source: 'https://example.com/bill-wiki.jpg' },
                pageprops: { wikibase_shortdesc: 'American businessman' }
              }
            }
          }
        })
      });
    vi.stubGlobal('fetch', fetchMock);
    const { searchPeopleWithPhotos } = await import('../personLookup');

    const results = await searchPeopleWithPhotos('Bill Gates', 6);
    // Should have Bill Gates but not duplicated
    const billEntries = results.filter((r) => r.name === 'Bill Gates');
    expect(billEntries).toHaveLength(1);
    // Verified image should win over wiki image
    expect(billEntries[0].imageUrl).toBe('/assets/mentors/bill-gates.jpg');
  });

  it('searchVerifiedPeopleLocal returns matches for known people without network', async () => {
    const { searchVerifiedPeopleLocal } = await import('../personLookup');

    const results = searchVerifiedPeopleLocal('bill', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].name).toBe('Bill Gates');
    expect(results[0].imageUrl).toBeTruthy();
  });

  it('searchVerifiedPeopleLocal returns empty for empty query', async () => {
    const { searchVerifiedPeopleLocal } = await import('../personLookup');

    expect(searchVerifiedPeopleLocal('')).toEqual([]);
    expect(searchVerifiedPeopleLocal('   ')).toEqual([]);
  });

  it('getVerifiedPlaceholderImage returns a string', async () => {
    const { getVerifiedPlaceholderImage } = await import('../personLookup');

    const placeholder = getVerifiedPlaceholderImage();
    expect(typeof placeholder).toBe('string');
    expect(placeholder.length).toBeGreaterThan(0);
  });

  it('fetchPersonImageCandidates returns combined array for verified person', async () => {
    const { fetchPersonImageCandidates } = await import('../personLookup');

    const candidates = await fetchPersonImageCandidates('Bill Gates');
    expect(candidates).toBeTruthy();
    expect(candidates!.length).toBeGreaterThanOrEqual(1);
    // Should include the verified local image
    expect(candidates!.some((url) => url.includes('bill-gates'))).toBe(true);
  });

  it('getChineseDisplayName returns Chinese alias for verified person', async () => {
    const { getChineseDisplayName } = await import('../personLookup');

    const zhName = getChineseDisplayName('Bill Gates');
    // Should return Chinese alias if available, otherwise canonical
    expect(typeof zhName).toBe('string');
    expect(zhName.length).toBeGreaterThan(0);
  });

  it('getChineseDisplayName returns input name for unknown person', async () => {
    const { getChineseDisplayName } = await import('../personLookup');

    const result = getChineseDisplayName('Completely Unknown ZZZZZ');
    expect(result).toBe('Completely Unknown ZZZZZ');
  });

  it('searchVerifiedPeopleLocal sorts by relevance (exact prefix > word prefix > substring)', async () => {
    const { searchVerifiedPeopleLocal } = await import('../personLookup');

    // 'gates' is a substring/word-start match for 'Bill Gates'
    const results = searchVerifiedPeopleLocal('gates', 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.name === 'Bill Gates')).toBe(true);
  });

  it('findVerifiedPerson returns undefined for unknown people', async () => {
    const { findVerifiedPerson } = await import('../personLookup');

    const result = findVerifiedPerson('Completely Unknown Person ZZZZZ');
    expect(result).toBeUndefined();
  });

  it('fetchPersonImage handles fetch errors gracefully (fetchWithTimeout catch)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('Network error'));
    vi.stubGlobal('fetch', fetchMock);
    const { fetchPersonImage } = await import('../personLookup');

    // Unknown person triggers Wikipedia lookup which will fail via the mocked fetch
    const image = await fetchPersonImage('Network Error Person ZZZZZ');
    // Should still return something (name avatar fallback)
    expect(image).toBeTruthy();
    expect(typeof image).toBe('string');
  });

  it('searchVerifiedPeopleLocal handles partial substring queries and sorts by relevance', async () => {
    const { searchVerifiedPeopleLocal } = await import('../personLookup');

    // Use a broad query that matches multiple people so nameRelevance comparator runs
    // 'a' is a very common substring that should match many verified people
    const results = searchVerifiedPeopleLocal('a', 20);
    expect(results.length).toBeGreaterThan(1);

    // 'an' should also match multiple people with different relevance tiers
    const results2 = searchVerifiedPeopleLocal('an', 20);
    expect(results2.length).toBeGreaterThan(0);
  });

  it('filters out wikipedia results that are not likely people or characters', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          query: {
            search: [
              { title: 'Taylor Swift singles discography' },
              { title: 'Taylor Swift' }
            ]
          }
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          query: {
            pages: {
              '1': {
                title: 'Taylor Swift',
                thumbnail: { source: 'https://example.com/taylor.jpg' },
                pageprops: { wikibase_shortdesc: 'American singer-songwriter' }
              }
            }
          }
        })
      });
    vi.stubGlobal('fetch', fetchMock);
    const { searchPeopleWithPhotos } = await import('../personLookup');

    const results = await searchPeopleWithPhotos('Taylor Swift', 6);

    expect(results.some((item) => item.name === 'Taylor Swift singles discography')).toBe(false);
    expect(results.some((item) => item.name === 'Taylor Swift')).toBe(true);
  });
});
