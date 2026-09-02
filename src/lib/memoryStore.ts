export interface MemoryCard {
  id: string;
  title: string;
  createdAt: string;
  takeaways: string[];
}

export const MEMORY_STORE_KEY = 'mentorTableMemories';
const SCHEMA_VERSION = 1;
const MAX_MEMORIES = 50;

interface VersionedMemoryStore {
  version: number;
  memories: MemoryCard[];
}

/**
 * : memories previously lived only in React state — a refresh
 * silently destroyed every saved conversation. This module is the sole
 * owner of the localStorage surface: load (with migration), save (bounded,
 * quota-safe), clear.
 */

function isMemoryCard(value: unknown): value is MemoryCard {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.title === 'string' &&
    typeof v.createdAt === 'string' &&
    Array.isArray(v.takeaways) &&
    v.takeaways.every((t) => typeof t === 'string')
  );
}

/** Migrate any legacy shape to the current schema. Unknown shapes → []. */
export function migrateMemories(raw: unknown): MemoryCard[] {
  // v1 envelope
  if (
    raw &&
    typeof raw === 'object' &&
    (raw as Record<string, unknown>).version === SCHEMA_VERSION &&
    Array.isArray((raw as Record<string, unknown>).memories)
  ) {
    return ((raw as Record<string, unknown>).memories as unknown[]).filter(isMemoryCard);
  }
  // v0 legacy: bare array of memory cards (pre-versioning writes)
  if (Array.isArray(raw)) {
    return raw.filter(isMemoryCard);
  }
  return [];
}

export function loadMemories(storage: Storage = localStorage): MemoryCard[] {
  try {
    const raw = storage.getItem(MEMORY_STORE_KEY);
    if (!raw) return [];
    return migrateMemories(JSON.parse(raw));
  } catch {
    // Corrupt JSON or unavailable storage (private mode) — start empty,
    // never crash the page for a cache.
    return [];
  }
}

export function saveMemories(memories: MemoryCard[], storage: Storage = localStorage): void {
  try {
    // Bound the store: newest first, drop the tail. A runaway table user
    // cannot grow localStorage without limit.
    const payload: VersionedMemoryStore = {
      version: SCHEMA_VERSION,
      memories: memories.slice(0, MAX_MEMORIES),
    };
    storage.setItem(MEMORY_STORE_KEY, JSON.stringify(payload));
  } catch {
    // QuotaExceededError / private mode — persistence is best-effort.
  }
}

export function clearMemories(storage: Storage = localStorage): void {
  try {
    storage.removeItem(MEMORY_STORE_KEY);
  } catch {
    // best-effort
  }
}
