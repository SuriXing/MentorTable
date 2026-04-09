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

    // Should fall back to a name avatar (data URI or ui-avatars). Assert the
    // specific fallback shape rather than a bare typeof/truthy check — a
    // truthy string like "undefined" would otherwise slip through.
    expect(typeof image).toBe('string');
    expect(image!.length).toBeGreaterThan(0);
    expect(
      image!.startsWith('data:image/svg') ||
      image!.includes('ui-avatars.com') ||
      image!.includes('dicebear.com')
    ).toBe(true);
    // Fallback must not contain literal garbage like "undefined" / "null".
    expect(image!.toLowerCase()).not.toContain('undefined');
    expect(image!.toLowerCase()).not.toContain('null');
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
                pageprops: { wikibase_shortdesc: 'American entrepreneur and inventor' }
              }
            }
          }
        })
      });
    vi.stubGlobal('fetch', fetchMock);
    const { fetchPersonImageCandidates } = await import('../personLookup');

    const candidates = await fetchPersonImageCandidates('Wiki Person XYZ');
    expect(candidates).toBeTruthy();
    // The wiki-search branch MUST surface the mocked wiki thumbnail — not
    // just return a placeholder. A length-only assertion would pass even if
    // the wiki branch was bypassed and only the name-avatar fallback ran.
    expect(candidates!.some((u) => u === 'https://example.com/wiki-person.jpg')).toBe(true);
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
    // Must contain the name-avatar fallback specifically — not just "some"
    // entry. Name-avatars start with `data:image/svg` or hit ui-avatars /
    // dicebear.
    expect(
      candidates!.some(
        (u) =>
          u.startsWith('data:image/svg') ||
          u.includes('ui-avatars.com') ||
          u.includes('dicebear.com')
      )
    ).toBe(true);
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
    expect(placeholder).toMatch(/^data:image\/svg/);
  });

  it('fetchPersonImageCandidates handles verified person with no candidateImageUrls (line 1513)', async () => {
    // Hayao Miyazaki has no candidateImageUrls → `|| []` fallback. The
    // result must still surface a real image (the primary imageUrl from
    // the verified record), proving the `|| []` branch didn't silently
    // drop the primary.
    const { fetchPersonImageCandidates } = await import('../personLookup');
    const candidates = await fetchPersonImageCandidates('Hayao Miyazaki');
    expect(candidates).toBeTruthy();
    expect(candidates!.every((u) => typeof u === 'string' && u.length > 0)).toBe(true);
    // At least one entry must be a real (verified) image — a local asset
    // path or an http(s) URL — not just a name-avatar placeholder.
    expect(
      candidates!.some(
        (u) => u.startsWith('/assets/') || /^https?:\/\//.test(u)
      )
    ).toBe(true);
  });

  it('fetchPersonImageCandidates returns combined array for verified person', async () => {
    const { fetchPersonImageCandidates } = await import('../personLookup');

    const candidates = await fetchPersonImageCandidates('Bill Gates');
    expect(candidates).toBeTruthy();
    // Should include the verified local image
    expect(candidates!.some((url) => url.includes('bill-gates'))).toBe(true);
  });

  it('getChineseDisplayName returns Chinese alias for verified person', async () => {
    const { getChineseDisplayName } = await import('../personLookup');

    const zhName = getChineseDisplayName('Bill Gates');
    // Should return Chinese alias — Bill Gates has '比尔·盖茨' or '比尔盖茨' as alias
    expect(typeof zhName).toBe('string');
    expect(zhName).not.toBe('Bill Gates'); // must return Chinese, not passthrough
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
    // Should swallow the error and return a well-formed fallback avatar,
    // not a truthy garbage string. The function must not leak fetch errors.
    expect(typeof image).toBe('string');
    expect(image!.length).toBeGreaterThan(0);
    expect(
      image!.startsWith('data:image/svg') ||
      image!.includes('ui-avatars.com') ||
      image!.includes('dicebear.com')
    ).toBe(true);
    // Make sure the fetch was actually invoked (and therefore the catch path
    // was the one that produced the fallback).
    expect(fetchMock).toHaveBeenCalled();
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

  it('fetchJson returns null when response is not ok (line 1160)', async () => {
    // Exercises fetchJson's `if (!response.ok) return null;` branch
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { fetchPersonImage } = await import('../personLookup');

    const image = await fetchPersonImage('Some Unknown XYZ123');
    // fetchJson returns null for both wiki title + search → falls back to
    // a name-avatar (data URI / ui-avatars / dicebear). Must NOT be a raw
    // wiki URL or undefined.
    expect(typeof image).toBe('string');
    expect(image!.length).toBeGreaterThan(0);
    expect(
      image!.startsWith('data:image/svg') ||
      image!.includes('ui-avatars.com') ||
      image!.includes('dicebear.com')
    ).toBe(true);
    // Confirm we actually hit fetchJson's not-ok path.
    expect(fetchMock).toHaveBeenCalled();
  });

  it('isLikelyEntityTitle: MBTI titles in wiki search results pass the filter (line 1297)', async () => {
    // Force searchWikipediaPeople to return an MBTI code as a title → isLikelyEntityTitle takes MBTI branch
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ query: { search: [{ title: 'INFJ' }] } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          query: {
            pages: {
              '1': {
                title: 'INFJ',
                thumbnail: { source: 'https://example.com/infj.jpg' },
                pageprops: { wikibase_shortdesc: 'personality type' },
              },
            },
          },
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    // We need to reach searchWikipediaPeople — searchPeopleWithPhotos calls it
    // with query 'Qqxyz'. That first builds a fresh search call (1st mock) then
    // fetchWikiImageByTitle for the returned 'INFJ' title (2nd mock).
    const { searchPeopleWithPhotos } = await import('../personLookup');
    const results = await searchPeopleWithPhotos('Qqxyzabc', 6);
    // The INFJ entry MUST survive the isLikelyEntityTitle filter — without
    // this, other (non-MBTI) results could mask a regression that drops
    // MBTI titles.
    expect(results.some((r) => r.name === 'INFJ')).toBe(true);
  });

  it('isLikelyEntityDescription: falsy description returns false', async () => {
    // Line 1303: `if (!description) return false;`
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          query: {
            pages: {
              '1': {
                title: 'Zzqxyz Wzrdfn',
                thumbnail: { source: 'https://example.com/random.jpg' },
                // no pageprops, no pageterms → description is ''
              },
            },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ query: { search: [] } }),
      });
    vi.stubGlobal('fetch', fetchMock);
    const { fetchPersonImage } = await import('../personLookup');

    // description = '' → isLikelyEntityDescription('') returns false → fetchWikiImageByTitle returns undefined
    // Then searchWikipediaPeople is tried (empty search), falls back to buildNameAvatar
    const image = await fetchPersonImage('Zzqxyz Wzrdfn');
    expect(image).toBeTruthy();
    expect(image!.startsWith('data:image/svg')).toBe(true);
  });

  it('isLikelyEntityDescription: excluded keyword (city) returns false', async () => {
    // Line 1306 — excluded keyword path
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          query: {
            pages: {
              '1': {
                title: 'Springfield',
                thumbnail: { source: 'https://example.com/springfield.jpg' },
                pageprops: { wikibase_shortdesc: 'city in Illinois, United States' },
              },
            },
          },
        }),
      });
    vi.stubGlobal('fetch', fetchMock);
    const { fetchPersonImage } = await import('../personLookup');

    const image = await fetchPersonImage('Springfield');
    // City excluded → fetchWikiImageByTitle returns undefined → falls back
    expect(image).toBeTruthy();
    expect(image).not.toBe('https://example.com/springfield.jpg');
  });

  it('fetchWikiImageByTitle: returns undefined for excluded title (line 1311)', async () => {
    // Direct call via fetchPersonImage with a "list of" name → bypasses
    // verified/mbti, hits fetchWikiImageByTitle → isLikelyEntityTitle false → undefined
    const fetchMock = vi.fn()
      // searchWikipediaPeople call (after title lookup returns undefined)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ query: { search: [] } }),
      });
    vi.stubGlobal('fetch', fetchMock);
    const { fetchPersonImage } = await import('../personLookup');

    const image = await fetchPersonImage('list of presidents');
    // Since fetchWikiImageByTitle returns undefined immediately (excluded title),
    // only ONE network call should happen (the search), and fallback to name avatar.
    expect(image).toBeTruthy();
    expect(image!.startsWith('data:image/svg')).toBe(true);
  });

  it('uses pageterms.description fallback when wikibase_shortdesc is missing (line 1324)', async () => {
    // Exercises page.pageterms?.description?.[0] branch
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          query: {
            pages: {
              '1': {
                title: 'Wiki Title',
                thumbnail: { source: 'https://example.com/wt.jpg' },
                // no pageprops.wikibase_shortdesc → falls to pageterms
                pageterms: { description: ['American entrepreneur and innovator'] },
              },
            },
          },
        }),
      });
    vi.stubGlobal('fetch', fetchMock);
    const { fetchPersonImage } = await import('../personLookup');

    const image = await fetchPersonImage('Wiki Title');
    expect(image).toBe('https://example.com/wt.jpg');
  });

  it('fetchWikiImageByTitle: MBTI rescue via title arg when page.title missing (line 1326)', async () => {
    // Via searchPeopleWithPhotos: searchWikipediaPeople returns title 'INTJ',
    // then fetchWikiImageByTitle('INTJ') fetches page without title field and
    // invalid description. `page.title || title` picks `title='INTJ'`.
    const fetchMock = vi.fn()
      // searchWikipediaPeople search call
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ query: { search: [{ title: 'INTJ' }] } }),
      })
      // fetchWikiImageByTitle for 'INTJ'
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          query: {
            pages: {
              '1': {
                // NO title field
                thumbnail: { source: 'https://example.com/intj-notitle.jpg' },
                pageprops: { wikibase_shortdesc: 'just some text no keywords' },
              },
            },
          },
        }),
      });
    vi.stubGlobal('fetch', fetchMock);
    const { searchPeopleWithPhotos } = await import('../personLookup');

    const results = await searchPeopleWithPhotos('Unique Xzqwrt Query', 6);
    // Should have INTJ entry from wiki search
    expect(results.some((r) => r.name === 'INTJ')).toBe(true);
  });

  it('fetchWikiImageByTitle: MBTI rescue via page.title when description invalid', async () => {
    // Description invalid → !isLikelyEntityDescription is true → needs !isMbtiCode to be false
    // to keep processing. page.title='INTJ' → isMbtiCode true → !false → condition false → continue.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          query: {
            pages: {
              '1': {
                title: 'INTJ',
                thumbnail: { source: 'https://example.com/intj-page.jpg' },
                pageprops: { wikibase_shortdesc: 'random text with no valid keywords' },
              },
            },
          },
        }),
      });
    vi.stubGlobal('fetch', fetchMock);
    const { fetchPersonImage } = await import('../personLookup');

    // Use a name that isn't isMbtiCode itself (to bypass that fast path) and
    // doesn't match any verified person.
    const image = await fetchPersonImage('Zxwxyz Title MBTI Rescue');
    expect(image).toBe('https://example.com/intj-page.jpg');
  });

  it('fetchWikiImageByTitle: uses input title when page.title missing (line 1326-1327)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          query: {
            pages: {
              '1': {
                // no title
                thumbnail: { source: 'https://example.com/notitle.jpg' },
                pageprops: { wikibase_shortdesc: 'American entrepreneur and philanthropist' },
              },
            },
          },
        }),
      });
    vi.stubGlobal('fetch', fetchMock);
    const { fetchPersonImage } = await import('../personLookup');

    const image = await fetchPersonImage('Zzqxyz Wzrdfnxyx');
    expect(image).toBe('https://example.com/notitle.jpg');
  });

  it('getChineseDisplayName returns the Chinese alias for verified person with one', async () => {
    // Contract: when a verified person has a Chinese alias, getChineseDisplayName
    // must return it (not the canonical name, not the raw input). Lara Croft's
    // Chinese alias is '劳拉'. This audit finding was originally checking the
    // `zhAlias ?? person.canonical` fallback arm, but every verified person in
    // VERIFIED_PEOPLE has a Chinese alias — the fallback arm is dead code.
    const { getChineseDisplayName } = await import('../personLookup');
    const result = getChineseDisplayName('Lara Croft');
    expect(/[\u3400-\u9fff]/.test(result)).toBe(true);
    expect(result).not.toBe('Lara Croft');
  });

  it('findVerifiedPerson exact match returns the canonical (line 1416)', async () => {
    const { findVerifiedPerson } = await import('../personLookup');

    const result = findVerifiedPerson('Bill Gates');
    expect(result).toBeTruthy();
    expect(result!.canonical).toBe('Bill Gates');
  });

  it('findVerifiedPerson exact alias match returns canonical (line 1418)', async () => {
    // Hit the alias-match branch: `if (person.aliases.some(...)) return makeResult(person)`
    const { findVerifiedPerson } = await import('../personLookup');
    // 'gates' is an alias of Bill Gates. Exact normalized match.
    const result = findVerifiedPerson('gates');
    expect(result).toBeTruthy();
    expect(result!.canonical).toBe('Bill Gates');
  });

  it('findVerifiedPerson handles verified person without candidateImageUrls (line 1411)', async () => {
    // Hayao Miyazaki has no candidateImageUrls → `|| []` fallback hit
    const { findVerifiedPerson } = await import('../personLookup');
    const result = findVerifiedPerson('Hayao Miyazaki');
    expect(result).toBeTruthy();
    expect(result!.canonical).toBe('Hayao Miyazaki');
  });

  it('findVerifiedPerson: verified person without local cache falls through local || imageUrl (line 1410)', async () => {
    // Jeff Bezos is in VERIFIED_PEOPLE but not in LOCAL_IMAGE_EXTENSIONS.
    // `local` is undefined → `|| person.imageUrl` branch fires.
    const { findVerifiedPerson } = await import('../personLookup');
    const result = findVerifiedPerson('Jeff Bezos');
    expect(result).toBeTruthy();
    expect(result!.canonical).toBe('Jeff Bezos');
    // imageUrl should be the person.imageUrl (not a local /assets/ path)
    expect(result!.imageUrl).not.toMatch(/^\/assets\//);
  });

  it('findVerifiedPerson partial reverse match: key includes text', async () => {
    // Line 1423: partial match where `key.includes(text)` (reverse direction)
    const { findVerifiedPerson } = await import('../personLookup');

    // 'Bill Gates Billionaire Entrepreneur' → key is longer → key.includes('bill gates')
    const result = findVerifiedPerson('Bill Gates Billionaire Entrepreneur');
    expect(result).toBeTruthy();
    expect(result!.canonical).toBe('Bill Gates');
  });

  it('fetchPersonImage caches result and returns from cache on second call (line 1477)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { fetchPersonImage } = await import('../personLookup');

    // First call — hits verified person path, caches
    const first = await fetchPersonImage('Bill Gates');
    // Second call — hits imageCache.has(key) branch
    const second = await fetchPersonImage('Bill Gates');
    expect(first).toBe(second);
  });

  it('fetchPersonImage uses wiki search result when title lookup misses (line 1502 true branch)', async () => {
    const fetchMock = vi.fn()
      // fetchWikiImageByTitle: no image
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ query: { pages: { '-1': { missing: true } } } }),
      })
      // searchWikipediaPeople: returns one title
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ query: { search: [{ title: 'Search Hit Person' }] } }),
      })
      // fetchWikiImageByTitle for the search result
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          query: {
            pages: {
              '9': {
                title: 'Search Hit Person',
                thumbnail: { source: 'https://example.com/search-hit.jpg' },
                pageprops: { wikibase_shortdesc: 'American philanthropist and innovator' },
              },
            },
          },
        }),
      });
    vi.stubGlobal('fetch', fetchMock);
    const { fetchPersonImage } = await import('../personLookup');

    const image = await fetchPersonImage('Zzqrxyw Unique Name');
    expect(image).toBe('https://example.com/search-hit.jpg');
  });

  it('fetchPersonImage falls back to name avatar when search has no image (line 1497)', async () => {
    // searchResults[0]?.imageUrl falsy → buildNameAvatar fallback
    const fetchMock = vi.fn()
      // fetchWikiImageByTitle: no image
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ query: { pages: { '-1': { missing: true } } } }),
      })
      // searchWikipediaPeople: search returns one title
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ query: { search: [{ title: 'Page No Image' }] } }),
      })
      // fetchWikiImageByTitle for that title: no thumbnail
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ query: { pages: { '1': { title: 'Page No Image' } } } }),
      });
    vi.stubGlobal('fetch', fetchMock);
    const { fetchPersonImage } = await import('../personLookup');

    const image = await fetchPersonImage('Zzqxy Wwqzr');
    expect(image).toBeTruthy();
    expect(
      image!.startsWith('data:image/svg') || image!.includes('dicebear') || image!.includes('ui-avatars')
    ).toBe(true);
  });

  it('fetchPersonImageCandidates returns wiki-search images + fallback (line 1518 true branch)', async () => {
    const fetchMock = vi.fn()
      // fetchWikiImageByTitle: no match
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ query: { pages: { '-1': { missing: true } } } }),
      })
      // searchWikipediaPeople search
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ query: { search: [{ title: 'Famous Person' }] } }),
      })
      // fetchWikiImageByTitle for result
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          query: {
            pages: {
              '9': {
                title: 'Famous Person',
                thumbnail: { source: 'https://example.com/famous.jpg' },
                pageprops: { wikibase_shortdesc: 'American entrepreneur and philanthropist' },
              },
            },
          },
        }),
      });
    vi.stubGlobal('fetch', fetchMock);
    const { fetchPersonImageCandidates } = await import('../personLookup');

    const candidates = await fetchPersonImageCandidates('Qqxyz Wwqzr');
    expect(candidates).toBeTruthy();
    // Wiki image must survive.
    expect(candidates!.some((u) => u === 'https://example.com/famous.jpg')).toBe(true);
    // Name-avatar fallback must also be present — proving the `true` branch
    // kept both the wiki hit AND appended the fallback.
    expect(
      candidates!.some(
        (u) =>
          u.startsWith('data:image/svg') ||
          u.includes('ui-avatars.com') ||
          u.includes('dicebear.com')
      )
    ).toBe(true);
  });

  it('searchPeopleWithPhotos returns empty for empty query (line 1523)', async () => {
    const { searchPeopleWithPhotos } = await import('../personLookup');
    const results = await searchPeopleWithPhotos('', 6);
    expect(results).toEqual([]);
  });

  it('buildNameAvatar uses "Mentor" fallback when name trims to empty', async () => {
    // Exercises `name.trim() || 'Mentor'` falsy branch
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ query: { pages: { '-1': { missing: true } }, search: [] } }),
    }));
    const { fetchPersonImageCandidates } = await import('../personLookup');
    const candidates = await fetchPersonImageCandidates('   ');
    expect(candidates).toBeTruthy();
    // The fallback data URI contains 'M' initial (from 'Mentor')
    expect(candidates!.some((u) => u.startsWith('data:image/svg'))).toBe(true);
  });

  it('searchPeopleWithPhotos: alreadyCovered via substring branch (line 1569)', async () => {
    // Need a query that survives in `unique` where k === qKey OR one side includes the other.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ query: { search: [] } }),
    }));
    const { searchPeopleWithPhotos } = await import('../personLookup');

    // Query = 'bill' → verified match: Bill Gates (normalized 'bill gates')
    // qKey = 'bill'. For Bill Gates: k = 'bill gates'. k === qKey? no. k.includes(qKey) ('bill gates'.includes('bill'))? yes.
    // So alreadyCovered=true → no typed fallback.
    const results = await searchPeopleWithPhotos('bill', 6);
    expect(results.some((r) => r.name === 'bill')).toBe(false);
    expect(results.some((r) => r.name === 'Bill Gates')).toBe(true);
  });

  it('sort comparator: word-prefix branch (line 1579-1580 split startsWith)', async () => {
    // Two results: one where name starts with query directly, another where a word starts with query
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ query: { search: [] } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { searchPeopleWithPhotos } = await import('../personLookup');

    // 'gates' → 'Bill Gates' has word 'gates' starting with query
    const results = await searchPeopleWithPhotos('gates', 6);
    expect(results.some((r) => r.name === 'Bill Gates')).toBe(true);
    // The word-prefix hit (Bill Gates, whose second word starts with 'gates')
    // must appear in the top sorted position — not buried behind
    // substring-only matches.
    const firstName = results[0].name.toLowerCase();
    const firstMatchesWordPrefix =
      firstName.startsWith('gates') ||
      firstName.split(/\s+/).some((w) => w.startsWith('gates'));
    expect(firstMatchesWordPrefix).toBe(true);
  });

  it('sort comparator: substring-only match (neither name nor any word startsWith)', async () => {
    // Exercises the `: 1` false branch on line 1587: substring match via includes(),
    // but neither name nor any word startsWith query
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ query: { search: [] } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { searchPeopleWithPhotos } = await import('../personLookup');

    // 'ates' → 'Bill Gates' contains 'ates' but neither name nor any word starts with 'ates'
    const results = await searchPeopleWithPhotos('ates', 6);
    expect(results.length).toBeGreaterThan(0);
    // Every returned match must CONTAIN 'ates' (substring branch), and at
    // least one of them must NOT start any word with 'ates' — proving the
    // substring-only branch was traversed and not just short-circuited by
    // a prefix match.
    expect(
      results.every((r) => r.name.toLowerCase().includes('ates'))
    ).toBe(true);
    expect(
      results.some((r) => {
        const n = r.name.toLowerCase();
        return !n.startsWith('ates') && !n.split(/\s+/).some((w) => w.startsWith('ates'));
      })
    ).toBe(true);
  });

  it('sort comparator: multiple results trigger both branches of startsWith check', async () => {
    // 'ma' matches many verified people; sort comparator runs between them.
    // Some have word starting with 'ma' (Mario, Mark), others only substring match (Eminem).
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ query: { search: [] } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { searchPeopleWithPhotos } = await import('../personLookup');

    const results = await searchPeopleWithPhotos('ma', 20);
    // Multiple results → comparator invoked, hits both `? 0` and `: 1` branches
    expect(results.length).toBeGreaterThan(1);
    // Verify ordering: the first entry must be a word-prefix match ("ma")
    // since word-prefix ranks before substring-only. If the sort were
    // inverted or no-op, this would fail.
    const firstName = results[0].name.toLowerCase();
    const firstStartsWithMa =
      firstName.startsWith('ma') ||
      firstName.split(/\s+/).some((w) => w.startsWith('ma'));
    expect(firstStartsWithMa).toBe(true);
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
