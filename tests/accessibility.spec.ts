import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('core pages, dialog and planning tabs pass automated accessibility and keyboard checks', async ({ page }) => {
  await page.goto('/');
  async function check(label: string) {
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(result.violations, label).toEqual([]);
  }
  await check('Login');
  await page.getByRole('button', { name: 'Try the free demo' }).click();
  await expect(page.locator('.insights-hero')).toBeVisible();
  for (const name of ['Overview', 'Transactions', 'Import & Analyze', 'Budgets', 'Plan ahead', 'Reports', 'How it works']) {
    await page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
    await check(name);
  }
  await page.getByRole('navigation').getByRole('button', { name: 'Import & Analyze', exact: true }).click();
  await page.getByRole('button', { name: 'Load fictional sample' }).click();
  await page.getByRole('button', { name: 'Build transaction preview' }).click();
  await check('Import preview');
  await page.getByRole('button', { name: 'Add transaction', exact: true }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await check('Transaction dialog');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Add transaction', exact: true }).first()).toBeFocused();
  await page.getByRole('navigation').getByRole('button', { name: 'Plan ahead', exact: true }).click();
  await page.getByRole('tab', { name: 'Allowance', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Upcoming expenses', exact: true })).toBeFocused();
  await expect(page.getByLabel('Expense title')).toBeVisible();
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: 'Savings goals', exact: true })).toBeFocused();
  await expect(page.getByLabel('Goal name')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await check('Mobile savings goals');
});
