'use strict';

const {
  NEAR_DUPLICATE_THRESHOLD,
  hasMeasurableAction,
  assessMentorReplyQuality,
} = require('../lib/mentor-quality.js');

describe('mentor reply quality', () => {
  it('flags identical English replies without returning their text', () => {
    const sentinel = 'PRIVATE_SENTINEL_TEXT';
    const replies = [
      {
        mentorId: 'mentor_a',
        likelyResponse: `Prioritize customer interviews over more features. ${sentinel}`,
        oneActionStep: 'Interview three customers within two days.',
      },
      {
        mentorId: 'mentor_b',
        likelyResponse: `Prioritize customer interviews over more features. ${sentinel}`,
        oneActionStep: 'Interview three customers within two days.',
      },
    ];

    const quality = assessMentorReplyQuality(replies, 'en');

    expect(quality.maxSimilarity).toBe(1);
    expect(quality.nearDuplicatePairs).toEqual([
      { mentorIds: ['mentor_a', 'mentor_b'], similarity: 1 },
    ]);
    expect(JSON.stringify(quality)).not.toContain(sentinel);
  });

  it('keeps distinct English perspectives below the duplicate threshold', () => {
    const quality = assessMentorReplyQuality([
      {
        mentorId: 'builder',
        likelyResponse: 'Ship a narrow prototype and prioritize learning speed over polish.',
        oneActionStep: 'Build one checkout path within two days.',
      },
      {
        mentorId: 'researcher',
        likelyResponse: 'Delay implementation and prioritize evidence over momentum.',
        oneActionStep: 'Interview five users before Friday.',
      },
    ], 'en');

    expect(quality.maxSimilarity).toBeLessThan(NEAR_DUPLICATE_THRESHOLD);
    expect(quality.nearDuplicatePairs).toEqual([]);
    expect(quality.weakActionMentorIds).toEqual([]);
  });

  it('detects near-duplicate Chinese replies with character bigrams', () => {
    const quality = assessMentorReplyQuality([
      {
        mentorId: 'mentor_a',
        likelyResponse: '先访谈用户，不要继续增加功能。',
        oneActionStep: '今天访谈三位用户。',
      },
      {
        mentorId: 'mentor_b',
        likelyResponse: '先访谈用户，不要继续增加功能。',
        oneActionStep: '今天访谈三位用户。',
      },
    ], 'zh-CN');

    expect(quality.maxSimilarity).toBe(1);
    expect(quality.nearDuplicatePairs[0].mentorIds).toEqual(['mentor_a', 'mentor_b']);
  });

  it('reports actions without a number, timebox, or deadline', () => {
    expect(hasMeasurableAction('Think carefully about the problem.', 'en')).toBe(false);
    expect(hasMeasurableAction('Interview three users before Friday.', 'en')).toBe(true);
    expect(hasMeasurableAction('认真想一想这个问题。', 'zh-CN')).toBe(false);
    expect(hasMeasurableAction('今天访谈三位用户。', 'zh-CN')).toBe(true);

    const quality = assessMentorReplyQuality([
      { mentorId: 'weak', likelyResponse: 'Reflect first.', oneActionStep: 'Think carefully.' },
      { mentorId: 'strong', likelyResponse: 'Test it.', oneActionStep: 'Run two tests today.' },
    ], 'en');
    expect(quality.weakActionMentorIds).toEqual(['weak']);
  });

  it('handles missing or empty reply collections', () => {
    expect(assessMentorReplyQuality(undefined, 'en')).toEqual({
      mentorCount: 0,
      maxSimilarity: 0,
      maxSimilarityMentorIds: [],
      nearDuplicatePairs: [],
      weakActionMentorIds: [],
    });
  });
});
