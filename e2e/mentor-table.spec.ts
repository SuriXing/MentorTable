import { test, expect } from './coverage-fixture';

// Increase timeout for tests that trigger LLM API calls (can take 25-30s)
test.setTimeout(60000);

test.describe('Mentor Table E2E', () => {
  test.beforeEach(async ({ page }) => {
    // Dismiss onboarding by setting localStorage flag before navigation
    await page.addInitScript(() => {
      localStorage.setItem('mentorTableOnboardingHiddenV2', '1');
    });
    await page.goto('/', { waitUntil: 'networkidle' });
    // Wait for React to hydrate and render the mentor input
    await expect(page.getByTestId('mentor-person-input')).toBeVisible({ timeout: 10000 });
  });

  /**
   * Helper: add a mentor by typing in the search box and clicking a suggestion
   * or pressing Enter if no suggestion appears.
   */
  async function addMentor(page: import('@playwright/test').Page, name: string) {
    const searchInput = page.getByTestId('mentor-person-input');
    await searchInput.fill(name);

    // Wait for suggestion menu items to appear (they may show localized names)
    const suggestionMenu = page.locator('[class*="suggestionMenu"]');
    await expect(suggestionMenu).toBeVisible({ timeout: 5000 });

    // Click the first suggestion item (button inside the menu)
    const firstSuggestion = suggestionMenu.locator('[class*="suggestionItem"]').first();
    const hasSuggestion = await firstSuggestion.isVisible().catch(() => false);

    if (hasSuggestion) {
      await firstSuggestion.click();
    } else {
      // Fallback: press Enter to add as custom mentor
      await searchInput.press('Enter');
    }

    // Wait for the input to clear (indicates the mentor was added)
    await expect(searchInput).toHaveValue('', { timeout: 3000 });
  }

  test('page loads and shows the mentor table UI', async ({ page }) => {
    // The hero title should be visible (zh-CN default)
    const heroTitle = page.locator('h1');
    await expect(heroTitle).toBeVisible();
    const titleText = await heroTitle.textContent();
    expect(
      titleText?.includes('名人桌') || titleText?.includes('Mentor Table')
    ).toBeTruthy();

    // The search input should be visible in the invite phase
    await expect(page.getByTestId('mentor-person-input')).toBeVisible();
  });

  test('mentor selection — search and add mentors', async ({ page }) => {
    await addMentor(page, 'Bill Gates');

    // The guest card should now appear in the selected grid
    const guestCards = page.locator('[class*="guestCard"]');
    await expect(guestCards.first()).toBeVisible();

    // Add a second mentor
    await addMentor(page, 'Oprah');

    // Both should be present — check guest count shows 2
    const guestCount = page.locator('text=/Guests.*2|人物数.*2/');
    await expect(guestCount).toBeVisible();
  });

  test('problem input and submit flow', async ({ page }) => {
    // Add a mentor first
    await addMentor(page, 'Bill Gates');

    // Navigate to wish phase
    await page.getByTestId('mentor-continue-wish').click();

    // Type a problem
    const problemInput = page.getByTestId('mentor-problem-input');
    await expect(problemInput).toBeVisible();
    await problemInput.fill('How do I stay motivated when learning feels overwhelming?');

    // Submit
    const beginBtn = page.getByTestId('mentor-begin-session');
    await expect(beginBtn).toBeEnabled();
    await beginBtn.click();

    // Should transition to session phase — conversation panel should appear
    const conversationPanel = page.getByTestId('mentor-conversation-panel');
    await expect(conversationPanel).toBeVisible({ timeout: 10000 });

    // Wait for a mentor reply to appear. The reply contains a footer with
    // "下一步" (zh) or "Next move" (en) which distinguishes it from typing indicators.
    const replyFooter = conversationPanel.locator('footer').filter({
      hasText: /下一步|Next move/,
    });
    await expect(replyFooter.first()).toBeVisible({ timeout: 45000 });
  });

  test('safety detection — high-risk input shows emergency message', async ({ page }) => {
    // Intercept the mentor-table API to force a local fallback, which has
    // deterministic safety detection. This avoids depending on LLM output.
    await page.route('**/api/mentor-table', (route) => {
      route.abort('connectionrefused');
    });

    await addMentor(page, 'Bill Gates');

    // Go to wish phase
    await page.getByTestId('mentor-continue-wish').click();

    // Type a high-risk message (triggers "high" in local detectRiskLevel)
    const problemInput = page.getByTestId('mentor-problem-input');
    await problemInput.fill('I want to kill myself');

    // Submit
    await page.getByTestId('mentor-begin-session').click();

    // Wait for the conversation panel (session phase)
    const conversationPanel = page.getByTestId('mentor-conversation-panel');
    await expect(conversationPanel).toBeVisible({ timeout: 10000 });

    // The local fallback sets riskLevel='high' for this input and renders
    // a risk banner with the emergency message. The exact text from mentorEngine:
    // EN: "contact local emergency services or a crisis hotline"
    // ZH: "请立刻联系当地紧急服务或危机热线"
    const emergencyText = page.getByText(/紧急服务|crisis hotline|emergency services/i);
    await expect(emergencyText.first()).toBeVisible({ timeout: 15000 });
  });

  test('language switching — changing language updates UI text', async ({ page }) => {
    // Get the current hero title (should be Chinese by default)
    const heroTitle = page.locator('h1');
    await expect(heroTitle).toBeVisible();
    const initialTitle = await heroTitle.textContent();

    // Switch language via localStorage and reload
    await page.evaluate(() => {
      const currentLang = localStorage.getItem('language') || 'zh-CN';
      const newLang = currentLang.startsWith('zh') ? 'en' : 'zh-CN';
      localStorage.setItem('language', newLang);
    });

    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByTestId('mentor-person-input')).toBeVisible({ timeout: 10000 });

    const newTitle = await heroTitle.textContent();

    // The title should have changed
    if (initialTitle?.includes('名人桌')) {
      expect(newTitle).toContain('Mentor Table');
    } else {
      expect(newTitle).toContain('名人桌');
    }
  });

  test('onboarding modal appears on first visit', async ({ page }) => {
    // Create a fresh page WITHOUT the onboarding-skip setup
    const freshPage = await page.context().newPage();
    await freshPage.addInitScript(() => {
      localStorage.removeItem('mentorTableOnboardingHiddenV2');
    });
    await freshPage.goto('/', { waitUntil: 'networkidle' });

    // Should see the onboarding slide title
    const slideTitle = freshPage.getByText(/Welcome to Mentor Table|欢迎来到名人桌/);
    await expect(slideTitle).toBeVisible({ timeout: 10000 });

    await freshPage.close();
  });

  test('custom mentor — add via Enter key', async ({ page }) => {
    const searchInput = page.getByTestId('mentor-person-input');
    await searchInput.fill('Doraemon');
    await searchInput.press('Enter');

    // The custom mentor should appear in the grid
    const guestCard = page.locator('strong').filter({ hasText: /Doraemon/i });
    await expect(guestCard).toBeVisible({ timeout: 5000 });
  });

  test('remove mentor from selection', async ({ page }) => {
    // Add a mentor
    await addMentor(page, 'Bill Gates');

    // Verify a guest card appeared
    const guestCards = page.locator('[class*="guestCard"]');
    await expect(guestCards.first()).toBeVisible();

    // Click the remove (X) button on the guest card
    const removeBtn = guestCards.first().locator('[class*="removeGuestBtn"]');
    await removeBtn.click();

    // The guest card should no longer be visible
    await expect(guestCards).toHaveCount(0);
  });
});
