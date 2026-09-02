import { useEffect, useState } from 'react';
import {
  PersonOption,
  findVerifiedPerson,
  searchPeopleWithPhotos,
  searchVerifiedPeopleLocal,
} from '../../../features/mentorTable/personLookup';
import { getSuggestedPeople } from '../../../features/mentorTable/mentorProfiles';

/**
 * : person-search behavior extracted from MentorTablePage.
 *
 * Instant local results (VERIFIED_PEOPLE + MENTOR_PROFILES) render on the
 * same keystroke; the remote search (verified + Wikipedia in DEV) merges in
 * after a 120ms debounce. Unmount/query-change cancels the in-flight merge.
 */
export function usePersonSearch(personQuery: string): {
  suggestions: PersonOption[];
  isSearching: boolean;
} {
  const [suggestions, setSuggestions] = useState<PersonOption[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  useEffect(() => {
    const query = personQuery.trim();
    if (!query) {
      setSuggestions([]);
      setIsSearching(false);
      return;
    }

    // ── Instant local results (sync, 0ms) ──
    // Try VERIFIED_PEOPLE search first, then fall back to MENTOR_PROFILES only
    let verifiedHits: PersonOption[] = [];
    try {
      verifiedHits = searchVerifiedPeopleLocal(query);
    } catch {
      // searchVerifiedPeopleLocal may not be available (module HMR / cache)
    }

    let profileHits: PersonOption[] = [];
    try {
      profileHits = getSuggestedPeople(query).map((p) => {
        let img: string | undefined;
        let candidates: string[] | undefined;
        try {
          const v = findVerifiedPerson(p.displayName);
          img = v?.imageUrl;
          candidates = v?.candidateImageUrls;
        } catch { /* findVerifiedPerson may not be available */ }
        return { name: p.displayName, imageUrl: img, candidateImageUrls: candidates } as PersonOption;
      });
    } catch { /* getSuggestedPeople fallback */ }

    const localUnique = new Map<string, PersonOption>();
    for (const p of [...verifiedHits, ...profileHits]) {
      const k = p.name.trim().toLowerCase();
      if (k && !localUnique.has(k)) localUnique.set(k, p);
    }
    const instantResults = Array.from(localUnique.values()).slice(0, 8);
    setSuggestions(instantResults);

    // If we already have local matches, don't show "Searching..." spinner
    const hasLocalHits = instantResults.length > 0;
    setIsSearching(!hasLocalHits);

    // ── Background remote search (async, debounced 120ms) ──
    // searchPeopleWithPhotos ALSO searches VERIFIED_PEOPLE + Wikipedia,
    // so even if local search failed, remote will fill in verified results.
    let alive = true;
    const timer = window.setTimeout(async () => {
      try {
        const remote = await searchPeopleWithPhotos(query);
        if (!alive) return;

        // Merge: verified local results first (most reliable), then remote
        const merged = new Map<string, PersonOption>();
        for (const p of [...verifiedHits, ...remote, ...instantResults]) {
          const k = p.name.trim().toLowerCase();
          if (k && !merged.has(k)) merged.set(k, p);
        }

        setSuggestions(Array.from(merged.values()).slice(0, 8));
      } catch {
        // Remote search failed — keep whatever local results we have
        if (!alive) return;
      } finally {
        if (alive) setIsSearching(false);
      }
    }, 120);

    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [personQuery]);

  return { suggestions, isSearching };
}
