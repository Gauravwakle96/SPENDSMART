import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { Transaction } from '../src/domain/types';

const baseTransactions: Transaction[] = [
  { id: 'income', type: 'income', amountPaise: 1000000, category: 'Allowance', date: '2026-10-01', note: 'Actual allowance', createdAt: 1 },
  { id: 'expense', type: 'expense', amountPaise: 300000, category: 'Food', date: '2026-10-20', note: 'Food spending', createdAt: 2 },
];

async function seed(page: Page, transactions = baseTransactions) {
  await page.clock.setFixedTime(new Date('2026-10-20T12:00:00+05:30'));
  await page.addInitScript(records => {
    if (localStorage.getItem('spendsmart.demo.data.v1')) return;
    localStorage.setItem('spendsmart.demo.session.v1', 'active');
    localStorage.setItem('spendsmart.demo.data.v1', JSON.stringify({ version: 2, transactions: records,
      budgets: [{ monthKey: '2026-10', limitPaise: 800000, categoryLimits: { Food: 400000 } }],
      planning: [], plannedExpenses: [], goals: [] }));
  }, transactions);
  await page.goto('/');
  await expect(page.locator('.insights-hero')).toBeVisible();
}

const navigate = (page: Page, name: string) => page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
const localData = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('spendsmart.demo.data.v1')!));

test('allowance, atomic planned payments, goals and pure simulations work together', async ({ page }) => {
  await seed(page);
  await expect(page.locator('.insights-hero-money')).toContainText('₹416.66');
  await navigate(page, 'Plan ahead');
  await page.getByLabel('Allowance / family support (₹)').fill('15000');
  await page.getByRole('button', { name: 'Save income plan' }).click();
  await expect.poll(async () => (await localData(page)).planning[0]?.expectedIncome.Allowance).toBe(1500000);
  await page.getByRole('tab', { name: 'Upcoming expenses' }).click();
  await page.getByLabel('Expense title').fill('Study supplies');
  await page.getByLabel('Planned amount (₹)').fill('600');
  await page.getByLabel('Due date').fill('2026-10-25');
  await page.getByRole('button', { name: 'Save planned expense' }).click();
  let item = page.locator('.planning-list > li').filter({ hasText: 'Study supplies' });
  await expect(item).toBeVisible();
  await navigate(page, 'Overview');
  await expect(page.locator('.insights-hero-money')).toContainText('₹366.66');
  await navigate(page, 'Plan ahead');
  await page.getByRole('tab', { name: 'Upcoming expenses' }).click();
  item = page.locator('.planning-list > li').filter({ hasText: 'Study supplies' });
  page.once('dialog', dialog => dialog.accept());
  await item.getByRole('button', { name: 'Record payment' }).click();
  await expect(item).toContainText('Payment recorded');
  await expect.poll(async () => (await localData(page)).transactions.filter((record: Transaction) => record.note === 'Study supplies').length).toBe(1);
  await navigate(page, 'Overview');
  await expect(page.locator('.insights-hero-money')).toContainText('₹366.66');
  await navigate(page, 'Transactions');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Delete Study supplies', exact: true }).click();
  await expect.poll(async () => (await localData(page)).plannedExpenses[0]?.status).toBe('planned');
  await navigate(page, 'Plan ahead');
  await page.getByRole('tab', { name: 'Savings goals' }).click();
  await page.getByLabel('Goal name').fill('Course fund');
  await page.getByLabel('Target amount (₹)').fill('8000');
  await page.getByLabel('Target date').fill('2026-12-31');
  await page.getByLabel('Reserve from recorded cash (₹)').fill('6000');
  await page.getByRole('button', { name: 'Save savings goal' }).click();
  await expect(page.locator('.planning-list > li').filter({ hasText: 'Course fund' })).toContainText('75% funded');
  await navigate(page, 'Overview');
  await expect(page.locator('.insights-hero-money')).toContainText('₹33.33');
  const before = await localData(page);
  await navigate(page, 'Reports');
  await page.getByLabel('Reduce recorded spending by (₹)').fill('500');
  await page.getByRole('button', { name: 'Compare scenario' }).click();
  await expect(page.locator('.insights-scenario-result')).toContainText('Hypothetical reduction: ₹500');
  expect(await localData(page)).toEqual(before);
  await page.reload();
  await navigate(page, 'Plan ahead');
  await page.getByRole('tab', { name: 'Savings goals' }).click();
  await expect(page.locator('.planning-list')).toContainText('Course fund');
});

test('date and category filters, amount sort, pagination and CSV all use the same records', async ({ page }) => {
  const records: Transaction[] = Array.from({ length: 25 }, (_, i) => ({ id: `p-${i}`, type: 'expense', amountPaise: (i + 1) * 100, category: 'Food', date: '2026-10-10', note: `Purchase ${String(i + 1).padStart(2, '0')}`, createdAt: i + 1 }));
  records.push({ id: 'outside', type: 'expense', amountPaise: 500000, category: 'Travel', date: '2026-10-20', note: 'Outside the filter', createdAt: 30 });
  await seed(page, records);
  await navigate(page, 'Transactions');
  await page.getByLabel('From date').fill('2026-10-10');
  await page.getByLabel('To date').fill('2026-10-10');
  await page.getByLabel('Filter category').selectOption('Food');
  await page.getByLabel('Sort transactions').selectOption('amount-desc');
  await expect(page.locator('.ledger-table tbody tr')).toHaveCount(20);
  await expect(page.locator('.ledger-table tbody tr').first()).toContainText('Purchase 25');
  await page.getByRole('button', { name: 'Next transaction page' }).click();
  await expect(page.locator('.ledger-table tbody tr')).toHaveCount(5);
  await expect(page.locator('.ledger-table tbody tr').last()).toContainText('Purchase 01');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export filtered CSV' }).click();
  const download = await downloadPromise;
  const csv = await readFile((await download.path())!, 'utf8');
  expect(csv).toContain('Purchase 25'); expect(csv).toContain('Purchase 01'); expect(csv).not.toContain('Outside the filter');
  await page.getByLabel('Filter transaction type').selectOption('income');
  await expect(page.getByRole('heading', { name: 'No transactions in this view.' })).toBeVisible();
});

test('repeated submit events produce one ledger record and keyboard dismissal works', async ({ page }) => {
  await seed(page);
  await page.getByRole('button', { name: 'Add transaction', exact: true }).first().click();
  await page.getByRole('dialog').getByLabel('Amount (₹)').fill('125');
  await page.getByRole('dialog').getByLabel('Note').fill('One submission');
  await page.locator('dialog form').evaluate(form => { (form as HTMLFormElement).requestSubmit(); (form as HTMLFormElement).requestSubmit(); });
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect.poll(async () => (await localData(page)).transactions.filter((item: Transaction) => item.note === 'One submission').length).toBe(1);
  await page.getByRole('button', { name: 'Add transaction', exact: true }).first().click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
});

test('blocked local persistence is labeled session-only and the demo stays usable', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException('Storage blocked', 'QuotaExceededError'); }; });
  await page.getByRole('button', { name: 'Add transaction', exact: true }).first().click();
  await page.getByRole('dialog').getByLabel('Amount (₹)').fill('25');
  await page.getByRole('dialog').getByLabel('Note').fill('Session-only expense');
  await page.getByRole('button', { name: 'Save transaction', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByText('Demo · session only', { exact: true })).toBeVisible();
  await navigate(page, 'Transactions');
  await expect(page.getByRole('row').filter({ hasText: 'Session-only expense' })).toBeVisible();
});

test('no expenses produce a useful empty forecast rather than a zero-spending claim', async ({ page }) => {
  await seed(page, []);
  await expect(page.getByRole('heading', { name: 'No expense records yet' })).toBeVisible();
  await expect(page.locator('.insights-forecast-band')).toContainText('Unavailable');
  await expect(page.locator('.insights-hero-money')).toContainText('₹0');
  await page.getByLabel('Selected month').fill('2026-11');
  await expect(page.getByRole('heading', { name: 'Plan the month ahead' })).toBeVisible();
  await expect(page.locator('.insights-daily-explanation')).toHaveCount(0);
});

test('mobile planning forms and report simulator fit within the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page);
  await navigate(page, 'Plan ahead');
  for (const name of ['Allowance', 'Upcoming expenses', 'Savings goals']) {
    await page.getByRole('tab', { name, exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  }
  await navigate(page, 'Reports');
  await expect(page.getByRole('button', { name: 'Compare scenario' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});
