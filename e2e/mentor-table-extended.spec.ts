import type { Page, Route } from '@playwright/test';
import { test, expect } from './coverage-fixture';

test.setTimeout(60000);

// ---------- Mock data ----------

const MOCK_RESPONSE_1_MENTOR = {
  schemaVersion: 'mentor_table.v1',
  language: 'en',
  safety: { riskLevel: 'low', needsProfessionalHelp: false, emergencyMessage: '' },
  mentorReplies: [
    {
      mentorId: 'bill_gates',
      mentorName: 'Bill Gates',
      likelyResponse: 'I would start by identifying the core bottleneck.',
      whyThisFits: 'Analytical approach fits this problem.',
      oneActionStep: 'List 3 issues and pick the highest-impact one.',
      confidenceNote: 'AI-simulated perspective.'
    }
  ],
  meta: { disclaimer: 'AI simulation.', generatedAt: '2024-01-01T00:00:00Z', source: 'llm' }
};

const MOCK_RESPONSE_2_MENTORS = {
  schemaVersion: 'mentor_table.v1',
  language: 'en',
  safety: { riskLevel: 'low', needsProfessionalHelp: false, emergencyMessage: '' },
  mentorReplies: [
    {
      mentorId: 'bill_gates',
      mentorName: 'Bill Gates',
      likelyResponse: 'I would start by identifying the core bottleneck.',
      whyThisFits: 'Analytical approach fits this problem.',
      oneActionStep: 'List 3 issues and pick the highest-impact one.',
      confidenceNote: 'AI-simulated perspective.'
    },
    {
      mentorId: 'oprah_winfrey',
      mentorName: 'Oprah Winfrey',
      likelyResponse: 'What matters most is how you feel about this situation.',
      whyThisFits: 'Emotional intelligence approach.',
      oneActionStep: 'Journal for 10 minutes about your feelings.',
      confidenceNote: 'AI-simulated perspective.'
    }
  ],
  meta: { disclaimer: 'AI simulation.', generatedAt: '2024-01-01T00:00:00Z', source: 'llm' }
};

// ---------- Helpers ----------

async function addMentor(page: Page, name: string) {
  const searchInput = page.getByTestId('mentor-person-input');
  await searchInput.fill(name);

  const suggestionMenu = page.locator('[class*="suggestionMenu"]');
  await expect(suggestionMenu).toBeVisible({ timeout: 5000 });

  const firstSuggestion = suggestionMenu.locator('[class*="suggestionItem"]').first();
  const hasSuggestion = await firstSuggestion.isVisible().catch(() => false);

  if (hasSuggestion) {
    await firstSuggestion.click();
  } else {
    await searchInput.press('Enter');
  }

  await expect(searchInput).toHaveValue('', { timeout: 3000 });
}

/** Intercept all mentor-table API endpoints with a mock response. */
function mockMentorApi(page: Page, response: object) {
  return page.route(/\/api\/mentor-table/, (route: Route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(response)
    });
  });
}

/**
 * Run a full session: add mentors, set problem, submit, wait for replies to appear.
 * Returns after all mentor reply footers are visible (session complete).
 */
async function runFullSession(
  page: Page,
  mentors: string[],
  response: object,
  problem = 'How do I stay motivated?'
) {
  await mockMentorApi(page, response);

  for (const name of mentors) {
    await addMentor(page, name);
  }

  await page.getByTestId('mentor-continue-wish').click();
  await page.getByTestId('mentor-problem-input').fill(problem);
  await page.getByTestId('mentor-begin-session').click();

  const conversationPanel = page.getByTestId('mentor-conversation-panel');
  await expect(conversationPanel).toBeVisible({ timeout: 10000 });

  // Wait for all replies to become visible (each reveals after ~2.6s)
  const replyFooter = conversationPanel.locator('footer').filter({ hasText: /下一步|Next move/ });
  await expect(replyFooter).toHaveCount(
    (response as typeof MOCK_RESPONSE_1_MENTOR).mentorReplies.length,
    { timeout: 30000 }
  );
}

// ============================
// Tests
// ============================

test.describe('Mentor Table Extended E2E', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('mentorTableOnboardingHiddenV2', '1');
    });
    await page.goto('/', { waitUntil: 'networkidle' });
    await expect(page.getByTestId('mentor-person-input')).toBeVisible({ timeout: 10000 });
  });

  // ---- 1. Onboarding flow — slide navigation ----
  test('onboarding flow — slide navigation', async ({ page }) => {
    const freshPage = await page.context().newPage();
    await freshPage.addInitScript(() => {
      localStorage.removeItem('mentorTableOnboardingHiddenV2');
    });
    await freshPage.goto('/', { waitUntil: 'networkidle' });

    // Slide 1 visible
    const slideTitle = freshPage.locator('[class*="onboardingCard"] h3');
    await expect(slideTitle).toBeVisible({ timeout: 10000 });
    const slide1Text = await slideTitle.textContent();
    expect(slide1Text).toMatch(/Welcome to Mentor Table|欢迎来到名人桌/);

    // Click Next → slide 2
    await freshPage.locator('[class*="onboardingBtnPrimary"]').click();
    await expect(slideTitle).toHaveText(/How does it work|怎么用/);

    // Click Back → slide 1
    await freshPage.locator('[class*="onboardingBtnSecondary"]').click();
    await expect(slideTitle).toHaveText(/Welcome to Mentor Table|欢迎来到名人桌/);

    // Advance to last slide (click Next twice)
    await freshPage.locator('[class*="onboardingBtnPrimary"]').click();
    await freshPage.locator('[class*="onboardingBtnPrimary"]').click();
    await expect(slideTitle).toHaveText(/Ready|准备好了吗/);

    // Click Get Started → onboarding dismissed
    await freshPage.locator('[class*="onboardingBtnPrimary"]').click();
    await expect(freshPage.locator('[class*="onboardingOverlay"]')).not.toBeVisible();

    await freshPage.close();
  });

  // ---- 2. Onboarding — don't show again ----
  test('onboarding — don\'t show again persists across reload', async ({ browser }) => {
    // Use a fresh context so no addInitScript interferes with localStorage
    const ctx = await browser.newContext({ baseURL: 'http://localhost:3001' });
    const freshPage = await ctx.newPage();
    await freshPage.goto('/', { waitUntil: 'networkidle' });

    const overlay = freshPage.locator('[class*="onboardingOverlay"]');
    await expect(overlay).toBeVisible({ timeout: 10000 });

    // Advance to last slide
    await freshPage.locator('[class*="onboardingBtnPrimary"]').click();
    await freshPage.locator('[class*="onboardingBtnPrimary"]').click();

    // Click "Don't show again" — target buttons (not the parent container div)
    const dontShowBtn = freshPage.locator('button[class*="onboardingChoiceBox"]').first();
    await dontShowBtn.click();
    // Wait for React to process the state update (active class appears)
    await expect(dontShowBtn).toHaveClass(/onboardingChoiceBoxActive/, { timeout: 2000 });

    // Click Get Started
    await freshPage.locator('[class*="onboardingBtnPrimary"]').click();
    await expect(overlay).not.toBeVisible();

    // Reload — onboarding should NOT reappear (localStorage persists in same context)
    await freshPage.reload({ waitUntil: 'networkidle' });
    await expect(overlay).not.toBeVisible({ timeout: 5000 });

    await ctx.close();
  });

  // ---- 3. Shuffle seating ----
  test('shuffle seating keeps mentors present', async ({ page }) => {
    await addMentor(page, 'Bill Gates');
    await addMentor(page, 'Oprah');

    const guestCards = page.locator('[class*="guestCard"]');
    await expect(guestCards).toHaveCount(2);

    // Click shuffle button (ghostBtn with shuffle icon/text)
    const shuffleBtn = page.locator('[class*="ghostBtn"]').filter({ hasText: /Shuffle|换座位/ });
    await shuffleBtn.click();

    // Both mentors still present
    await expect(guestCards).toHaveCount(2);
    await expect(page.locator('strong').filter({ hasText: /Bill Gates|比尔·盖茨/ })).toBeVisible();
    await expect(page.locator('strong').filter({ hasText: /Oprah|奥普拉/ })).toBeVisible();
  });

  // ---- 4. Card flip ----
  test('card flip shows vibe tag text', async ({ page }) => {
    await addMentor(page, 'Bill Gates');

    const guestCard = page.locator('[class*="guestCard"]').first();
    await expect(guestCard).toBeVisible();

    // Click the flip button
    const flipBtn = guestCard.locator('[class*="flipMiniBtn"]');
    await flipBtn.click();

    // After flip, the card should show the "keep going" text
    await expect(guestCard.locator('span')).toHaveText(/keep going|继续前进|加油/i);
  });

  // ---- 5. Pass-a-note follow-up ----
  test('pass-a-note follow-up produces reply', async ({ page }) => {
    await runFullSession(page, ['Bill Gates'], MOCK_RESPONSE_1_MENTOR);

    // Click "Pass a note" / "给" button on the reply
    const passNoteBtn = page.locator('[class*="passNoteBtn"]').first();
    await passNoteBtn.click();

    // Type follow-up in the note textarea
    const noteBox = page.locator('[class*="inlineNoteBox"] textarea').first();
    await expect(noteBox).toBeVisible();
    await noteBox.fill('Can you elaborate on that?');

    // Click send (ghostBtn inside inlineNoteBox)
    const sendBtn = page.locator('[class*="inlineNoteBox"] [class*="ghostBtn"]').first();
    await sendBtn.click();

    // Wait for the follow-up reply to appear in conversation turns
    const conversationPanel = page.getByTestId('mentor-conversation-panel');
    const turnGroup = conversationPanel.locator('[class*="turnGroup"]');
    await expect(turnGroup.first()).toBeVisible({ timeout: 15000 });
  });

  // ---- 6. Reply-all ----
  test('reply-all sends message to all mentors', async ({ page }) => {
    // Use 1 mentor to avoid reveal-timer timing issues in CI
    await runFullSession(page, ['Bill Gates'], MOCK_RESPONSE_1_MENTOR);

    // The reply-all textarea should be visible after session completes
    const replyAllTextarea = page.locator('[class*="replyAllDockCard"] textarea');
    await expect(replyAllTextarea).toBeVisible({ timeout: 5000 });

    await replyAllTextarea.fill('What do you think about teamwork?');

    // Click "Send to all" button
    const sendAllBtn = page.locator('[class*="replyAllDockCard"] [class*="ghostBtn"]');
    await sendAllBtn.click();

    // Wait for a new conversation turn to appear
    const turnGroups = page.locator('[class*="turnGroup"]');
    await expect(turnGroups.first()).toBeVisible({ timeout: 15000 });
  });

  // ---- 7. Session wrap + save chat ----
  test('session wrap shows takeaways and save works', async ({ page }) => {
    await runFullSession(page, ['Bill Gates'], MOCK_RESPONSE_1_MENTOR);

    // Click "Show session wrap" button
    const showWrapBtn = page.locator('button').filter({ hasText: /Show session wrap|显示总结/ });
    await showWrapBtn.click();

    // Session wrap panel appears
    const sessionWrap = page.locator('[class*="sessionWrap"]');
    await expect(sessionWrap).toBeVisible({ timeout: 5000 });

    // Verify takeaway content
    await expect(sessionWrap.locator('li')).toHaveCount(1); // 1 mentor = 1 takeaway
    await expect(sessionWrap.locator('li').first()).toHaveText(
      'List 3 issues and pick the highest-impact one.'
    );

    // Click save chat
    await page.getByTestId('mentor-save-chat').click();

    // Verify save notice appears
    await expect(page.getByTestId('mentor-save-notice')).toBeVisible({ timeout: 3000 });
  });

  // ---- 8. Memory drawer ----
  test('memory drawer shows saved memories', async ({ page }) => {
    // Open empty drawer
    await page.getByTestId('mentor-memory-fab').click();
    const drawer = page.getByTestId('mentor-memory-drawer');
    await expect(drawer).toBeVisible({ timeout: 3000 });

    // Shows "No saved memories yet"
    await expect(drawer.getByText(/No saved memories yet|还没有保存内容/)).toBeVisible();

    // Close drawer
    await page.getByTestId('mentor-memory-fab').click();
    await expect(drawer).not.toBeVisible();

    // Complete a session and save
    await runFullSession(page, ['Bill Gates'], MOCK_RESPONSE_1_MENTOR);

    // Show session wrap and save
    const showWrapBtn = page.locator('button').filter({ hasText: /Show session wrap|显示总结/ });
    await showWrapBtn.click();
    await page.getByTestId('mentor-save-chat').click();
    await expect(page.getByTestId('mentor-save-notice')).toBeVisible({ timeout: 3000 });

    // saveTakeawayMemory auto-opens the drawer, so it should already be visible
    // (clicking FAB again would toggle it closed)
    await expect(drawer).toBeVisible({ timeout: 3000 });
    await expect(drawer.locator('[class*="memoryCard"]')).toHaveCount(1);
  });

  // ---- 9. Restart button ----
  test('restart button returns to invite phase', async ({ page }) => {
    await addMentor(page, 'Bill Gates');
    await page.getByTestId('mentor-continue-wish').click();

    // Verify we are in wish phase (problem input visible)
    await expect(page.getByTestId('mentor-problem-input')).toBeVisible();

    // Click restart
    const restartBtn = page.locator('[class*="ghostBtn"]').filter({ hasText: /Restart|重新开始/ });
    await restartBtn.click();

    // Should be back in invite phase: search input visible
    // Note: restart clears session state but keeps selectedPeople, so the mentor card remains
    await expect(page.getByTestId('mentor-person-input')).toBeVisible({ timeout: 5000 });
    // Verify phase is invite (problem input should NOT be visible)
    await expect(page.getByTestId('mentor-problem-input')).not.toBeVisible();
    // Guest card remains since restart doesn't clear selections
    await expect(page.locator('[class*="guestCard"]')).toHaveCount(1);
  });

  // ---- 10. Phase navigation via pills ----
  test('phase pill navigates back to invite with mentors kept', async ({ page }) => {
    await addMentor(page, 'Bill Gates');
    await page.getByTestId('mentor-continue-wish').click();

    // Verify in wish phase
    await expect(page.getByTestId('mentor-problem-input')).toBeVisible();

    // Click the first phase pill ("Summon Guests" / "召唤人物")
    const invitePill = page.locator('[class*="phasePill"]').first();
    await invitePill.click();

    // Should be back in invite phase with mentor still selected
    await expect(page.getByTestId('mentor-person-input')).toBeVisible({ timeout: 5000 });
    const guestCards = page.locator('[class*="guestCard"]');
    await expect(guestCards).toHaveCount(1);
    await expect(page.locator('strong').filter({ hasText: /Bill Gates|比尔·盖茨/ })).toBeVisible();
  });
});
