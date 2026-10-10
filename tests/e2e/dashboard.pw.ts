import { expect, test } from '@playwright/test';
import { mockSources, WALLET } from './fixtures';

test('narrow navigation stays contained and every view remains reachable', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await mockSources(page);
  await page.goto('/');
  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  // Wider fallback metrics must scroll the navigation itself, never the page.
  await page.addStyleTag({ content: '.header-inner nav button { font-family: monospace; font-size: 14px; }' });
  expect(await navigation.evaluate(element => element.scrollWidth)).toBeGreaterThan(await navigation.evaluate(element => element.clientWidth));
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await navigation.getByRole('button', { name: /^Following/ }).click();
  await expect(page.getByText('No followed wallets')).toBeVisible();
  await expect(navigation.getByRole('button', { name: /^Following/ })).toBeInViewport();
  await navigation.getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Protocol overview' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

test('wallet details show exact deposits, partial coverage and older cashflows', async ({ page }) => {
  await mockSources(page);
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Protocol overview' })).toContainText('$66.32M');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  const walletLink = page.getByRole('button', { name: /^Aoi / });
  await walletLink.click();
  await expect(page).toHaveURL(new RegExp(`wallet=${WALLET}`));
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('region', { name: 'Lifetime credited deposits' })).toContainText('$10,779.00');
  await expect(dialog.getByText('Partial history', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Known gaps are left unconnected.', { exact: false })).toBeVisible();
  await dialog.getByRole('button', { name: 'Load older activity' }).click();
  await expect(dialog.getByText('Credited deposit', { exact: true })).toHaveCount(2);
  await expect(dialog.getByRole('button', { name: 'Load older activity' })).toHaveCount(0);
  await dialog.getByRole('tab', { name: /Closed trades/ }).click();
  await expect(dialog.getByText('No closed trades to show yet.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page).not.toHaveURL(/wallet=/);
  await expect(walletLink).toBeFocused();
});

test('direct wallet links open accessibly and preserve unknown balances', async ({ page }) => {
  await mockSources(page, { missingWalletSnapshot: true });
  await page.goto(`/?wallet=${WALLET}`);
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Some sources are unavailable.', { exact: false })).toBeVisible();
  const deposits = dialog.getByRole('region', { name: 'Lifetime credited deposits' });
  await expect(deposits).toContainText('—');
  await expect(deposits).not.toContainText('$0.00');
  await expect(dialog.getByRole('button', { name: 'Close wallet details' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Refresh wallet details' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Close wallet details' })).toBeFocused();
});

test('following persists locally and directory paging reaches another wallet', async ({ page }) => {
  await page.clock.install();
  await mockSources(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Follow Aoi', exact: true }).click();
  await page.getByRole('button', { name: 'Next page' }).click();
  await page.clock.fastForward(1_000);
  await expect(page.getByRole('button', { name: /^Yuki / })).toBeVisible();
  await page.reload();
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: /^Following/ }).click();
  await expect(page.getByRole('button', { name: /^Aoi / })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Unfollow Aoi', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Unfollow Aoi', exact: true }).click();
  await expect(page.getByText('No followed wallets')).toBeVisible();
});

test('stale data and wallet failures are explicit without fabricated activity', async ({ page }) => {
  await mockSources(page, { stale: true, walletFailure: true });
  await page.goto('/');
  await expect(page.getByText('Last known snapshot', { exact: false })).toBeVisible();
  await expect(page.getByText('No recent trades', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Aoi / }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('alert')).toContainText('This wallet could not be refreshed.');
  await expect(dialog.getByRole('button', { name: /Try again/ })).toBeEnabled();
  await expect(dialog.getByRole('region', { name: 'Lifetime credited deposits' })).toHaveCount(0);
});

test('wallet refresh preserves loaded history and stops when closed', async ({ page }) => {
  await page.clock.install();
  await mockSources(page);
  let walletReads = 0;
  page.on('request', request => {
    if (new URL(request.url()).pathname === `/api/wallets/${WALLET}`) walletReads++;
  });
  await page.goto(`/?wallet=${WALLET}`);
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Load older activity' }).click();
  await expect(dialog.getByText('Credited deposit', { exact: true })).toHaveCount(2);
  const readsBeforeRefresh = walletReads;
  await page.clock.fastForward(15_001);
  await expect.poll(() => walletReads).toBeGreaterThan(readsBeforeRefresh);
  await expect(dialog.getByText('Credited deposit', { exact: true })).toHaveCount(2);
  await expect(dialog.getByRole('button', { name: 'Load older activity' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close wallet details' }).click();
  await expect(dialog).toHaveCount(0);
  const readsAfterClose = walletReads;
  await page.clock.fastForward(45_001);
  expect(walletReads).toBe(readsAfterClose);
});

test('data information stays in view, traps keyboard focus and restores its trigger', async ({ page }) => {
  await mockSources(page);
  await page.goto('/');
  const trigger = page.getByRole('button', { name: 'View data status' });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Data & sources' });
  const close = dialog.getByRole('button', { name: 'Close data information' });
  await expect(dialog).toBeInViewport({ ratio: 1 });
  await expect(close).toBeInViewport({ ratio: 1 });
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
