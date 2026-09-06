import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const BASE = process.env.PS_BASE_URL || 'http://127.0.0.1:8788';

test.use({ viewport: { width: 390, height: 844 }, colorScheme: 'light' });

test('refined auth is keyboard-accessible and passes automated WCAG checks', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('ps_sw_reload_once', '1'));
  await page.goto(`${BASE}/?browser-test=v170`, { waitUntil: 'domcontentloaded' });
  const shell = page.locator('.psa-split-auth');
  await expect(shell).toBeVisible();
  await expect(page.locator('.psa-split-word')).toContainText('PRIVSPACA');
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await expect(page.getByLabel('Username or email')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Password' })).toBeVisible();

  const loginTab = page.getByRole('tab', { name: 'Log in' });
  await loginTab.focus();
  await page.keyboard.press('ArrowRight');
  const signupTab = page.getByRole('tab', { name: 'Create account' });
  await expect(signupTab).toBeFocused();
  await expect(signupTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'Create account' })).toBeVisible();

  await shell.getByRole('textbox', { name: 'Display name' }).fill('Browser Test');
  await shell.getByRole('textbox', { name: 'Username' }).fill('browser_test');
  await shell.getByRole('textbox', { name: 'Email' }).fill('browser@example.test');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('2 / 2')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Password' })).toBeVisible();
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByText('1 / 2')).toBeVisible();

  // Analyze the current visible signup panel; hidden legacy/app surfaces are
  // intentionally ignored by Axe because they are not in the accessibility tree.
  const results = await new AxeBuilder({ page })
    .include('.psa-split-auth')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
});

test('v170 service worker serves the auth shell offline', async ({ page, context }) => {
  await page.goto(`${BASE}/?pwa-test=v170`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.psa-split-auth')).toBeVisible();
  await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) throw new Error('service worker unsupported');
    await navigator.serviceWorker.ready;
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('.psa-split-auth')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
});
