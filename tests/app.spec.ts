import { expect, test, type Page } from '@playwright/test';

async function demo(page: Page) {
  await page.clock.setFixedTime(new Date('2026-10-24T12:00:00+05:30'));
  await page.goto('/');
  await page.getByRole('button', { name: 'Try the free demo' }).click();
  await expect(page.getByText('Demo · saved on this device')).toBeVisible();
  await expect(page.locator('.insights-hero')).toBeVisible();
}

test('demo transaction CRUD and persistence', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await demo(page);
  await page.screenshot({ path: 'test-results/desktop-overview.png', fullPage: true });
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Transactions', exact: true })
    .click();
  await page.getByRole('button', { name: 'Add transaction', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Amount (₹)').fill('250.75');
  await dialog.getByLabel('Note', { exact: false }).fill('Browser test lunch');
  await dialog.getByRole('button', { name: 'Save transaction' }).click();
  await expect(dialog).not.toBeVisible();
  let row = page.getByRole('row').filter({ hasText: 'Browser test lunch' });
  await expect(row).toContainText('₹250.75');
  await page.reload();
  await page
    .getByRole('navigation')
    .getByRole('button', { name: 'Transactions', exact: true })
    .click();
  row = page.getByRole('row').filter({ hasText: 'Browser test lunch' });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Edit Browser test lunch' }).click();
  await page.getByRole('dialog').getByLabel('Amount (₹)').fill('300.25');
  await page.getByRole('dialog').getByRole('button', { name: 'Save transaction' }).click();
  await expect(row).toContainText('₹300.25');
  page.once('dialog', (dialog) => dialog.accept());
  await row.getByRole('button', { name: 'Delete Browser test lunch' }).click();
  await expect(row).toHaveCount(0);
  await expect(errors).toEqual([]);
});

test('PDF example shows exact forecast, allowance and explainable alert', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-04-20T12:00:00+05:30'));
  await page.addInitScript(() => {
    localStorage.setItem('spendsmart.demo.session.v1', 'active');
    localStorage.setItem(
      'spendsmart.demo.data.v1',
      JSON.stringify({
        version: 1,
        transactions: [
          { id: 'funding', type: 'income', amountPaise: 1000000, category: 'Allowance', date: '2026-04-01', note: 'Actual cash funding', createdAt: 1 },
          {
            id: 'example-expense',
            type: 'expense',
            amountPaise: 560000,
            category: 'Food',
            date: '2026-04-20',
            note: 'PDF example',
            createdAt: 100,
          },
        ],
        budgets: [{ monthKey: '2026-04', limitPaise: 800000, categoryLimits: {} }],
      }),
    );
  });
  await page.goto('/');
  await expect(page.locator('.insights-hero-money')).toContainText('₹218.18');
  await page.getByText('How today’s guidance is calculated').click();
  await expect(page.locator('.insights-daily-explanation')).toContainText('₹240');
  const alert = page.locator('[data-reason-code="PACE_RISK"]');
  await expect(alert).toContainText('₹8,400');
  await alert.getByText('Show the calculation').click();
  await expect(alert).toContainText('20 elapsed days');
  await expect(alert).toContainText('30 days');
  await page.getByRole('navigation').getByRole('button', { name: 'Budgets', exact: true }).click();
  await page.getByLabel('Monthly spending limit (₹)').fill('10000');
  await page.getByRole('button', { name: 'Save budget' }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(page.locator('.insights-hero-money')).toContainText('₹400');
  await expect(page.locator('[data-reason-code="PACE_RISK"]')).toHaveCount(0);
});

test('reports export selected month and historical month removes daily advice', async ({
  page,
}) => {
  await demo(page);
  await page.getByRole('navigation').getByRole('button', { name: 'Reports', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /^Export .* CSV$/ }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^spendsmart-\d{4}-\d{2}\.csv$/);
  await page.getByLabel('Selected month').fill('2026-04');
  await page.getByRole('navigation').getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(page.locator('.insights-daily-explanation')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'April 2026 snapshot' })).toBeVisible();
});

test('mobile layout supports capture and navigation without horizontal overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await demo(page);
  const hasOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(hasOverflow).toBe(false);
  await page.screenshot({ path: 'test-results/mobile-overview.png', fullPage: true });
  await page.getByRole('button', { name: 'Add transaction', exact: true }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByLabel('Amount (₹)').fill('0');
  await page.getByRole('dialog').getByRole('button', { name: 'Save transaction' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('positive');
  await page.getByRole('button', { name: 'Close transaction form' }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'Budgets', exact: true }).click();
  await expect(page.getByLabel('Monthly spending limit (₹)')).toBeVisible();
  await page.screenshot({ path: 'test-results/mobile-budgets.png', fullPage: true });
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Try the free demo' })).toBeVisible();
});
