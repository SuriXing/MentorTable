type RoundtablePresetTitleKey =
  | 'mt.presetStartup'
  | 'mt.presetCareer'
  | 'mt.presetCreative';

type RoundtablePresetQuestionKey =
  | 'mt.presetStartupQuestion'
  | 'mt.presetCareerQuestion'
  | 'mt.presetCreativeQuestion';

export interface RoundtablePreset {
  id: 'startup' | 'career' | 'creative';
  titleKey: RoundtablePresetTitleKey;
  questionKey: RoundtablePresetQuestionKey;
  mentorNames: readonly string[];
}

export const ROUNDTABLE_PRESETS = [
  {
    id: 'startup',
    titleKey: 'mt.presetStartup',
    questionKey: 'mt.presetStartupQuestion',
    mentorNames: ['Steve Jobs', 'Bill Gates', 'Oprah Winfrey'],
  },
  {
    id: 'career',
    titleKey: 'mt.presetCareer',
    questionKey: 'mt.presetCareerQuestion',
    mentorNames: ['Satya Nadella', 'Kobe Bryant', 'Oprah Winfrey'],
  },
  {
    id: 'creative',
    titleKey: 'mt.presetCreative',
    questionKey: 'mt.presetCreativeQuestion',
    mentorNames: ['Hayao Miyazaki', 'Steve Jobs', 'Taylor Swift'],
  },
] as const satisfies readonly RoundtablePreset[];
