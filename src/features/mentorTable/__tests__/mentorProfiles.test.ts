import {
  createCustomMentorProfile,
  getCartoonAvatarUrl,
  getMentorProfile,
  getMentorProfiles,
  getSuggestedPeople,
  MENTOR_PROFILES
} from '../mentorProfiles';

describe('mentorProfiles', () => {
  describe('getMentorProfile', () => {
    it('returns the correct profile for each builtin ID', () => {
      const ids = ['bill_gates', 'oprah_winfrey', 'kobe_bryant', 'miyazaki_hayao', 'elon_musk'] as const;
      for (const id of ids) {
        const profile = getMentorProfile(id);
        expect(profile.id).toBe(id);
        expect(profile.displayName).toBeTruthy();
        expect(profile.speakingStyle.length).toBeGreaterThan(0);
        expect(profile.coreValues.length).toBeGreaterThan(0);
        expect(profile.decisionPatterns.length).toBeGreaterThan(0);
      }
    });
  });

  describe('getMentorProfiles', () => {
    it('returns profiles in order for given IDs', () => {
      const profiles = getMentorProfiles(['kobe_bryant', 'bill_gates']);
      expect(profiles).toHaveLength(2);
      expect(profiles[0].id).toBe('kobe_bryant');
      expect(profiles[1].id).toBe('bill_gates');
    });

    it('returns empty array for empty input', () => {
      expect(getMentorProfiles([])).toEqual([]);
    });
  });

  describe('getSuggestedPeople', () => {
    it('maps a builtin person name back to the builtin mentor persona', () => {
      const profile = createCustomMentorProfile('Bill Gates');
      expect(profile.id).toBe('bill_gates');
      expect(profile.displayName).toBe('Bill Gates');
      expect(profile.coreValues).toContain('learning velocity');
      expect(profile.decisionPatterns).toContain('define the bottleneck first');
    });

    it('finds mentors by partial name match', () => {
      expect(getSuggestedPeople('opra').map((p) => p.id)).toContain('oprah_winfrey');
    });

    it('finds mentors by keyword (microsoft -> bill_gates)', () => {
      expect(getSuggestedPeople('microsoft').map((p) => p.id)).toContain('bill_gates');
    });

    it('finds mentors by keyword (ghibli -> miyazaki)', () => {
      expect(getSuggestedPeople('ghibli').map((p) => p.id)).toContain('miyazaki_hayao');
    });

    it('finds mentors by keyword (mamba -> kobe)', () => {
      expect(getSuggestedPeople('mamba').map((p) => p.id)).toContain('kobe_bryant');
    });

    it('finds mentors by keyword (tesla -> elon)', () => {
      expect(getSuggestedPeople('tesla').map((p) => p.id)).toContain('elon_musk');
    });

    it('finds mentors by keyword (spacex -> elon)', () => {
      expect(getSuggestedPeople('spacex').map((p) => p.id)).toContain('elon_musk');
    });

    it('returns empty array for empty query', () => {
      expect(getSuggestedPeople('')).toEqual([]);
    });

    it('returns empty array for whitespace-only query', () => {
      expect(getSuggestedPeople('   ')).toEqual([]);
    });

    it('returns empty array for no match', () => {
      expect(getSuggestedPeople('xyznonexistent')).toEqual([]);
    });

    it('respects the limit parameter', () => {
      // 'a' matches multiple mentors (gates, oprah, miyazaki, mamba, etc.)
      const limited = getSuggestedPeople('a', 2);
      expect(limited.length).toBeLessThanOrEqual(2);
    });

    it('is case-insensitive', () => {
      expect(getSuggestedPeople('BILL').map((p) => p.id)).toContain('bill_gates');
    });
  });

  describe('createCustomMentorProfile - builtin name mapping', () => {
    it('maps "bill" to bill_gates', () => {
      const profile = createCustomMentorProfile('bill');
      expect(profile.id).toBe('bill_gates');
    });

    it('maps "oprah" to oprah_winfrey', () => {
      const profile = createCustomMentorProfile('oprah');
      expect(profile.id).toBe('oprah_winfrey');
    });

    it('maps "kobe" to kobe_bryant', () => {
      const profile = createCustomMentorProfile('kobe');
      expect(profile.id).toBe('kobe_bryant');
    });

    it('maps "miyazaki" to miyazaki_hayao', () => {
      const profile = createCustomMentorProfile('miyazaki');
      expect(profile.id).toBe('miyazaki_hayao');
    });

    it('maps "hayao" to miyazaki_hayao', () => {
      const profile = createCustomMentorProfile('hayao');
      expect(profile.id).toBe('miyazaki_hayao');
    });

    it('maps "elon" to elon_musk', () => {
      const profile = createCustomMentorProfile('elon');
      expect(profile.id).toBe('elon_musk');
    });

    it('maps "musk" to elon_musk', () => {
      const profile = createCustomMentorProfile('musk');
      expect(profile.id).toBe('elon_musk');
    });

    it('preserves the display name when mapping to builtin', () => {
      const profile = createCustomMentorProfile('My Friend Bill');
      expect(profile.id).toBe('bill_gates');
      expect(profile.displayName).toBe('My Friend Bill');
      expect(profile.shortLabel).toBe('My');
    });
  });

  describe('createCustomMentorProfile - known personas', () => {
    it('builds a known custom persona with distinct traits', () => {
      const profile = createCustomMentorProfile('Lisa Su');
      expect(profile.id).toBe('custom_lisa_su');
      expect(profile.displayName).toBe('Lisa Su');
      expect(profile.speakingStyle).toContain('direct and engineering-focused');
      expect(profile.coreValues).toContain('technical excellence');
    });

    it('recognizes Satya Nadella', () => {
      const profile = createCustomMentorProfile('Satya Nadella');
      expect(profile.id).toBe('custom_satya_nadella');
      expect(profile.speakingStyle).toContain('calm and empathetic');
      expect(profile.coreValues).toContain('clarity');
      expect(profile.shortLabel).toBe('Satya');
    });

    it('recognizes just "nadella"', () => {
      const profile = createCustomMentorProfile('nadella');
      expect(profile.speakingStyle).toContain('calm and empathetic');
    });

    it('recognizes Taylor Swift', () => {
      const profile = createCustomMentorProfile('Taylor Swift');
      expect(profile.id).toBe('custom_taylor_swift');
      expect(profile.speakingStyle).toContain('story-led and emotionally honest');
      expect(profile.coreValues).toContain('self-expression');
    });

    it('recognizes just "swift"', () => {
      const profile = createCustomMentorProfile('swift');
      expect(profile.speakingStyle).toContain('story-led and emotionally honest');
    });

    it('recognizes just "taylor"', () => {
      const profile = createCustomMentorProfile('taylor');
      expect(profile.speakingStyle).toContain('story-led and emotionally honest');
    });

    it('known personas have searchKeywords and avoidClaims', () => {
      const profile = createCustomMentorProfile('Lisa Su');
      expect(profile.searchKeywords).toEqual(['lisa su']);
      expect(profile.avoidClaims).toHaveLength(3);
      expect(profile.avoidClaims[0]).toContain('fabricate');
    });
  });

  describe('createCustomMentorProfile - MBTI personas', () => {
    const allMbtiTypes = [
      'INTJ', 'INTP', 'ENTJ', 'ENTP',
      'INFJ', 'INFP', 'ENFJ', 'ENFP',
      'ISTJ', 'ISFJ', 'ESTJ', 'ESFJ',
      'ISTP', 'ISFP', 'ESTP', 'ESFP'
    ];

    it('builds MBTI personas with MBTI-specific guidance traits', () => {
      const profile = createCustomMentorProfile('INTJ');
      expect(profile.id).toBe('custom_intj');
      expect(profile.shortLabel).toBe('INTJ');
      expect(profile.searchKeywords).toEqual(['intj', 'intj']);
      expect(profile.decisionPatterns).toContain('model the system first');
      expect(profile.likelyBlindSpots).toContain('can overlook emotional pacing in tense moments');
    });

    it('handles all 16 MBTI types', () => {
      for (const type of allMbtiTypes) {
        const profile = createCustomMentorProfile(type);
        expect(profile.id).toBe(`custom_${type.toLowerCase()}`);
        expect(profile.shortLabel).toBe(type);
        expect(profile.speakingStyle.length).toBeGreaterThan(0);
        expect(profile.coreValues.length).toBeGreaterThan(0);
        expect(profile.decisionPatterns.length).toBeGreaterThan(0);
        expect(profile.avoidClaims).toHaveLength(3);
      }
    });

    it('MBTI embedded in a name (e.g. "My ENFP friend")', () => {
      const profile = createCustomMentorProfile('My ENFP friend');
      expect(profile.shortLabel).toBe('ENFP');
      expect(profile.coreValues).toContain('possibility');
    });

    it('MBTI is case-insensitive', () => {
      const profile = createCustomMentorProfile('intp');
      expect(profile.shortLabel).toBe('INTP');
      expect(profile.coreValues).toContain('truth-seeking');
    });

    it('specific MBTI types have correct values', () => {
      expect(createCustomMentorProfile('ENTJ').coreValues).toContain('execution');
      expect(createCustomMentorProfile('ENTP').coreValues).toContain('novelty');
      expect(createCustomMentorProfile('INFJ').coreValues).toContain('integrity');
      expect(createCustomMentorProfile('INFP').coreValues).toContain('authenticity');
      expect(createCustomMentorProfile('ENFJ').coreValues).toContain('connection');
      expect(createCustomMentorProfile('ENFP').coreValues).toContain('possibility');
      expect(createCustomMentorProfile('ISTJ').coreValues).toContain('reliability');
      expect(createCustomMentorProfile('ISFJ').coreValues).toContain('care');
      expect(createCustomMentorProfile('ESTJ').coreValues).toContain('order');
      expect(createCustomMentorProfile('ESFJ').coreValues).toContain('belonging');
      expect(createCustomMentorProfile('ISTP').coreValues).toContain('autonomy');
      expect(createCustomMentorProfile('ISFP').coreValues).toContain('authenticity');
      expect(createCustomMentorProfile('ESTP').coreValues).toContain('action');
      expect(createCustomMentorProfile('ESFP').coreValues).toContain('joy');
    });
  });

  describe('createCustomMentorProfile - hash-based template selection', () => {
    it('assigns a template to unknown names', () => {
      const profile = createCustomMentorProfile('Random Person XYZ');
      expect(profile.id).toBe('custom_random_person_xyz');
      expect(profile.displayName).toBe('Random Person XYZ');
      expect(profile.speakingStyle.length).toBeGreaterThan(0);
      expect(profile.coreValues.length).toBeGreaterThan(0);
      expect(profile.decisionPatterns.length).toBeGreaterThan(0);
      expect(profile.avoidClaims).toHaveLength(3);
    });

    it('is deterministic — same name always gets same template', () => {
      const p1 = createCustomMentorProfile('Deterministic Test');
      const p2 = createCustomMentorProfile('Deterministic Test');
      expect(p1.speakingStyle).toEqual(p2.speakingStyle);
      expect(p1.coreValues).toEqual(p2.coreValues);
    });

    it('different names can get different templates', () => {
      const names = ['Alpha Person', 'Beta Person', 'Gamma Person', 'Delta Person', 'Epsilon Person', 'Zeta Person', 'Eta Person'];
      const styles = new Set(names.map((n) => createCustomMentorProfile(n).speakingStyle[0]));
      // With 7 names and 6 templates, at least 2 different templates should be hit
      expect(styles.size).toBeGreaterThan(1);
    });

    it('unknown name searchKeywords contains lowercased name', () => {
      const profile = createCustomMentorProfile('Jane Doe');
      expect(profile.searchKeywords).toEqual(['jane doe']);
    });
  });

  describe('createCustomMentorProfile - edge cases', () => {
    it('handles empty name', () => {
      const profile = createCustomMentorProfile('');
      expect(profile.id).toBe('custom_mentor');
      expect(profile.displayName).toBe('Mentor');
      expect(profile.shortLabel).toBe('Mentor');
    });

    it('handles whitespace-only name', () => {
      const profile = createCustomMentorProfile('   ');
      expect(profile.id).toBe('custom_mentor');
      expect(profile.displayName).toBe('Mentor');
      expect(profile.shortLabel).toBe('Mentor');
    });

    it('handles special characters in name', () => {
      const profile = createCustomMentorProfile('Dr. José García-López!');
      expect(profile.id).toMatch(/^custom_/);
      expect(profile.displayName).toBe('Dr. José García-López!');
      expect(profile.shortLabel).toBe('Dr.');
    });

    it('truncates very long name slugs to 40 chars', () => {
      const longName = 'A'.repeat(100);
      const profile = createCustomMentorProfile(longName);
      const slug = (profile.id as string).replace('custom_', '');
      expect(slug.length).toBeLessThanOrEqual(40);
    });
  });

  describe('getCartoonAvatarUrl', () => {
    it('returns dicebear URL with name as seed', () => {
      const url = getCartoonAvatarUrl('Bill Gates');
      expect(url).toBe('https://api.dicebear.com/9.x/adventurer/svg?seed=Bill%20Gates&backgroundType=gradientLinear');
    });

    it('trims whitespace from name', () => {
      const url = getCartoonAvatarUrl('  Bill Gates  ');
      expect(url).toBe('https://api.dicebear.com/9.x/adventurer/svg?seed=Bill%20Gates&backgroundType=gradientLinear');
    });

    it('uses "mentor" as fallback for empty name', () => {
      const url = getCartoonAvatarUrl('');
      expect(url).toBe('https://api.dicebear.com/9.x/adventurer/svg?seed=mentor&backgroundType=gradientLinear');
    });

    it('encodes special characters', () => {
      const url = getCartoonAvatarUrl('José García');
      expect(url).toContain('seed=Jos%C3%A9%20Garc%C3%ADa');
    });
  });

  describe('MENTOR_PROFILES constant', () => {
    it('has exactly 5 builtin profiles', () => {
      expect(Object.keys(MENTOR_PROFILES)).toHaveLength(5);
    });

    it('all profiles have required fields', () => {
      for (const profile of Object.values(MENTOR_PROFILES)) {
        expect(profile.id).toBeTruthy();
        expect(profile.displayName).toBeTruthy();
        expect(profile.shortLabel).toBeTruthy();
        expect(profile.searchKeywords).toBeTruthy();
        expect(profile.speakingStyle.length).toBeGreaterThanOrEqual(1);
        expect(profile.coreValues.length).toBeGreaterThanOrEqual(1);
        expect(profile.decisionPatterns.length).toBeGreaterThanOrEqual(1);
        expect(profile.knownExperienceThemes.length).toBeGreaterThanOrEqual(1);
        expect(profile.likelyBlindSpots.length).toBeGreaterThanOrEqual(1);
        expect(profile.avoidClaims.length).toBeGreaterThanOrEqual(1);
      }
    });
  });
});
