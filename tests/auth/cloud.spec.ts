import { test, expect } from '@playwright/test';

test.beforeEach(async ({ request }) => {
  if (!process.env.FIREBASE_AUTH_EMULATOR_HOST || !process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Run through npm run test:auth with local emulators.');
  expect((await request.delete('http://127.0.0.1:9099/emulator/v1/projects/demo-spendsmart/accounts')).ok()).toBe(true);
  expect((await request.delete('http://127.0.0.1:8080/emulator/v1/projects/demo-spendsmart/databases/(default)/documents')).ok()).toBe(true);
});

test('real cloud registration, reload persistence, logout and login', async ({ page }) => {
  const email = `${crypto.randomUUID()}@example.test`;
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByLabel('Your name').fill('Cloud student');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('Student123!');
  await page.getByRole('button', { name: 'Create my account' }).click();
  await expect(page.getByText('Cloud student', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Cloud student', { exact: true })).toBeVisible();
  await page.getByRole('navigation').getByRole('button', { name: 'Budgets', exact: true }).click();
  await page.getByLabel('Selected month').fill('2026-09');
  await expect(page.getByLabel('Monthly spending limit (₹)')).toBeVisible();
  await expect(page.getByLabel('Selected month')).toHaveValue('2026-09');
  await expect(page.getByRole('navigation').getByRole('button', { name: 'Budgets', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.getByRole('button', { name: 'Log out', exact: true }).first().click();
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('WrongPassword!');
  await page.getByRole('button', { name: 'Log in', exact: true }).last().click();
  await expect(page.getByRole('alert')).toContainText('incorrect');
  await page.getByLabel('Password', { exact: true }).fill('Student123!');
  await page.getByRole('button', { name: 'Log in', exact: true }).last().click();
  await expect(page.getByText('Cloud student', { exact: true })).toBeVisible();
});

test('offline save is rejected and the transaction form remains usable after reconnecting', async ({ page, context }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByLabel('Your name').fill('Offline student');
  await page.getByLabel('Email address').fill(`${crypto.randomUUID()}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill('Student123!');
  await page.getByRole('button', { name: 'Create my account' }).click();
  await expect(page.getByText('Offline student', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add transaction', exact: true }).first().click();
  await page.getByLabel('Amount (₹)', { exact: true }).fill('125.50');
  await page.getByLabel('Note optional').fill('Offline test lunch');
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Save transaction', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('offline');
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
  await context.setOffline(false);
  await page.getByRole('button', { name: 'Save transaction', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
});

test('unreachable cloud write releases the form and retry keeps a single transaction', async ({ page, context, request }) => {
  const email = `${crypto.randomUUID()}@example.test`;
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByLabel('Your name').fill('Network student');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('Student123!');
  await page.getByRole('button', { name: 'Create my account' }).click();
  await expect(page.getByText('Network student', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add transaction', exact: true }).first().click();
  await page.getByLabel('Amount (₹)', { exact: true }).fill('125.50');
  await page.getByLabel('Note optional').fill('Network test lunch');
  await context.route('http://127.0.0.1:8080/**', (route) => route.abort());
  await page.getByRole('button', { name: 'Save transaction', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled({ timeout: 20000 });
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText(/not confirmed|could not be reached/);
  await context.unroute('http://127.0.0.1:8080/**');
  await page.getByRole('button', { name: 'Save transaction', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 20000 });
  const login = await request.post('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-api-key', {
    data: { email, password: 'Student123!', returnSecureToken: true },
  });
  const accountData = await login.json();
  const uid = accountData.localId as string;
  const records = await request.get(`http://127.0.0.1:8080/v1/projects/demo-spendsmart/databases/(default)/documents/users/${uid}/transactions`, {
    headers: { Authorization: `Bearer ${accountData.idToken}` },
  });
  const recordData = await records.json();
  expect(recordData.documents).toHaveLength(1);
});
