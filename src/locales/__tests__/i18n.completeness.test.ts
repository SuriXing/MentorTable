import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const LOCALES_DIR = resolve(__dirname, '../../locales');
const PAGE_SRC = resolve(__dirname, '../../components/pages/MentorTablePage.tsx');

const locales = readdirSync(LOCALES_DIR).filter(
  (d) => !d.startsWith('.') && readdirSync(join(LOCALES_DIR, d)).includes('translation.json')
);

function load(lng: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(LOCALES_DIR, lng, 'translation.json'), 'utf-8'));
}

function flatKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    typeof v === 'object' && v !== null ? flatKeys(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`]
  );
}

describe('i18n completeness (F165, P18/P19)', () => {
  const resources: Record<string, Record<string, unknown>> = Object.fromEntries(
    locales.map((lng) => [lng, load(lng)])
  );

  it('every locale has the same key set as en (parity)', () => {
    const en = new Set(flatKeys(resources.en));
    for (const lng of locales) {
      if (lng === 'en') continue;
      const keys = new Set(flatKeys(resources[lng]));
      const missing = [...en].filter((k) => !keys.has(k));
      const extra = [...keys].filter((k) => !en.has(k));
      expect({ lng, missing, extra }).toEqual({ lng, missing: [], extra: [] });
    }
  });

  it('every mt.* key used in the page exists in every locale with a non-empty value', () => {
    const page = readFileSync(PAGE_SRC, 'utf-8');
    const used = new Set([...page.matchAll(/tI18n\('(mt\.[A-Za-z0-9_]+)'/g)].map((m) => m[1]));
    expect(used.size).toBeGreaterThan(60);
    for (const lng of locales) {
      for (const key of used) {
        const value = resources[lng][key];
        expect({ lng, key, value: typeof value === 'string' ? value : undefined }).toEqual({
          lng,
          key,
          value: expect.stringMatching(/.+/),
        });
      }
    }
  });

  it('mt.* keys never fall back to defaultValue in the page', () => {
    const page = readFileSync(PAGE_SRC, 'utf-8');
    const withDefaults = [...page.matchAll(/tI18n\('mt\.[A-Za-z0-9_]+',\s*\{/g)].map((m) => m[0]);
    expect(withDefaults).toEqual([]);
  });

  it('zh and en mt.* values are actually different languages (spot check)', () => {
    for (const key of ['mt.you', 'mt.restart', 'mt.generateFailedHint']) {
      const zh = resources['zh-CN'][key];
      const en = resources.en[key];
      expect(zh).not.toEqual(en);
    }
  });
});
