/**
 * T1/T3 close-out: the degradation contract pinned end to end with no
 * secrets. CI runs the real server without an LLM key, so every API call
 * fails with 500 and the client falls back to its local deterministic
 * simulator — the same path a user hits when the upstream is down or the
 * operator has tripped the cost breaker. This spec asserts that path
 * honestly: the table still works, every surface says where the words came
 * from, and the conversation records only what happened.
 */
import { test, expect } from '@playwright/test';

test.describe('no-key degradation contract', () => {
  test('session works end to end and every surface discloses local fallback', async ({ page }) => {
    // No route mocking: the request must really hit server.js on :8787 and
    // really fail (CI has no LLM_API_KEY). If a key leaks into the env this
    // test would exercise the live path instead — detect and skip loudly.
    const apiStatuses: number[] = [];
    page.on('response', async (res) => {
      if (res.url().includes('/api/mentor-table')) {
        apiStatuses.push(res.status());
      }
    });

    await page.addInitScript(() => {
      localStorage.setItem('mentorTableOnboardingHiddenV2', '1');
    });
    await page.goto('/', { waitUntil: 'networkidle' });
    await expect(page.getByTestId('mentor-person-input')).toBeVisible({ timeout: 10000 });

    // Add a mentor through the real search flow.
    const search = page.getByTestId('mentor-person-input');
    await search.fill('Bill Gates');
    const menu = page.locator('[class*="suggestionMenu"]');
    await expect(menu).toBeVisible({ timeout: 5000 });
    const first = menu.locator('[class*="suggestionItem"]').first();
    if (await first.isVisible()) {
      await first.click();
    } else {
      await search.press('Enter');
    }
    await expect(search).toHaveValue('', { timeout: 3000 });

    await page.getByTestId('mentor-continue-wish').click();
    await page.getByTestId('mentor-problem-input').fill('How do I stay motivated?');
    await page.getByTestId('mentor-begin-session').click();

    // The API really returned the no-key 500 (degradation, not a mock).
    await expect
      .poll(() => apiStatuses.some((s) => s === 500), { timeout: 15000 })
      .toBe(true);

    // The conversation still renders — the client-side simulator carried it.
    await expect(page.getByTestId('mentor-conversation-panel')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('[class*="conversationBubble"]').first()).toBeVisible({
      timeout: 15000,
    });

    // The sidebar source badge discloses the fallback.
    await expect(page.locator('[class*="sourceTag"]')).toContainText(/Local Fallback|本地回退/i, {
      timeout: 10000,
    });

    // Reply-all round: the turn bubble carries the fallback chip too.
    const replyAll = page.locator('[class*="replyAllDockCard"] textarea');
    await replyAll.fill('Anyone else?');
    await page.getByRole('button', { name: /Send to all|发送给所有人/i }).click();
    const turnBubble = page
      .locator('[class*="turnGroup"] [class*="conversationLeftBubble"]')
      .first();
    await expect(turnBubble).toBeVisible({ timeout: 15000 });
    await expect(turnBubble.locator('[class*="sourceTagSmall"]')).toContainText(
      /Local Fallback|本地回退/i,
      { timeout: 5000 }
    );

    // Note thread: submit a note; the local simulator's reply lands as a
    // conversation turn carrying the fallback chip (a successful note never
    // renders inline thread markers — those are for delivery failures).
    const passNote = page.locator('[class*="passNoteBtn"]').first();
    await passNote.click();
    const noteBox = page.locator('[class*="inlineNoteBox"] textarea').first();
    await noteBox.fill('One concrete step?');
    await page.locator('[class*="inlineNoteBox"] button').first().click();
    const noteTurn = page.locator('[class*="turnGroup"]').filter({ hasText: 'One concrete step?' });
    await expect(noteTurn).toBeVisible({ timeout: 15000 });
    await expect(noteTurn.locator('[class*="sourceTagSmall"]').first()).toContainText(
      /Local Fallback|本地回退/i,
      { timeout: 5000 }
    );
  });
});
