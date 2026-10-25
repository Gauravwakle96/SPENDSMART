import { describe, expect, it } from 'vitest';
import {
  analyzePeriod,
  calendarYear,
  customPeriod,
  detectRecurringPayments,
  detectSpendingAnomalies,
  indianFinancialYear,
  indianFinancialYearFor,
  recommendBudgets,
} from './financial-analysis';
import type { Transaction } from './types';

const record = (id: string, date: string, type: Transaction['type'], amountPaise: number, category = 'Other', note = id,
  extra: Partial<Transaction> = {}): Transaction => ({ id, date, type, amountPaise, category, note, createdAt: 1, ...extra });

describe('financial year aggregation', () => {
  it('uses Indian April-to-March boundaries exactly', () => {
    expect(indianFinancialYearFor('2026-03-31')).toEqual({ start: '2025-04-01', end: '2026-03-31', label: 'FY 2025–26', kind: 'indian-financial-year' });
    expect(indianFinancialYearFor('2026-04-01')).toEqual({ start: '2026-04-01', end: '2027-03-31', label: 'FY 2026–27', kind: 'indian-financial-year' });
    const transactions = [
      record('before', '2025-03-31', 'expense', 99900, 'Food'),
      record('start', '2025-04-01', 'income', 100000, 'Salary'),
      record('end', '2026-03-31', 'expense', 40000, 'Food'),
      record('after', '2026-04-01', 'expense', 99900, 'Food'),
    ];
    const analysis = analyzePeriod(transactions, indianFinancialYear(2025));
    expect(analysis.totalIncomePaise).toBe(100000);
    expect(analysis.totalExpensePaise).toBe(40000);
    expect(analysis.transactionCount).toBe(2);
  });

  it('handles leap-day custom periods and separates refunds, net expense, and cash flow', () => {
    const analysis = analyzePeriod([
      record('income', '2024-02-28', 'income', 100000, 'Salary'),
      record('expense', '2024-02-29', 'expense', 60000, 'Food'),
      record('refund', '2024-03-01', 'refund', 10000, 'Food'),
    ], customPeriod('2024-02-28', '2024-03-01'));
    expect(analysis.totalIncomePaise).toBe(100000);
    expect(analysis.totalExpensePaise).toBe(60000);
    expect(analysis.totalRefundPaise).toBe(10000);
    expect(analysis.netExpensePaise).toBe(50000);
    expect(analysis.netCashFlowPaise).toBe(50000);
  });

  it('excludes internal transfers, card payments, and unknown movements from totals', () => {
    const analysis = analyzePeriod([
      record('food', '2026-01-01', 'expense', 10000, 'Food'),
      record('transfer', '2026-01-02', 'expense', 900000, 'Other', 'Self transfer', { classification: 'internal_transfer', excludedFromAnalysis: true }),
      record('card', '2026-01-03', 'expense', 500000, 'Bills', 'Card bill', { classification: 'credit_card_payment', excludedFromAnalysis: true }),
      record('unknown', '2026-01-04', 'income', 700000, 'Other', 'Unknown credit', { classification: 'unknown', excludedFromAnalysis: true }),
    ], calendarYear(2026));
    expect(analysis.totalExpensePaise).toBe(10000);
    expect(analysis.totalIncomePaise).toBe(0);
    expect(analysis.warnings.join(' ')).toContain('excluded');
  });

  it('reports partial historical coverage instead of treating empty months as verified zeroes', () => {
    const analysis = analyzePeriod([record('one', '2026-04-10', 'expense', 10000, 'Food')], indianFinancialYear(2026));
    expect(analysis.coverage.expectedMonths).toBe(12);
    expect(analysis.coverage.observedMonths).toBe(1);
    expect(analysis.coverage.complete).toBe(false);
    expect(analysis.coverage.missingMonths).toHaveLength(11);
    expect(analysis.averageMonthlyExpensePaise).toBe(10000);
  });

  it('reconciles category, merchant, and account summaries', () => {
    const transactions = [
      record('a', '2026-01-01', 'income', 100000, 'Salary', 'Salary', { accountLabel: 'Salary account' }),
      record('b', '2026-01-02', 'expense', 40000, 'Food', 'Dmart', { accountLabel: 'Salary account', merchant: 'dmart' }),
      record('c', '2026-01-03', 'refund', 5000, 'Food', 'Dmart refund', { accountLabel: 'Salary account', merchant: 'dmart' }),
    ];
    const analysis = analyzePeriod(transactions, calendarYear(2026));
    expect(analysis.categories.find((item) => item.category === 'Food')?.netExpensePaise).toBe(35000);
    expect(analysis.accounts[0].netCashFlowPaise).toBe(65000);
    expect(analysis.merchants[0]).toMatchObject({ merchant: 'dmart', amountPaise: 40000, count: 1 });
  });
});

describe('recurring, anomaly, and budget intelligence', () => {
  it('detects observed monthly activity without claiming a verified subscription', () => {
    const transactions = [
      record('n1', '2026-01-12', 'expense', 49900, 'Entertainment', 'Netflix subscription', { merchant: 'netflix' }),
      record('n2', '2026-02-12', 'expense', 49900, 'Entertainment', 'Netflix subscription', { merchant: 'netflix' }),
      record('n3', '2026-03-12', 'expense', 49900, 'Entertainment', 'Netflix subscription', { merchant: 'netflix' }),
      record('n4', '2026-04-12', 'expense', 49900, 'Entertainment', 'Netflix subscription', { merchant: 'netflix' }),
    ];
    const [recurring] = detectRecurringPayments(transactions, customPeriod('2026-01-01', '2026-04-30'));
    expect(recurring).toMatchObject({ merchant: 'netflix', observedCount: 4, frequency: 'monthly', typicalAmountPaise: 49900, confidence: 'high' });
    expect(recurring.reason).toContain('not proof');
  });

  it('does not raise large-transaction anomalies with insufficient history', () => {
    const transactions = [record('large', '2026-01-02', 'expense', 5000000, 'Shopping')];
    expect(detectSpendingAnomalies(transactions, calendarYear(2026))).toEqual([]);
  });

  it('explains category increases using the previous three-month average', () => {
    const transactions = [
      record('a', '2026-01-05', 'expense', 100000, 'Shopping'),
      record('b', '2026-02-05', 'expense', 100000, 'Shopping'),
      record('c', '2026-03-05', 'expense', 100000, 'Shopping'),
      record('d', '2026-04-05', 'expense', 145000, 'Shopping'),
    ];
    const anomaly = detectSpendingAnomalies(transactions, customPeriod('2026-01-01', '2026-04-30')).find((item) => item.kind === 'category-increase');
    expect(anomaly?.reason).toContain('45%');
    expect(anomaly?.reason).toContain('previous three-month average');
  });

  it('requires at least two observed months for recommendations and exposes assumptions', () => {
    expect(recommendBudgets([record('one', '2026-01-01', 'expense', 100000, 'Food')], calendarYear(2026))).toEqual([]);
    const recommendations = recommendBudgets([
      record('one', '2026-01-01', 'expense', 100000, 'Food'),
      record('two', '2026-02-01', 'expense', 120000, 'Food'),
      record('three', '2026-03-01', 'expense', 110000, 'Food'),
    ], calendarYear(2026));
    expect(recommendations[0]).toMatchObject({ category: 'Food', monthsUsed: 3, confidence: 'medium' });
    expect(recommendations[0].suggestedPaise).toBeGreaterThanOrEqual(recommendations[0].recentAveragePaise);
    expect(recommendations[0].rationale).toContain('median');
  });
});
