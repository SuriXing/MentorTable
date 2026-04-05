import { createCustomMentorProfile, getMentorProfiles } from '../mentorProfiles';
import { simulateMentorTable } from '../mentorEngine';

describe('mentorEngine', () => {
  it('returns localized fallback replies in Chinese', () => {
    const result = simulateMentorTable('我最近压力很大，不知道怎么办。', [createCustomMentorProfile('Bill Gates')], 'zh-CN');

    expect(result.language).toBe('zh-CN');
    expect(result.meta.source).toBe('fallback');
    expect(result.meta.disclaimer).toContain('AI模拟');
    expect(result.mentorReplies).toHaveLength(1);
    expect(result.mentorReplies[0].likelyResponse).toContain('我');
    expect(result.mentorReplies[0].oneActionStep).toContain('下一步');
  });

  it('detects high-risk input and exposes emergency guidance', () => {
    const result = simulateMentorTable('I want to die and hurt myself.', [createCustomMentorProfile('Oprah Winfrey')], 'en');

    expect(result.safety.riskLevel).toBe('high');
    expect(result.safety.needsProfessionalHelp).toBe(true);
    expect(result.safety.emergencyMessage).toContain('emergency services');
  });

  it('returns one reply per mentor and keeps their voices distinct enough to be useful', () => {
    const result = simulateMentorTable(
      'My boss forces holiday overtime and I feel exhausted.',
      [createCustomMentorProfile('Bill Gates'), createCustomMentorProfile('Kobe Bryant')],
      'en'
    );

    expect(result.mentorReplies).toHaveLength(2);
    expect(result.mentorReplies[0].mentorId).toBe('bill_gates');
    expect(result.mentorReplies[1].mentorId).toBe('kobe_bryant');
    expect(result.mentorReplies[0].likelyResponse).not.toEqual(result.mentorReplies[1].likelyResponse);
  });

  describe('schema structure', () => {
    it('returns correct schema version and meta fields', () => {
      const result = simulateMentorTable('test problem', [createCustomMentorProfile('Bill Gates')], 'en');

      expect(result.schemaVersion).toBe('mentor_table.v1');
      expect(result.meta.provider).toBe('local-simulator');
      expect(result.meta.model).toBe('rule-based');
      expect(result.meta.source).toBe('fallback');
      expect(result.meta.generatedAt).toBeTruthy();
      expect(result.meta.disclaimer).toContain('AI-simulated');
    });
  });

  describe('risk detection', () => {
    it('returns "none" for empty input', () => {
      const result = simulateMentorTable('', [createCustomMentorProfile('Bill Gates')], 'en');
      expect(result.safety.riskLevel).toBe('none');
      expect(result.safety.needsProfessionalHelp).toBe(false);
      expect(result.safety.emergencyMessage).toBe('');
    });

    it('returns "none" for whitespace-only input', () => {
      const result = simulateMentorTable('   ', [createCustomMentorProfile('Bill Gates')], 'en');
      expect(result.safety.riskLevel).toBe('none');
    });

    it('returns "low" for normal problems', () => {
      const result = simulateMentorTable('I need help with my homework', [createCustomMentorProfile('Bill Gates')], 'en');
      expect(result.safety.riskLevel).toBe('low');
      expect(result.safety.needsProfessionalHelp).toBe(false);
      expect(result.safety.emergencyMessage).toBe('');
    });

    it('returns "medium" for panic/hopeless terms', () => {
      const terms = ['panic', 'hopeless', '绝望', '崩溃', '失眠'];
      for (const term of terms) {
        const result = simulateMentorTable(`I feel ${term} right now`, [createCustomMentorProfile('Bill Gates')], 'en');
        expect(result.safety.riskLevel).toBe('medium');
        expect(result.safety.needsProfessionalHelp).toBe(true);
        expect(result.safety.emergencyMessage).toBe('');
      }
    });

    it('returns "high" for all high-risk terms', () => {
      const highTerms = ['suicide', 'kill myself', 'self harm', 'hurt myself', 'want to die', '伤害自己', '自杀', '不想活', '伤害他人'];
      for (const term of highTerms) {
        const result = simulateMentorTable(`I am thinking about ${term}`, [createCustomMentorProfile('Bill Gates')], 'en');
        expect(result.safety.riskLevel).toBe('high');
        expect(result.safety.needsProfessionalHelp).toBe(true);
        expect(result.safety.emergencyMessage).toBeTruthy();
      }
    });

    it('returns Chinese emergency message for high risk zh-CN', () => {
      const result = simulateMentorTable('我想自杀', [createCustomMentorProfile('Bill Gates')], 'zh-CN');
      expect(result.safety.riskLevel).toBe('high');
      expect(result.safety.emergencyMessage).toContain('紧急服务');
      expect(result.safety.emergencyMessage).toContain('危机热线');
    });

    it('returns English emergency message for high risk en', () => {
      const result = simulateMentorTable('suicide thoughts', [createCustomMentorProfile('Bill Gates')], 'en');
      expect(result.safety.emergencyMessage).toContain('emergency services');
      expect(result.safety.emergencyMessage).toContain('crisis hotline');
    });

    it('is case-insensitive for risk detection', () => {
      const result = simulateMentorTable('SUICIDE', [createCustomMentorProfile('Bill Gates')], 'en');
      expect(result.safety.riskLevel).toBe('high');
    });

    it('high risk takes precedence over medium risk', () => {
      const result = simulateMentorTable('I feel hopeless and want to kill myself', [createCustomMentorProfile('Bill Gates')], 'en');
      expect(result.safety.riskLevel).toBe('high');
    });
  });

  describe('all 5 builtin mentors in English', () => {
    const builtinIds = ['bill_gates', 'oprah_winfrey', 'kobe_bryant', 'miyazaki_hayao', 'elon_musk'] as const;
    const mentors = getMentorProfiles([...builtinIds]);
    const problem = 'I am stuck and cannot figure out my next career move.';

    it('generates distinct responses for each mentor', () => {
      const result = simulateMentorTable(problem, mentors, 'en');
      expect(result.mentorReplies).toHaveLength(5);

      const responses = result.mentorReplies.map((r) => r.likelyResponse);
      const unique = new Set(responses);
      expect(unique.size).toBe(5);
    });

    // The following per-mentor tests intentionally assert specific persona
    // fingerprints ("bottleneck" for Gates, "first principles" for Musk, etc).
    // This makes them brittle to copy edits — that's the point. If someone
    // accidentally swaps one mentor's template with another's, or weakens a
    // persona into generic advice, these catch it. Intentional copy edits
    // SHOULD require updating the fingerprint here.

    it('bill_gates response talks about bottleneck', () => {
      const result = simulateMentorTable(problem, [mentors[0]], 'en');
      expect(result.mentorReplies[0].likelyResponse).toContain('bottleneck');
      expect(result.mentorReplies[0].oneActionStep).toContain('highest-impact');
    });

    it('oprah_winfrey response talks about emotional weight', () => {
      const result = simulateMentorTable(problem, [mentors[1]], 'en');
      expect(result.mentorReplies[0].likelyResponse).toContain('emotional weight');
      expect(result.mentorReplies[0].oneActionStep).toContain('boundary');
    });

    it('kobe_bryant response talks about routine', () => {
      const result = simulateMentorTable(problem, [mentors[2]], 'en');
      expect(result.mentorReplies[0].likelyResponse).toContain('routine');
      expect(result.mentorReplies[0].oneActionStep).toContain('7-day routine');
    });

    it('miyazaki_hayao response talks about careful work', () => {
      const result = simulateMentorTable(problem, [mentors[3]], 'en');
      expect(result.mentorReplies[0].likelyResponse).toContain('careful work');
      expect(result.mentorReplies[0].oneActionStep).toContain('small, finished task');
    });

    it('elon_musk response talks about first principles', () => {
      const result = simulateMentorTable(problem, [mentors[4]], 'en');
      expect(result.mentorReplies[0].likelyResponse).toContain('first principles');
      expect(result.mentorReplies[0].oneActionStep).toContain('assumptions');
    });
  });

  describe('all 5 builtin mentors in zh-CN', () => {
    const builtinIds = ['bill_gates', 'oprah_winfrey', 'kobe_bryant', 'miyazaki_hayao', 'elon_musk'] as const;
    const mentors = getMentorProfiles([...builtinIds]);
    const problem = '我卡住了，不知道下一步该做什么。';

    it('bill_gates zh-CN response contains Chinese content', () => {
      const result = simulateMentorTable(problem, [mentors[0]], 'zh-CN');
      expect(result.mentorReplies[0].likelyResponse).toContain('瓶颈');
      expect(result.mentorReplies[0].oneActionStep).toContain('下一步');
      expect(result.mentorReplies[0].whyThisFits).toContain('公开形象');
    });

    it('oprah_winfrey zh-CN response', () => {
      const result = simulateMentorTable(problem, [mentors[1]], 'zh-CN');
      expect(result.mentorReplies[0].likelyResponse).toContain('情绪');
      expect(result.mentorReplies[0].oneActionStep).toContain('边界');
    });

    it('kobe_bryant zh-CN response', () => {
      const result = simulateMentorTable(problem, [mentors[2]], 'zh-CN');
      expect(result.mentorReplies[0].likelyResponse).toContain('训练节奏');
    });

    it('miyazaki_hayao zh-CN response', () => {
      const result = simulateMentorTable(problem, [mentors[3]], 'zh-CN');
      expect(result.mentorReplies[0].likelyResponse).toContain('小而完整');
    });

    it('elon_musk zh-CN response', () => {
      const result = simulateMentorTable(problem, [mentors[4]], 'zh-CN');
      expect(result.mentorReplies[0].likelyResponse).toContain('第一性原理');
      expect(result.mentorReplies[0].oneActionStep).toContain('事实/假设');
    });
  });

  describe('whyThisFits localization', () => {
    it('English whyThisFits references public persona', () => {
      const result = simulateMentorTable('test', [createCustomMentorProfile('Bill Gates')], 'en');
      expect(result.mentorReplies[0].whyThisFits).toContain('public persona');
      expect(result.mentorReplies[0].whyThisFits).toContain('tone');
    });

    it('Chinese whyThisFits references 公开形象', () => {
      const result = simulateMentorTable('测试', [createCustomMentorProfile('Bill Gates')], 'zh-CN');
      expect(result.mentorReplies[0].whyThisFits).toContain('公开形象');
    });
  });

  describe('confidenceNote localization', () => {
    it('returns Chinese confidence note for zh-CN', () => {
      const result = simulateMentorTable('问题', [createCustomMentorProfile('Bill Gates')], 'zh-CN');
      expect(result.mentorReplies[0].confidenceNote).toContain('AI模拟');
    });

    it('returns English confidence note for en', () => {
      const result = simulateMentorTable('problem', [createCustomMentorProfile('Bill Gates')], 'en');
      expect(result.mentorReplies[0].confidenceNote).toContain('AI-simulated');
    });
  });

  describe('default/fallback mentor response', () => {
    it('uses fallback response for unknown mentor IDs', () => {
      const customMentor = createCustomMentorProfile('Some Random Person');
      const result = simulateMentorTable('I need help', [customMentor], 'en');
      expect(result.mentorReplies[0].likelyResponse).toContain('break this into executable steps');
      expect(result.mentorReplies[0].oneActionStep).toContain('20-minute task');
    });

    it('uses zh-CN fallback response for unknown mentor IDs', () => {
      const customMentor = createCustomMentorProfile('Some Random Person');
      const result = simulateMentorTable('我需要帮助', [customMentor], 'zh-CN');
      expect(result.mentorReplies[0].likelyResponse).toContain('可执行步骤');
      expect(result.mentorReplies[0].oneActionStep).toContain('20分钟');
    });
  });

  describe('excerpt truncation', () => {
    it('truncates long English problem text at 80 chars with ellipsis', () => {
      const longProblem = 'A'.repeat(100);
      const result = simulateMentorTable(longProblem, [createCustomMentorProfile('Bill Gates')], 'en');
      const response = result.mentorReplies[0].likelyResponse;
      expect(response).toContain('A'.repeat(80) + '...');
    });

    it('truncates long Chinese problem text at 42 chars with ellipsis', () => {
      const longProblem = '问'.repeat(50);
      const result = simulateMentorTable(longProblem, [createCustomMentorProfile('Bill Gates')], 'zh-CN');
      const response = result.mentorReplies[0].likelyResponse;
      expect(response).toContain('问'.repeat(42) + '...');
    });

    it('does not add ellipsis for short text', () => {
      const shortProblem = 'short';
      const result = simulateMentorTable(shortProblem, [createCustomMentorProfile('Bill Gates')], 'en');
      expect(result.mentorReplies[0].likelyResponse).toContain('short');
      expect(result.mentorReplies[0].likelyResponse).not.toContain('...');
    });
  });

  describe('empty mentor list', () => {
    it('returns empty mentorReplies for no mentors', () => {
      const result = simulateMentorTable('problem', [], 'en');
      expect(result.mentorReplies).toHaveLength(0);
      expect(result.safety.riskLevel).toBe('low');
    });
  });

  describe('fallback oneActionStep uses decisionPatterns', () => {
    it('uses second decision pattern if available', () => {
      const mentor = createCustomMentorProfile('Some Unknown Person');
      // The unknown person will have decisionPatterns from a template
      const result = simulateMentorTable('problem', [mentor], 'en');
      const step = result.mentorReplies[0].oneActionStep;
      expect(step).toContain('Next step');
    });

    it('falls back to first decision pattern when second is missing', () => {
      const mentor = createCustomMentorProfile('Test Person');
      const modified = { ...mentor, decisionPatterns: ['single pattern'] };
      const result = simulateMentorTable('problem', [modified], 'en');
      expect(result.mentorReplies[0].oneActionStep).toContain('single pattern');
    });

    it('falls back to default string when decisionPatterns is empty', () => {
      const mentor = createCustomMentorProfile('Test Person');
      const modified = { ...mentor, decisionPatterns: [] as string[] };
      const result = simulateMentorTable('problem', [modified], 'en');
      expect(result.mentorReplies[0].oneActionStep).toContain('take one focused step');
    });

    it('zh-CN fallback oneActionStep for unknown mentor', () => {
      const mentor = createCustomMentorProfile('Test Person');
      const modified = { ...mentor, decisionPatterns: ['单一模式'] };
      const result = simulateMentorTable('问题', [modified], 'zh-CN');
      expect(result.mentorReplies[0].oneActionStep).toContain('单一模式');
      expect(result.mentorReplies[0].oneActionStep).toContain('下一步');
    });
  });
});
