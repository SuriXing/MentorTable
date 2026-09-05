import { describe, expect, it } from 'vitest';
import mentorsContract from '../../../../shared/mentors-contract.json';
import en from '../../../locales/en/translation.json';
import es from '../../../locales/es/translation.json';
import ja from '../../../locales/ja/translation.json';
import ko from '../../../locales/ko/translation.json';
import zhCN from '../../../locales/zh-CN/translation.json';
import { findVerifiedPerson } from '../personLookup';
import { ROUNDTABLE_PRESETS } from '../roundtablePresets';

const localeResources = { en, es, ja, ko, 'zh-CN': zhCN };

describe('roundtable presets', () => {
  it('keeps preset ids, translation keys, and mentor rosters valid', () => {
    expect(new Set(ROUNDTABLE_PRESETS.map((preset) => preset.id)).size).toBe(
      ROUNDTABLE_PRESETS.length
    );

    for (const preset of ROUNDTABLE_PRESETS) {
      expect(preset.mentorNames.length).toBeGreaterThan(0);
      expect(preset.mentorNames.length).toBeLessThanOrEqual(mentorsContract.mentorsMax);
      expect(new Set(preset.mentorNames).size).toBe(preset.mentorNames.length);

      for (const mentorName of preset.mentorNames) {
        expect(findVerifiedPerson(mentorName)?.canonical).toBe(mentorName);
      }

      for (const [locale, resources] of Object.entries(localeResources)) {
        for (const key of [preset.titleKey, preset.questionKey]) {
          const value = (resources as Record<string, unknown>)[key];
          expect({ locale, key, value }).toEqual({
            locale,
            key,
            value: expect.stringMatching(/\S/),
          });
          expect(value).not.toBe(key);
        }
      }
    }
  });
});
