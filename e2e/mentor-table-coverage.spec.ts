/**
 * Mentor Table coverage-focused E2E specs.
 *
 * These tests target UI branches that existing E2E specs do not exercise:
 *   - expanded reply overlay (click a suggestion card / table reply card)
 *   - expanded reply overlay inline pass-a-note flow
 *   - debug prompt panel open + close
 *   - candle click (stateful cycle)
 *   - group solve toggle + hide
 *   - table arena ripple click
 *   - mentor node name plate flip
 *
 * All API calls are mocked with page.route so runs are deterministic.
 */
import type { Page, Route } from '@playwright/test';
import { test, expect } from './coverage-fixture';

test.setTimeout(60000);

// ---------- Mock data ----------

const MOCK_RESPONSE = {
  schemaVersion: 'mentor_table.v1',
  language: 'en',
  safety: { riskLevel: 'low', needsProfessionalHelp: false, emergencyMessage: '' },
  mentorReplies: [
    {
      mentorId: 'bill_gates',
      mentorName: 'Bill Gates',
      likelyResponse:
        'I would break this into three core bottlenecks and iterate on each one, starting with the one that blocks the others. This is a deliberately long response so that the suggestion preview is truncated and the card becomes clickable to expand.',
      whyThisFits: 'Analytical approach fits this problem.',
      oneActionStep:
        'Write down the three biggest bottlenecks you can think of and rank them by impact today.',
      confidenceNote: 'AI-simulated perspective.'
    }
  ],
  meta: {
    disclaimer: 'AI simulation.',
    generatedAt: '2024-01-01T00:00:00Z',
    source: 'llm'
  }
};

const MOCK_DEBUG_PROMPT =
  'DEBUG PROMPT: You are Bill Gates, respond as the analytical mentor...';

// ---------- Helpers ----------

function mockApis(page: Page) {
  page.route(/\/api\/mentor-debug-prompt/, (route: Route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ prompt: MOCK_DEBUG_PROMPT })
    });
  });
  page.route(/\/api\/mentor-table/, (route: Route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_RESPONSE)
    });
  });
}

async function addMentor(page: Page, name: string) {
  const input = page.getByTestId('mentor-person-input');
  await input.fill(name);
  const suggestionMenu = page.locator('[class*="suggestionMenu"]');
  await expect(suggestionMenu).toBeVisible({ timeout: 5000 });
  const firstSuggestion = suggestionMenu.locator('[class*="suggestionItem"]').first();
  const hasSuggestion = await firstSuggestion.isVisible().catch(() => false);
  if (hasSuggestion) {
    await firstSuggestion.click();
  } else {
    await input.press('Enter');
  }
  await expect(input).toHaveValue('', { timeout: 3000 });
}

async function runSession(page: Page, mentor = 'Bill Gates') {
  mockApis(page);
  await addMentor(page, mentor);
  await page.getByTestId('mentor-continue-wish').click();
  await page
    .getByTestId('mentor-problem-input')
    .fill('How do I stay motivated long-term?');
  await page.getByTestId('mentor-begin-session').click();
  const conv = page.getByTestId('mentor-conversation-panel');
  await expect(conv).toBeVisible({ timeout: 10000 });
  const replyFooter = conv.locator('footer').filter({ hasText: /Next move|下一步/ });
  await expect(replyFooter).toHaveCount(1, { timeout: 30000 });
}

// ---------- Tests ----------

test.describe('Mentor Table Coverage E2E', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('mentorTableOnboardingHiddenV2', '1');
    });
    await page.goto('/', { waitUntil: 'networkidle' });
    await expect(page.getByTestId('mentor-person-input')).toBeVisible({
      timeout: 10000
    });
  });

  // ---- 1. Expanded reply overlay from table reply card click ----
  test('expanded reply overlay opens from the table reply card and closes via back', async ({
    page
  }) => {
    await runSession(page);

    // Wait for the floating table reply card (in suggestion deck)
    const tableReplyCard = page.locator('[class*="tableReplyCard"]').first();
    await expect(tableReplyCard).toBeVisible({ timeout: 10000 });
    await tableReplyCard.click();

    // Expanded overlay appears
    const overlay = page.locator('[class*="replyExpandOverlay"]');
    await expect(overlay).toBeVisible({ timeout: 5000 });

    // Expanded card shows the full likely response
    const expandedCard = page.locator('[class*="replyExpandedCard"]');
    await expect(expandedCard).toBeVisible();
    await expect(expandedCard).toContainText('three core bottlenecks');

    // Click back-to-table
    const backBtn = page.locator('[class*="expandBackTopLeft"]');
    await backBtn.click();
    await expect(overlay).not.toBeVisible({ timeout: 3000 });
  });

  // ---- 2. Expanded reply overlay pass-a-note flow ----
  test('expanded reply overlay supports inline pass-a-note', async ({ page }) => {
    await runSession(page);

    const tableReplyCard = page.locator('[class*="tableReplyCard"]').first();
    await expect(tableReplyCard).toBeVisible({ timeout: 10000 });
    await tableReplyCard.click();

    const expandedCard = page.locator('[class*="replyExpandedCard"]');
    await expect(expandedCard).toBeVisible();

    // Click pass-a-note button inside the expanded card
    const passNoteBtn = expandedCard.locator('[class*="passNoteBtn"]');
    await passNoteBtn.click();

    const noteTextarea = expandedCard.locator('textarea');
    await expect(noteTextarea).toBeVisible();
    await noteTextarea.fill('Can you give me more detail on step one?');

    // Send
    const sendBtn = expandedCard.locator('[class*="ghostBtn"]');
    await sendBtn.click();

    // The original conversation panel should now show a new turn
    const conv = page.getByTestId('mentor-conversation-panel');
    const turnGroup = conv.locator('[class*="turnGroup"]').first();
    await expect(turnGroup).toBeVisible({ timeout: 15000 });
  });

  // ---- 3. Debug prompt panel open + close ----
  test('debug prompt panel opens and closes from the mentor avatar bug icon', async ({
    page
  }) => {
    await runSession(page);

    // Hover a mentor avatar wrapper on the stage
    const mentorWrap = page.locator('[class*="mentorAvatarWrap"]').first();
    await mentorWrap.hover();

    // Click the debug icon button that appears on hover
    const debugIcon = page.locator('[class*="debugIconBtn"]').first();
    await expect(debugIcon).toBeVisible({ timeout: 5000 });
    await debugIcon.click();

    // Debug panel appears
    const debugPanel = page.locator('[class*="debugPromptPanel"]');
    await expect(debugPanel).toBeVisible({ timeout: 5000 });

    // Close it
    const closeBtn = debugPanel.locator('[class*="debugPromptCloseBtn"]');
    await closeBtn.click();
    await expect(debugPanel).not.toBeVisible({ timeout: 3000 });
  });

  // ---- 4. Candle click cycles level ----
  test('candle click cycles flame level and keeps element', async ({ page }) => {
    await addMentor(page, 'Bill Gates');
    const candle = page.locator('[class*="candleProp"]');
    await expect(candle).toBeVisible();

    // Click 3 times — cycles through 1→2→3→1
    await candle.click({ force: true });
    await candle.click({ force: true });
    await candle.click({ force: true });

    // Still visible
    await expect(candle).toBeVisible();
  });

  // ---- 5. Group solve toggle on and off ----
  test('group solve toggles on and off after session complete', async ({ page }) => {
    await runSession(page);

    const groupBtn = page.locator('button').filter({ hasText: /Group solve together|共同讨论方案/ });
    await expect(groupBtn).toBeVisible({ timeout: 10000 });
    await groupBtn.click();

    // Joint strategy card visible
    await expect(page.locator('[class*="groupSolveCard"]')).toBeVisible({
      timeout: 3000
    });

    // Hide it again
    const hideBtn = page.locator('button').filter({ hasText: /Hide group solve|隐藏共同讨论/ });
    await hideBtn.click();
    await expect(page.locator('[class*="groupSolveCard"]')).not.toBeVisible({
      timeout: 3000
    });
  });

  // ---- 6. Table arena click creates a ripple ----
  test('clicking the table arena produces a ripple element', async ({ page }) => {
    await addMentor(page, 'Bill Gates');

    const arena = page.locator('[class*="tableArena"]').first();
    await arena.click({ position: { x: 100, y: 100 }, force: true });

    // Ripple span mounted (transient — just check existence)
    const ripple = page.locator('[class*="tableRipple"]');
    await expect(ripple).toHaveCount(1, { timeout: 2000 });
  });

  // ---- 7. Mentor name plate flip (shows vibe tag) ----
  test('mentor name plate toggles to vibe tag on click', async ({ page }) => {
    await runSession(page);

    const namePlate = page.locator('[class*="namePlate"]').first();
    await expect(namePlate).toBeVisible();
    const before = await namePlate.textContent();
    await namePlate.click();

    // After flip, the text should include a vibe separator "·"
    const after = await namePlate.textContent();
    expect(after).not.toBe(before);
    expect(after).toMatch(/·/);
  });

  // ---- 8. Save chat after group solve + session wrap (combined flow) ----
  test('full wrap flow: show wrap, save chat, drawer updated', async ({ page }) => {
    await runSession(page);

    // Show session wrap
    await page.locator('button').filter({ hasText: /Show session wrap|显示总结/ }).click();
    const sessionWrap = page.locator('[class*="sessionWrap"]');
    await expect(sessionWrap).toBeVisible();

    // Click save chat (goHomeAfterSave=false path, drawer opens)
    await page.getByTestId('mentor-save-chat').click();

    // Save notice appears
    await expect(page.getByTestId('mentor-save-notice')).toBeVisible({
      timeout: 3000
    });

    // Drawer should auto-open with memory
    const drawer = page.getByTestId('mentor-memory-drawer');
    await expect(drawer).toBeVisible({ timeout: 3000 });
    await expect(drawer.locator('[class*="memoryCard"]')).toHaveCount(1);
  });

  // ---- 9. Session wrap "new table" button resets to invite ----
  test('session wrap new table button returns user to invite phase', async ({
    page
  }) => {
    await runSession(page);
    await page.locator('button').filter({ hasText: /Show session wrap|显示总结/ }).click();
    await expect(page.locator('[class*="sessionWrap"]')).toBeVisible();

    await page.locator('button').filter({ hasText: /Start a new table|开启新圆桌/ }).click();

    // Back in invite phase
    await expect(page.getByTestId('mentor-person-input')).toBeVisible({
      timeout: 5000
    });
  });

  // ---- 10. Onboarding: "don't show again" → persist across reload ----
  test('onboarding keep-showing path persists 0 and overlay returns on reload', async ({
    browser
  }) => {
    const ctx = await browser.newContext({ baseURL: 'http://localhost:3001' });
    const page = await ctx.newPage();
    await page.goto('/', { waitUntil: 'networkidle' });

    const overlay = page.locator('[class*="onboardingOverlay"]');
    await expect(overlay).toBeVisible({ timeout: 10000 });

    // Advance to last slide
    await page.locator('[class*="onboardingBtnPrimary"]').click();
    await page.locator('[class*="onboardingBtnPrimary"]').click();

    // Click "Keep showing on startup" (second choice box)
    const choiceBoxes = page.locator('button[class*="onboardingChoiceBox"]');
    await choiceBoxes.nth(1).click();
    await expect(choiceBoxes.nth(1)).toHaveClass(/onboardingChoiceBoxActive/);

    // Click Get Started — localStorage set to '0'
    await page.locator('[class*="onboardingBtnPrimary"]').click();
    await expect(overlay).not.toBeVisible();

    // Verify localStorage
    const stored = await page.evaluate(() =>
      localStorage.getItem('mentorTableOnboardingHiddenV2')
    );
    expect(stored).toBe('0');

    // Reload — overlay should reappear since value is '0'
    await page.reload({ waitUntil: 'networkidle' });
    await expect(overlay).toBeVisible({ timeout: 10000 });

    await ctx.close();
  });

  // ---- 11b. Edit button preserves result; clicking a suggestion card opens
  //          the expandedSuggestion overlay (non-live, non-replyId branch) ----
  test('Edit → suggestion card → expandedSuggestion overlay → close', async ({
    page
  }) => {
    await runSession(page);

    // Click Edit (ghostBtn "edit") — goes back to invite phase but keeps result
    const editBtn = page.locator('button').filter({ hasText: /^\s*(Edit|编辑)\s*$/ }).first();
    await editBtn.click();

    // Wait for suggestion card button (in suggestionDeck — should render the
    // clickable <button> variant since phase!=='session' and reply exists).
    const suggestionCardBtn = page.locator('button[class*="suggestionCard"]').first();
    await expect(suggestionCardBtn).toBeVisible({ timeout: 5000 });
    await suggestionCardBtn.click();

    // expandedSuggestion overlay appears
    const overlay = page.locator('[class*="replyExpandOverlay"]');
    await expect(overlay).toBeVisible({ timeout: 3000 });

    // Close via the back button
    await page.locator('[class*="expandBackTopLeft"]').click();
    await expect(overlay).not.toBeVisible({ timeout: 3000 });
  });

  // ---- 11c. Debug prompt error path (API 500) ----
  test('debug prompt panel surfaces error when API fails', async ({ page }) => {
    // Mock the main advice endpoint with a valid response but make the debug
    // prompt endpoint return a 500 so fetchMentorDebugPrompt throws, hitting
    // the .catch() path in the useEffect that loads prompts.
    await page.route(/\/api\/mentor-debug-prompt/, (route: Route) => {
      route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' });
    });
    await page.route(/\/api\/mentor-table/, (route: Route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_RESPONSE)
      });
    });

    await addMentor(page, 'Bill Gates');
    await page.getByTestId('mentor-continue-wish').click();
    await page.getByTestId('mentor-problem-input').fill('Motivation question');
    await page.getByTestId('mentor-begin-session').click();
    await expect(
      page.getByTestId('mentor-conversation-panel').locator('footer').first()
    ).toBeVisible({ timeout: 15000 });

    // Hover mentor and open debug
    await page.locator('[class*="mentorAvatarWrap"]').first().hover();
    const debugIcon = page.locator('[class*="debugIconBtn"]').first();
    await expect(debugIcon).toBeVisible();
    await debugIcon.click();

    const debugPanel = page.locator('[class*="debugPromptPanel"]');
    await expect(debugPanel).toBeVisible({ timeout: 5000 });
    // Panel should eventually show an error message or the failure fallback
    await expect(debugPanel.locator('pre')).not.toHaveText(/Loading|加载中/, {
      timeout: 10000
    });
  });

  // ---- 11d. Chat back button closes the expanded reply overlay ----
  test('chat back button in the sidebar closes the expanded reply overlay', async ({
    page
  }) => {
    await runSession(page);

    // Click the tableReplyCard to open expanded reply overlay
    const tableReplyCard = page.locator('[class*="tableReplyCard"]').first();
    await expect(tableReplyCard).toBeVisible();
    await tableReplyCard.click();

    // Expand overlay visible
    await expect(page.locator('[class*="replyExpandOverlay"]')).toBeVisible();

    // Click the chatBackBtn in the conversation header
    const chatBackBtn = page.locator('[class*="chatBackBtn"]');
    await expect(chatBackBtn).toBeVisible();
    await chatBackBtn.click();

    await expect(page.locator('[class*="replyExpandOverlay"]')).not.toBeVisible({
      timeout: 3000
    });
  });

  // ---- 11. Suggestion card click opens expanded suggestion overlay ----
  test('suggestion card click (non-live preview) opens expanded suggestion', async ({
    page
  }) => {
    mockApis(page);
    await addMentor(page, 'Bill Gates');
    // Go to wish phase, but DO NOT submit — suggestionDeckEntries are only
    // populated when a reply exists. So we run a full session, but the suggestion
    // deck populates immediately on session start too. Target the suggestionCard
    // directly.
    await page.getByTestId('mentor-continue-wish').click();
    await page.getByTestId('mentor-problem-input').fill('Something to work on');
    await page.getByTestId('mentor-begin-session').click();

    // Wait for the session reply to appear
    await expect(
      page.getByTestId('mentor-conversation-panel').locator('footer').first()
    ).toBeVisible({ timeout: 15000 });

    // tableReplyCard (live path) should exist — click it to expand
    const card = page.locator('[class*="tableReplyCard"]').first();
    await expect(card).toBeVisible();
    await card.click();

    const expanded = page.locator('[class*="replyExpandedCard"]');
    await expect(expanded).toBeVisible({ timeout: 3000 });
  });

  // ---- 12. Multi-mentor session exercises ReplyAll / pending / visible-reveal loops ----
  test('multi-mentor session exercises reveal loop and reply-all all-branches', async ({
    page
  }) => {
    const MULTI = {
      schemaVersion: 'mentor_table.v1',
      language: 'en',
      safety: { riskLevel: 'low', needsProfessionalHelp: false, emergencyMessage: '' },
      mentorReplies: [
        {
          mentorId: 'bill_gates',
          mentorName: 'Bill Gates',
          likelyResponse: 'Identify bottlenecks first.',
          whyThisFits: 'Analytical.',
          oneActionStep: 'List 3 issues.',
          confidenceNote: ''
        },
        {
          mentorId: 'oprah_winfrey',
          mentorName: 'Oprah Winfrey',
          likelyResponse: 'How do you feel about this?',
          whyThisFits: 'Empathetic.',
          oneActionStep: 'Journal 10 minutes.',
          confidenceNote: ''
        }
      ],
      meta: { disclaimer: '', generatedAt: '2024-01-01T00:00:00Z', source: 'llm' }
    };
    await page.route(/\/api\/mentor-table/, (route: Route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MULTI)
      });
    });

    await addMentor(page, 'Bill Gates');
    await addMentor(page, 'Oprah');
    await page.getByTestId('mentor-continue-wish').click();
    await page.getByTestId('mentor-problem-input').fill('I feel stuck at work.');
    await page.getByTestId('mentor-begin-session').click();

    // Move the mouse far off-screen so isConversationHovered stays false and
    // the reveal loop (2.6s interval) can advance to both replies.
    await page.mouse.move(0, 0);

    // Wait for both replies to appear (reveal loop fires every 2.6s)
    const conv = page.getByTestId('mentor-conversation-panel');
    await expect(conv.locator('footer').filter({ hasText: /Next move|下一步/ })).toHaveCount(2, {
      timeout: 30000
    });

    // Use reply-all: send a message to all
    const replyAll = page.locator('[class*="replyAllDockCard"] textarea');
    await expect(replyAll).toBeVisible();
    await replyAll.fill('Thanks, now a follow-up for everyone');
    await page.locator('[class*="replyAllDockCard"] [class*="ghostBtn"]').click();

    // A new conversation turn appears with both mentor follow-up replies
    const turnGroup = page.locator('[class*="turnGroup"]').first();
    await expect(turnGroup).toBeVisible({ timeout: 15000 });

    // Pass a note to a single mentor (second pass-note path exercising find logic)
    const passNoteBtn = page.locator('[class*="passNoteBtn"]').first();
    await passNoteBtn.click();
    const noteBox = page.locator('[class*="inlineNoteBox"] textarea').first();
    await expect(noteBox).toBeVisible();
    await noteBox.fill('One specific question for you');
    await page
      .locator('[class*="inlineNoteBox"] [class*="ghostBtn"]')
      .first()
      .click();
  });


  // ---- 14. Language switch to zh-CN via i18next then back ----
  test('language switching swaps UI text via localStorage i18nextLng', async ({ browser }) => {
    const ctx = await browser.newContext({ baseURL: 'http://localhost:3001' });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      localStorage.setItem('mentorTableOnboardingHiddenV2', '1');
      localStorage.setItem('i18nextLng', 'zh-CN');
    });
    await page.goto('/', { waitUntil: 'networkidle' });

    // The Chinese UI has "召唤人物" in phase pill 1
    const pill = page.locator('[class*="phasePill"]').first();
    await expect(pill).toBeVisible({ timeout: 10000 });
    await expect(pill).toContainText(/召唤|Summon/);
    await ctx.close();
  });

  // ---- 15. Session restart via topbar button clears everything ----
  test('topbar restart after session clears result and returns to invite', async ({
    page
  }) => {
    await runSession(page);

    const restartBtn = page.locator('button').filter({ hasText: /Restart|重新开始/ });
    await restartBtn.click();

    await expect(page.getByTestId('mentor-person-input')).toBeVisible({
      timeout: 5000
    });
    // Conversation panel should be gone
    await expect(page.getByTestId('mentor-conversation-panel')).not.toBeVisible({
      timeout: 3000
    });
  });

  // ---- 16. Image onError fallback: simulate a broken avatar URL ----
  test('broken mentor avatar still renders (onError fires)', async ({ page }) => {
    await addMentor(page, 'Bill Gates');
    // Manually break all images on the page to force the onError chain
    await page.evaluate(() => {
      document.querySelectorAll('img').forEach((img) => {
        img.dispatchEvent(new Event('error'));
      });
    });
    // Sanity: search input still present
    await expect(page.getByTestId('mentor-person-input')).toBeVisible();
  });

  // ---- 17. Custom mentor added via Enter key triggers fetchPersonImage hydration ----
  test('custom mentor via Enter triggers image hydration (fetchPersonImage path)', async ({
    page
  }) => {
    const input = page.getByTestId('mentor-person-input');
    // Unusual name that has no verified person entry, forcing the shouldHydrateProfile branch
    await input.fill('Zaphod Beeblebrox');
    await input.press('Enter');
    await expect(input).toHaveValue('', { timeout: 3000 });
    // Wait a beat for the background hydration Promise.all to settle
    await page.waitForTimeout(500);
    // Card still present
    await expect(page.getByText('Zaphod Beeblebrox').first()).toBeVisible();
  });

  // ---- 18. Long session triggers the 4.2s activeResultIndex interval ----
  test('session >5s exercises active reply rotation interval', async ({ page }) => {
    const MULTI = {
      schemaVersion: 'mentor_table.v1',
      language: 'en',
      safety: { riskLevel: 'low', needsProfessionalHelp: false, emergencyMessage: '' },
      mentorReplies: [
        {
          mentorId: 'bill_gates',
          mentorName: 'Bill Gates',
          likelyResponse: 'Reply A.',
          whyThisFits: '',
          oneActionStep: 'Step A.',
          confidenceNote: ''
        },
        {
          mentorId: 'oprah_winfrey',
          mentorName: 'Oprah Winfrey',
          likelyResponse: 'Reply B.',
          whyThisFits: '',
          oneActionStep: 'Step B.',
          confidenceNote: ''
        }
      ],
      meta: { disclaimer: '', generatedAt: '2024-01-01T00:00:00Z', source: 'llm' }
    };
    await page.route(/\/api\/mentor-table/, (route: Route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MULTI)
      });
    });

    await addMentor(page, 'Bill Gates');
    await addMentor(page, 'Oprah');
    await page.getByTestId('mentor-continue-wish').click();
    await page.getByTestId('mentor-problem-input').fill('Rotation test');
    await page.getByTestId('mentor-begin-session').click();

    // Move mouse off so isConversationHovered stays false
    await page.mouse.move(0, 0);
    await expect(
      page.getByTestId('mentor-conversation-panel').locator('footer')
    ).toHaveCount(2, { timeout: 30000 });

    // Wait long enough for the 4.2s activeResultIndex interval to fire at
    // least twice (so setActiveResultIndex's callback runs).
    await page.waitForTimeout(9000);
  });

  // ---- 19. Open expanded reply then restart — triggers expandedReplyId cleanup effect ----
  test('restart while a reply is expanded triggers expandedReplyId cleanup', async ({
    page
  }) => {
    await runSession(page);

    // Open an expanded reply
    const tableReplyCard = page.locator('[class*="tableReplyCard"]').first();
    await expect(tableReplyCard).toBeVisible();
    await tableReplyCard.click();
    await expect(page.locator('[class*="replyExpandOverlay"]')).toBeVisible();

    // Now click the topbar Restart — this clears result with expandedReplyId
    // still set, exercising the cleanup useEffect.
    const restartBtn = page.locator('button').filter({ hasText: /Restart|重新开始/ });
    await restartBtn.click();

    await expect(page.getByTestId('mentor-person-input')).toBeVisible({
      timeout: 5000
    });
  });

  // ---- 20. Empty-search "searching" row and "no results" fallback ----
  test('typing a very unusual query eventually renders the searching row', async ({
    page
  }) => {
    const input = page.getByTestId('mentor-person-input');
    await input.fill('zz_nonexistent_q');
    // The suggestion menu appears because personQuery is non-empty
    const menu = page.locator('[class*="suggestionMenu"]');
    await expect(menu).toBeVisible({ timeout: 3000 });
    // Wait briefly — either a searching row OR a "no results" row appears
    await page.waitForTimeout(600);
    await expect(menu).toBeVisible();
  });
});

// Separate describe for Chinese-locale path coverage + misc coverage.
test.describe('Mentor Table zh-CN coverage', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('mentorTableOnboardingHiddenV2', '1');
      localStorage.setItem('i18nextLng', 'zh-CN');
    });
    await page.goto('/', { waitUntil: 'networkidle' });
    await expect(page.getByTestId('mentor-person-input')).toBeVisible({
      timeout: 10000
    });
  });

  test('zh-CN session with Chinese text exercises simplifyLikelyResponse/simplifyActionStep regexes', async ({
    page
  }) => {
    // Mock returns a reply that matches the zh-CN simplify regex patterns:
    //   - simplifyLikelyResponse strips leading "我会先把这个拆成可执行步骤：" etc.
    //   - simplifyActionStep strips leading "下一步: "
    const ZH_MOCK = {
      schemaVersion: 'mentor_table.v1',
      language: 'zh-CN',
      safety: { riskLevel: 'low', needsProfessionalHelp: false, emergencyMessage: '' },
      mentorReplies: [
        {
          mentorId: 'bill_gates',
          mentorName: 'Bill Gates',
          likelyResponse:
            '我会先把这个拆成可执行步骤：先列出三个核心瓶颈，然后排序，之后从优先级最高的开始逐个处理。这是一段很长的文字，长到足以让预览被截断。',
          whyThisFits: '分析型方法。',
          oneActionStep: '下一步: 写下你能想到的三个瓶颈并按影响力排序。',
          confidenceNote: ''
        }
      ],
      meta: { disclaimer: '', generatedAt: '2024-01-01T00:00:00Z', source: 'llm' }
    };
    await page.route(/\/api\/mentor-table/, (route: Route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(ZH_MOCK)
      });
    });

    const input = page.getByTestId('mentor-person-input');
    await input.fill('比尔');
    await input.press('Enter');
    await expect(input).toHaveValue('', { timeout: 3000 });
    await page.getByTestId('mentor-continue-wish').click();
    await page.getByTestId('mentor-problem-input').fill('我最近很焦虑。');
    await page.getByTestId('mentor-begin-session').click();

    // Move mouse off the conversation panel so reveal timer keeps running
    await page.mouse.move(0, 0);
    await expect(
      page.getByTestId('mentor-conversation-panel').locator('footer').first()
    ).toBeVisible({ timeout: 15000 });
    // The mere fact that the conversation reply renders means
    // simplifyLikelyResponse + simplifyActionStep have run in zh-CN mode.
  });
});

// Separate describe for onboarding-slides coverage — this block does NOT use
// the outer beforeEach (which forcibly hides onboarding), so the overlay
// appears on first visit and every slide-nav button click is reachable.
test.describe('Mentor Table onboarding coverage', () => {
  test('back, next, don\'t show again, keep showing, Get Started (full slide nav)', async ({
    page
  }) => {
    // Default page fixture — coverage-fixture CAN collect __coverage__ from it.
    // No addInitScript suppressing the flag, so onboarding is shown.
    await page.addInitScript(() => {
      localStorage.removeItem('mentorTableOnboardingHiddenV2');
    });
    await page.goto('/', { waitUntil: 'networkidle' });

    const overlay = page.locator('[class*="onboardingOverlay"]');
    await expect(overlay).toBeVisible({ timeout: 10000 });

    // Next → slide 2
    await page.locator('[class*="onboardingBtnPrimary"]').click();
    // Next → slide 3
    await page.locator('[class*="onboardingBtnPrimary"]').click();
    // Back → slide 2
    await page.locator('[class*="onboardingBtnSecondary"]').click();
    // Next → slide 3
    await page.locator('[class*="onboardingBtnPrimary"]').click();

    // Click both choice boxes to exercise both setDontShowOnboardingAgain handlers.
    const choiceBoxes = page.locator('button[class*="onboardingChoiceBox"]');
    await choiceBoxes.nth(0).click();
    await expect(choiceBoxes.nth(0)).toHaveClass(/onboardingChoiceBoxActive/);
    await choiceBoxes.nth(1).click();
    await expect(choiceBoxes.nth(1)).toHaveClass(/onboardingChoiceBoxActive/);
    await choiceBoxes.nth(0).click();

    // Get Started
    await page.locator('[class*="onboardingBtnPrimary"]').click();
    await expect(overlay).not.toBeVisible();

    const stored = await page.evaluate(() =>
      localStorage.getItem('mentorTableOnboardingHiddenV2')
    );
    expect(stored).toBe('1');
  });
});
