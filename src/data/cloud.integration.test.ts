import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { confirmPasswordReset, createUserWithEmailAndPassword, getIdToken, sendPasswordResetEmail, signInWithEmailAndPassword, signOut, updateProfile } from 'firebase/auth';
import { collection, doc, getDoc, getDocs, terminate } from 'firebase/firestore';
import { getMonthlyTrend, todayISO } from '../domain/engine';
import { auth, database, usingEmulators } from './firebase';
import { CloudWriter, loadCloudSummaries, readCloudPage } from './cloud';
import { SpendSmartStore } from './store';

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST);
const waitFor = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 150; attempt++) { if (condition()) return; await new Promise((resolve) => setTimeout(resolve, 50)); }
  throw new Error('Expected cloud state did not arrive.');
};
const register = async () => {
  if (!auth || !database || !usingEmulators) throw new Error('This suite requires local Firebase emulators only.');
  return createUserWithEmailAndPassword(auth, `${crypto.randomUUID()}@example.test`, 'Student123!');
};

describe.skipIf(!enabled)('real local Firebase Auth and cloud adapter integration', () => {
  beforeEach(async () => {
    if (!auth || !database || !usingEmulators || auth.app.options.projectId !== 'demo-spendsmart') throw new Error('Refusing to test outside demo-spendsmart emulators.');
    await signOut(auth);
    const responses = await Promise.all([
      fetch('http://127.0.0.1:9099/emulator/v1/projects/demo-spendsmart/accounts', { method: 'DELETE' }),
      fetch('http://127.0.0.1:8080/emulator/v1/projects/demo-spendsmart/databases/(default)/documents', { method: 'DELETE' }),
    ]);
    responses.forEach((response) => expect(response.ok).toBe(true));
  });
  afterAll(async () => { vi.unstubAllGlobals(); if (auth) await signOut(auth); if (database) await terminate(database); });

  it('registers, updates profile, logs out, rejects wrong password and logs in with a real SDK token', async () => {
    const result = await register();
    await updateProfile(result.user, { displayName: 'Cloud student' });
    expect(result.user.displayName).toBe('Cloud student');
    const email = result.user.email!, uid = result.user.uid;
    await signOut(auth!); expect(auth!.currentUser).toBeNull();
    await expect(signInWithEmailAndPassword(auth!, email, 'Incorrect123!')).rejects.toThrow();
    const login = await signInWithEmailAndPassword(auth!, email, 'Student123!');
    expect(login.user.uid).toBe(uid); expect((await getIdToken(login.user, true)).length).toBeGreaterThan(20);
  });

  it('clears the private ledger when an expired session cannot be refreshed', async () => {
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal('navigator', { onLine: true });
    const store = new SpendSmartStore();
    store.connect();
    try {
      const account = await register();
      await waitFor(() => store.getSnapshot().ready && store.getSnapshot().user?.uid === account.user.uid);
      await store.addTransaction({ type: 'income', amountPaise: 100000, category: 'Allowance', date: todayISO(), note: 'Private funding' }, 'expired-session-funding');
      await waitFor(() => store.getSnapshot().transactions.length === 1);
      await waitFor(() => store.getSnapshot().ledgerBalancePaise === 100000);
      // Invalidate the account in the local emulator, then let the SDK refresh an expired token.
      // No remote Firebase project or real user's account is involved.
      const removal = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:delete', {
        method: 'POST', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
        body: JSON.stringify({ localId: account.user.uid }),
      });
      expect(removal.ok).toBe(true);
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 60 * 60 * 1000);
      try { await store.refreshCloud(); }
      finally { clock.mockRestore(); }
      expect(store.getSnapshot().mode, store.getSnapshot().error ?? 'No cloud error was reported').toBe('signed-out');
      await waitFor(() => store.getSnapshot().user === null);
      expect(store.getSnapshot().mode).toBe('signed-out');
      expect(store.getSnapshot().transactions).toEqual([]);
      await expect(store.addTransaction({ type: 'expense', amountPaise: 100, category: 'Food', date: todayISO(), note: 'Must not save' }, 'expired-write')).rejects.toThrow('sign in');
    } finally { store.disconnect(); }
  });

  it('creates idempotent transactions and preserves exact totals outside the selected month', async () => {
    const result = await register(); const writer = new CloudWriter(database!, result.user.uid);
    const today = todayISO(), old = `${Number(today.slice(0, 4)) - 1}-01-05`;
    const input = { type: 'expense' as const, amountPaise: 12550, category: 'Food', date: today, note: 'Cloud lunch' };
    await Promise.all([writer.addTransaction(input, 'same-operation'), writer.addTransaction(input, 'same-operation')]);
    await writer.addTransaction({ type: 'income', amountPaise: 1000000, category: 'Allowance', date: old, note: 'Old allowance' }, 'old-income');
    const records = await getDocs(collection(database!, 'users', result.user.uid, 'transactions'));
    expect(records.size).toBe(2);
    const summaries = await loadCloudSummaries(database!, result.user.uid, today);
    expect(summaries.balance).toBe(987450);
    expect(summaries.trend.find((month) => month.monthKey === today.slice(0, 7))?.expensePaise).toBe(12550);
    await readCloudPage(database!, result.user.uid, today.slice(0, 7));
    await writer.deleteTransaction('same-operation');
    await expect(writer.updateTransaction('same-operation', input)).rejects.toThrow('was deleted');
    expect((await getDoc(doc(database!, 'users', result.user.uid, 'transactions', 'same-operation'))).exists()).toBe(false);
  });

  it('resets a password through the emulator outbox without sending a real email', async () => {
    const result = await register(); const email = result.user.email!;
    await signOut(auth!); await sendPasswordResetEmail(auth!, email);
    const outbox = await fetch('http://127.0.0.1:9099/emulator/v1/projects/demo-spendsmart/oobCodes');
    const data = await outbox.json() as { oobCodes: { email: string; oobCode: string; requestType: string }[] };
    const reset = data.oobCodes.find((item) => item.email === email && item.requestType === 'PASSWORD_RESET');
    expect(reset).toBeDefined();
    await confirmPasswordReset(auth!, reset!.oobCode, 'UpdatedStudent123!');
    await expect(signInWithEmailAndPassword(auth!, email, 'Student123!')).rejects.toThrow();
    expect((await signInWithEmailAndPassword(auth!, email, 'UpdatedStudent123!')).user.uid).toBe(result.user.uid);
  });

  it('records/retries/edits/deletes a planned payment atomically and rejects conversion to income', async () => {
    const result = await register(); const writer = new CloudWriter(database!, result.user.uid);
    const id = 'planned-cloud', date = todayISO();
    await writer.savePlannedExpense({ id, title: 'Printing bill', amountPaise: 30000, category: 'Education', dueDate: date, status: 'planned', createdAt: Date.now() });
    await Promise.all([writer.recordPlannedExpense(id, date), writer.recordPlannedExpense(id, date)]);
    const paymentId = `plan_${id}`;
    expect((await getDocs(collection(database!, 'users', result.user.uid, 'transactions'))).size).toBe(1);
    await expect(writer.updateTransaction(paymentId, { type: 'income', amountPaise: 30000, category: 'Allowance', date, note: '' })).rejects.toThrow('must remain an expense');
    await writer.updateTransaction(paymentId, { type: 'expense', amountPaise: 40000, category: 'Education', date, note: 'Actual printing bill' });
    expect((await getDoc(doc(database!, 'users', result.user.uid, 'plannedExpenses', id))).data()?.amountPaise).toBe(40000);
    await writer.deleteTransaction(paymentId);
    const reopened = (await getDoc(doc(database!, 'users', result.user.uid, 'plannedExpenses', id))).data();
    expect(reopened?.status).toBe('planned'); expect(reopened?.transactionId).toBeUndefined();
  });

  it('clears previous account records and rejects offline writes before they start', async () => {
    vi.stubGlobal('window', new EventTarget());
    const local = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => local.get(key) ?? null, setItem: (key: string, value: string) => local.set(key, value), removeItem: (key: string) => local.delete(key) });
    vi.stubGlobal('navigator', { onLine: true });
    const store = new SpendSmartStore(); store.connect();
    try {
      const first = await register(); await waitFor(() => store.getSnapshot().ready && store.getSnapshot().user?.uid === first.user.uid);
      await store.addTransaction({ type: 'expense', amountPaise: 10000, category: 'Food', date: todayISO(), note: 'Account A' }, 'account-a');
      await waitFor(() => store.getSnapshot().transactions.length === 1);
      await store.signOut(); await waitFor(() => store.getSnapshot().user === null);
      expect(store.getSnapshot().transactions).toEqual([]);
      const second = await register(); await waitFor(() => store.getSnapshot().ready && store.getSnapshot().user?.uid === second.user.uid);
      expect(store.getSnapshot().transactions).toEqual([]);
      store.disconnect(); store.connect();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await new CloudWriter(database!, second.user.uid).addTransaction({ type: 'income', amountPaise: 100000, category: 'Allowance', date: todayISO(), note: 'After reconnect' }, 'reconnected');
      await waitFor(() => store.getSnapshot().transactions.some((item) => item.id === 'reconnected'));
      const rules = await readFile(new URL('../../firestore.rules', import.meta.url), 'utf8');
      const denied = await initializeTestEnvironment({ projectId: 'demo-spendsmart', firestore: { host: '127.0.0.1', port: 8080,
        rules: "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if false; } } }" } });
      try {
        const selectedMonth = getMonthlyTrend([], todayISO())[4].monthKey;
        store.setSelectedMonth(selectedMonth);
        await waitFor(() => store.getSnapshot().syncStatus === 'error');
        expect(store.getSnapshot().ledgerBalancePaise).toBeNull();
        const restored = await initializeTestEnvironment({ projectId: 'demo-spendsmart', firestore: { host: '127.0.0.1', port: 8080, rules } });
        await restored.cleanup();
        await store.refreshCloud();
        await waitFor(() => store.getSnapshot().ready && store.getSnapshot().ledgerBalancePaise === 100000);
        expect(store.getSnapshot().selectedMonth).toBe(selectedMonth);
        expect(store.getSnapshot().user?.uid).toBe(second.user.uid);
      } finally {
        const restored = await initializeTestEnvironment({ projectId: 'demo-spendsmart', firestore: { host: '127.0.0.1', port: 8080, rules } });
        await restored.cleanup(); await denied.cleanup();
      }
      vi.stubGlobal('navigator', { onLine: false });
      await expect(store.addTransaction({ type: 'expense', amountPaise: 10000, category: 'Food', date: todayISO(), note: 'Offline' }, 'offline')).rejects.toThrow('offline');
      expect(store.getSnapshot().syncStatus).toBe('offline');
      expect((await getDocs(collection(database!, 'users', second.user.uid, 'transactions'))).size).toBe(1);
    } finally { store.disconnect(); vi.unstubAllGlobals(); }
  });
});
