import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { todayISO } from '../domain/engine';
import { transactionCoreHash } from '../domain/import-engine';
import type { ImportRecord, PreparedImportTransaction } from '../domain/import-types';
import { createDemoData, DEMO_DATA_KEY, recoverDemoData, serializeDemoData } from './demo';
import { SpendSmartStore } from './store';

let data: Map<string, string>;
beforeEach(() => {
  data = new Map();
  vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) });
  let queue = Promise.resolve();
  vi.stubGlobal('navigator', { onLine: true, locks: { request: (_name: string, callback: () => Promise<void>) => { queue = queue.then(callback, callback); return queue; } } });
});
afterEach(() => vi.unstubAllGlobals());

describe('local data operations', () => {
  const preparedImport = (importId: string, id: string): { record: ImportRecord; entries: PreparedImportTransaction[] } => {
    const base: PreparedImportTransaction['input'] = { type: 'expense', amountPaise: 12345, category: 'Food', date: todayISO(), note: 'Imported lunch',
      currency: 'INR', classification: 'expense', excludedFromAnalysis: false, importId, accountLabel: 'Salary account', accountKey: 'acct_1234567890abcdef',
      sourceFileHash: 'a'.repeat(64), sourceRowNumber: 2, sourceFingerprint: 'b'.repeat(16), merchant: 'imported lunch' };
    const input = { ...base, importOriginalHash: transactionCoreHash(base) };
    const record: ImportRecord = { id: importId, createdAt: Date.now(), filenames: ['statement.csv'], fileHashes: ['a'.repeat(64)],
      accountLabels: ['Salary account'], processedCount: 1, importedCount: 1, skippedCount: 0, flaggedCount: 0, invalidCount: 0,
      status: 'processing', startDate: todayISO(), endDate: todayISO() };
    return { record, entries: [{ id, input }] };
  };
  it('retries the same operation ID without duplicating an expense', async () => {
    const store = new SpendSmartStore(); store.startDemo();
    const input = { type: 'expense' as const, amountPaise: 12550, category: 'Food', date: todayISO(), note: 'Idempotent lunch' };
    await Promise.all([store.addTransaction(input, 'stable-operation'), store.addTransaction(input, 'stable-operation')]);
    expect(store.getSnapshot().transactions.filter((item) => item.id === 'stable-operation')).toHaveLength(1);
    await expect(store.addTransaction({ ...input, amountPaise: 20000 }, 'stable-operation')).rejects.toThrow('already belongs');
  });

  it('serializes two tabs using reload-latest storage updates', async () => {
    const first = new SpendSmartStore(), second = new SpendSmartStore(); first.startDemo(); second.startDemo();
    const input = { type: 'expense' as const, amountPaise: 5000, category: 'Travel', date: todayISO(), note: 'Two tabs' };
    await Promise.all([first.addTransaction(input, 'tab-first'), second.addTransaction(input, 'tab-second')]);
    const recovered = recoverDemoData(data.get(DEMO_DATA_KEY)!);
    expect(recovered.transactions.some((item) => item.id === 'tab-first')).toBe(true);
    expect(recovered.transactions.some((item) => item.id === 'tab-second')).toBe(true);
  });

  it('records a planned bill atomically, retries once, synchronizes edits and reopens on deletion', async () => {
    const store = new SpendSmartStore(); store.startDemo();
    const item = store.getSnapshot().plannedExpenses[0];
    await Promise.all([store.recordPlannedExpense(item.id, todayISO()), store.recordPlannedExpense(item.id, todayISO())]);
    const paymentId = `plan_${item.id}`;
    expect(store.getSnapshot().transactions.filter((transaction) => transaction.id === paymentId)).toHaveLength(1);
    expect(store.getSnapshot().plannedExpenses.find((expense) => expense.id === item.id)?.status).toBe('paid');
    await expect(store.updateTransaction(paymentId, { type: 'income', amountPaise: 50000, category: 'Allowance', date: todayISO(), note: '' })).rejects.toThrow('must remain an expense');
    await store.updateTransaction(paymentId, { type: 'expense', amountPaise: 50000, category: 'Education', date: todayISO(), note: 'Printing paid' });
    expect(store.getSnapshot().plannedExpenses.find((expense) => expense.id === item.id)?.amountPaise).toBe(50000);
    await store.deleteTransaction(paymentId);
    expect(store.getSnapshot().plannedExpenses.find((expense) => expense.id === item.id)?.status).toBe('planned');
    expect(store.getSnapshot().plannedExpenses.find((expense) => expense.id === item.id)?.transactionId).toBeUndefined();
  });

  it('does not resurrect a deleted transaction during a stale edit', async () => {
    const store = new SpendSmartStore(); store.startDemo(); const item = store.getSnapshot().transactions[0];
    await store.deleteTransaction(item.id);
    await expect(store.updateTransaction(item.id, { type: item.type, amountPaise: item.amountPaise, category: item.category, date: item.date, note: item.note })).rejects.toThrow('no longer exists');
  });

  it('migrates v1 without reseeding an existing empty ledger', () => {
    data.set(DEMO_DATA_KEY, JSON.stringify({ version: 1, transactions: [], budgets: [] }));
    const store = new SpendSmartStore(); store.startDemo();
    expect(store.getSnapshot().transactions).toEqual([]); expect(store.getSnapshot().planning).toEqual([]);
    expect(JSON.parse(data.get(DEMO_DATA_KEY)!).version).toBe(3);
  });

  it('retries a complete import safely and rolls back only unchanged imported records', async () => {
    const store = new SpendSmartStore(); store.startDemo();
    const first = preparedImport('import_retry', 'imp_retry_record');
    await Promise.all([store.importTransactions(first.record, first.entries), store.importTransactions(first.record, first.entries)]);
    expect(store.getSnapshot().transactions.filter((item) => item.id === 'imp_retry_record')).toHaveLength(1);
    expect(store.getSnapshot().imports.find((item) => item.id === 'import_retry')?.status).toBe('completed');
    const clean = preparedImport('import_clean', 'imp_clean_record');
    await store.importTransactions(clean.record, clean.entries);
    expect(await store.rollbackImport('import_clean')).toEqual({ deletedCount: 1, conflictCount: 0 });
    expect(store.getSnapshot().transactions.some((item) => item.id === 'imp_clean_record')).toBe(false);
    await store.updateTransaction('imp_retry_record', { type: 'expense', amountPaise: 20000, category: 'Food', date: todayISO(), note: 'Edited imported lunch' });
    expect(await store.rollbackImport('import_retry')).toEqual({ deletedCount: 0, conflictCount: 1 });
    expect(store.getSnapshot().transactions.some((item) => item.id === 'imp_retry_record')).toBe(true);
  });

  it('preserves valid stored data when only storage writes are blocked', async () => {
    const saved = createDemoData(); saved.transactions[0].note = 'Preserve my note';
    data.set(DEMO_DATA_KEY, serializeDemoData(saved));
    vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: () => { throw new Error('Quota'); }, removeItem: () => { throw new Error('Blocked'); } });
    const store = new SpendSmartStore(); store.startDemo();
    expect(store.getSnapshot().transactions.some((item) => item.note === 'Preserve my note')).toBe(true);
    expect(store.getSnapshot().syncStatus).toBe('session-only');
    await store.addTransaction({ type: 'expense', amountPaise: 100, category: 'Other', date: todayISO(), note: 'Session only' }, 'session-only');
    expect(store.getSnapshot().transactions.some((item) => item.id === 'session-only')).toBe(true);
    await store.signOut(); expect(store.getSnapshot().user).toBeNull();
  });

  it('reset replaces demo edits with a deterministic fresh sample only when requested', async () => {
    const store = new SpendSmartStore(); store.startDemo();
    await store.addTransaction({ type: 'expense', amountPaise: 100, category: 'Other', date: todayISO(), note: 'Reset edit' }, 'reset-edit');
    await store.resetDemo(); expect(store.getSnapshot().transactions.some((item) => item.id === 'reset-edit')).toBe(false);
    expect(recoverDemoData(data.get(DEMO_DATA_KEY)!).transactions).toEqual(createDemoData().transactions);
  });
});
