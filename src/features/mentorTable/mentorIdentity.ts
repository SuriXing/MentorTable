import { getChineseDisplayName } from './personLookup';

/**
 * Identity semantics for mentor names, in one home. The page used to own
 * three scattered helpers whose rules relayed through useSessionFlow and
 * useMentorNotes as opaque function options; consumers now build their
 * resolvers here so key normalization, canonical resolution, and locale
 * naming cannot drift apart.
 */

/** Canonical bucket key for a mentor name (thread keys, reply matching). */
export const normalizeMentorKey = (value: string): string =>
  value.trim().toLowerCase().replace(/\s+/g, '_');

/**
 * Resolve a raw name to the roster's canonical name. Falls back to the raw
 * input for names outside the current roster (custom mentors are added to
 * the roster before they can be addressed).
 */
export const makeMentorNameResolver =
  (selectedPeople: ReadonlyArray<{ name: string }>) =>
  (rawName: string): string => {
    const key = normalizeMentorKey(rawName);
    const fromSelectedPeople = selectedPeople.find((p) => normalizeMentorKey(p.name) === key);
    if (fromSelectedPeople) return fromSelectedPeople.name;
    return rawName;
  };

/**
 * Locale-aware display name: verify-canonical resolution first, then the
 * Chinese display name in zh contexts.
 */
export const makeLocalizedName =
  (options: { isZh: boolean; resolveDisplayName: (name: string) => string }) =>
  (name: string): string => {
    const canonical = options.resolveDisplayName(name);
    if (!options.isZh) return canonical;
    return getChineseDisplayName(canonical);
  };
