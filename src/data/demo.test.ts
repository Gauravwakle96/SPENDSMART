import { describe, expect, it } from 'vitest';
import { validateBudget, validateTransaction } from '../domain/engine';
import { createDemoData, readBudget, readPlannedExpense, readTransaction, recoverDemoData, serializeDemoData } from './demo';

describe('local demo data integrity', () => {
  it.each(['2026-10-01', '2026-10-24', '2026-10-31', '2028-02-29', '2026-01-01'])('creates valid repeatable records on %s', (asOf) => {
    const data = createDemoData(asOf);
    expect(createDemoData(asOf)).toEqual(data);
    expect(data.budgets).toHaveLength(6);
    expect(new Set(data.transactions.map((transaction) => transaction.id)).size).toBe(data.transactions.length);
    data.transactions.forEach((transaction) => {
      expect(() => validateTransaction(transaction, asOf)).not.toThrow();
      expect(transaction.date <= asOf).toBe(true);
    });
    data.budgets.forEach((budget) => expect(() => validateBudget(budget)).not.toThrow());
  });

  it('preserves complete valid records through serialization and recovery', () => {
    const data = createDemoData('2026-10-24');
    expect(recoverDemoData(serializeDemoData(data), '2026-10-24')).toEqual({ ...data, warning: null });
  });

  it('recovers valid records while skipping malformed, duplicate and future entries', () => {
    const data = createDemoData('2026-10-24');
    const valid = data.transactions[0];
    const recovered = recoverDemoData(JSON.stringify({
      version: 1,
      transactions: [valid, valid, { ...valid, id: 'bad-amount', amountPaise: 1.5 }, { ...valid, id: 'future', date: '2026-11-01' }, null],
      budgets: [data.budgets[0], { ...data.budgets[0], monthKey: 'not-a-month' }],
    }), '2026-10-24');
    expect(recovered.transactions).toEqual([valid]);
    expect(recovered.budgets).toEqual([data.budgets[0]]);
    expect(recovered.warning).toContain('5 invalid saved demo records');
  });

  it.each(['not json', 'null', '[]', '{"version":2,"transactions":[],"budgets":[]}'])('handles unreadable persisted data without crashing: %s', (raw) => {
    const recovered = recoverDemoData(raw, '2026-10-24');
    expect(recovered.transactions).toEqual([]);
    expect(recovered.budgets).toEqual([]);
    expect(recovered.warning).toContain('could not be read');
  });

  it('rejects malformed timestamps and document IDs', () => {
    const transaction = createDemoData('2026-10-24').transactions[0];
    expect(readTransaction('../another-user', transaction, '2026-10-24')).toBeNull();
    expect(readTransaction(transaction.id, { ...transaction, createdAt: -1 }, '2026-10-24')).toBeNull();
    expect(readTransaction(transaction.id, { ...transaction, createdAt: Infinity }, '2026-10-24')).toBeNull();
  });

  it('rejects budgets whose month does not match the document ID', () => {
    const budget = createDemoData('2026-10-24').budgets[0];
    expect(readBudget('2026-10', budget)).toBeNull();
  });

  it('normalizes stale legacy links on planned items and reopens missing paid transactions', () => {
    const data = createDemoData('2026-10-24');
    const item = data.plannedExpenses[0];
    expect(readPlannedExpense(item.id, { ...item, transactionId: 'stale' })?.transactionId).toBeUndefined();
    const broken = { ...data, plannedExpenses: [{ ...item, status: 'paid' as const, transactionId: 'missing-payment' }] };
    const recovered = recoverDemoData(serializeDemoData(broken), '2026-10-24');
    expect(recovered.plannedExpenses[0].status).toBe('planned');
    expect(recovered.plannedExpenses[0].transactionId).toBeUndefined();
    expect(recovered.warning).not.toBeNull();
  });
});
