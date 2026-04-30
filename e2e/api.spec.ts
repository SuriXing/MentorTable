import { test, expect } from '@playwright/test';

const API_BASE = 'http://localhost:8787';

test.describe('Mentor Table API', () => {
  test('GET /api/health returns ok', async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/health`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, service: 'mentor-api' });
  });

  test('POST /api/mentor-table with valid data returns simulation result', async ({ request }) => {
    // Skip when no LLM API key configured (CI without LLM_API_KEY secret,
    // local dev without env file). Validation tests below still run and
    // verify the 4xx paths.
    test.skip(!process.env.LLM_API_KEY, 'LLM_API_KEY not configured — skipping live LLM test');
    const res = await request.post(`${API_BASE}/api/mentor-table`, {
      data: {
        problem: 'I feel stuck in my career and need direction',
        language: 'en',
        mentors: [
          {
            id: 'bill_gates',
            displayName: 'Bill Gates',
            speakingStyle: ['analytical', 'measured'],
            coreValues: ['innovation', 'impact'],
            decisionPatterns: ['data-driven prioritization'],
            knownExperienceThemes: ['technology', 'philanthropy'],
            likelyBlindSpots: ['emotional nuance'],
            avoidClaims: [],
          },
        ],
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.schemaVersion).toBe('mentor_table.v1');
    expect(body.language).toBe('en');
    expect(body.safety).toBeDefined();
    expect(body.safety.riskLevel).toBeDefined();
    expect(body.mentorReplies).toBeInstanceOf(Array);
    expect(body.mentorReplies.length).toBeGreaterThanOrEqual(1);
    const reply = body.mentorReplies[0];
    expect(reply.mentorId).toBeTruthy();
    expect(reply.mentorName).toBeTruthy();
    expect(reply.likelyResponse).toBeTruthy();
    expect(reply.oneActionStep).toBeTruthy();
    expect(body.meta).toBeDefined();
    expect(body.meta.disclaimer).toBeTruthy();
    expect(body.meta.generatedAt).toBeTruthy();
  });

  test('POST /api/mentor-table with missing problem returns 400', async ({ request }) => {
    const res = await request.post(`${API_BASE}/api/mentor-table`, {
      data: {
        language: 'en',
        mentors: [{ id: 'bill_gates', displayName: 'Bill Gates' }],
      },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('problem');
  });

  test('POST /api/mentor-table with missing mentors returns 400', async ({ request }) => {
    const res = await request.post(`${API_BASE}/api/mentor-table`, {
      data: {
        problem: 'test problem',
        language: 'en',
      },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('mentor');
  });

  test('GET /api/mentor-table returns 405 (wrong method)', async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/mentor-table`);
    expect(res.status()).toBe(405);
    const body = await res.json();
    expect(body.error).toContain('Method not allowed');
  });

  test('POST /api/mentor-debug-prompt returns prompt text', async ({ request }) => {
    const res = await request.post(`${API_BASE}/api/mentor-debug-prompt`, {
      data: {
        mentor: {
          id: 'bill_gates',
          displayName: 'Bill Gates',
          speakingStyle: ['analytical'],
          coreValues: ['innovation'],
          decisionPatterns: ['data-driven'],
          knownExperienceThemes: ['tech'],
          likelyBlindSpots: ['emotion'],
          avoidClaims: [],
        },
        language: 'en',
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.prompt).toBeTruthy();
    expect(body.prompt).toContain('Bill Gates');
  });

  test('POST /api/mentor-debug-prompt with missing mentor returns 400', async ({ request }) => {
    const res = await request.post(`${API_BASE}/api/mentor-debug-prompt`, {
      data: { language: 'en' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('mentor');
  });

  test('GET /api/mentor-debug-prompt returns 405 (wrong method)', async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/mentor-debug-prompt`);
    expect(res.status()).toBe(405);
  });

  test('GET /api/mentor-image returns image or 404', async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/mentor-image?name=Bill+Gates`);
    // Must NOT be 500 (no server crash). Valid outcomes: cached image served
    // (200), redirect (302), or Wikipedia miss (404). No other codes allowed.
    expect([200, 302, 404]).toContain(res.status());

    if (res.status() === 200) {
      // If serving an image, verify it's actually an image with a plausible body
      const contentType = res.headers()['content-type'] || '';
      expect(contentType).toMatch(/^image\/(jpeg|png|webp)/);
      const body = await res.body();
      expect(body.length).toBeGreaterThan(100);
      // Cache header is set by the handler
      expect(res.headers()['cache-control'] || '').toContain('max-age');
    } else if (res.status() === 404) {
      // 404 must return a structured error body, not empty
      const body = await res.json();
      expect(body.error).toBeTruthy();
    }
  });

  test('GET /api/mentor-image without name returns 400', async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/mentor-image`);
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('name');
  });
});
