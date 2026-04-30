// Test-global normalization for localStorage/sessionStorage.
//
// Node 22.4+ ships an experimental `localStorage` global. On Node 25+/26 it is
// exposed by default: without `--localstorage-file` it is an unusable stub
// (209 phantom test failures), and WITH the flag it becomes one shared
// file-backed store across every test file — concurrent vitest workers then
// clobber each other's writes (last-writer-wins), which made suite results
// depend on worker scheduling (1-3 random failures per full run, green solo).
//
// The shadowing also reaches jsdom itself: in the vitest jsdom environment
// `window === globalThis`, so `window.localStorage` resolves to Node's stub
// and jsdom's own storage stays unreachable. Node 24 (CI) never defines the
// global, which is why CI stayed green while local runs did not.
//
// This setup installs a spec-shaped in-memory Storage backed by a Map.
// setupFiles run once per test file in a fresh environment, so every file
// gets an isolated store on every Node version. No flag needed.
class MemoryStorage {
  private map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }

  getItem(key: string): string | null {
    const value = this.map.get(String(key));
    return value === undefined ? null : value;
  }

  setItem(key: string, value: string): void {
    this.map.set(String(key), String(value));
  }

  removeItem(key: string): void {
    this.map.delete(String(key));
  }

  clear(): void {
    this.map.clear();
  }
}

for (const name of ['localStorage', 'sessionStorage'] as const) {
  Object.defineProperty(globalThis, name, {
    value: new MemoryStorage(),
    writable: true,
    configurable: true,
  });
}
