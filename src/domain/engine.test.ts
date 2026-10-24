import { describe, expect, it } from 'vitest';
import { BUDGET_POLICY, calendarDaysBetween, formatMoney, getBudgetInsights, getMonthlyTrend, monthLabel, normalizeCurrency, parseAmount, transactionsToCSV, validateBudget, validateTransaction } from './engine';
import type { Budget, Transaction, TransactionInput } from './types';

const expense = (amountPaise: number, date = '2026-04-20', category = 'Food'): Transaction =>
  ({ id: `${date}-${amountPaise}`, type: 'expense', amountPaise, category, date, note: '', createdAt: 1 });
const budget = (limitPaise = 800000, monthKey = '2026-04'): Budget => ({ monthKey, limitPaise, categoryLimits: {} });

describe('explainable budget decisions', () => {
  it('reproduces the PDF case: 70% actual usage but 105% projected usage', () => {
    const result = getBudgetInsights([expense(560000)], budget(), '2026-04-20');
    expect(result.netSpendPaise).toBe(560000);
    expect(result.usagePercent).toBe(70);
    expect(result.forecastPaise).toBe(840000);
    expect(result.safeDailyPaise).toBe(24000);
    expect(result.daysRemaining).toBe(10);
    expect(result.alerts.map(a => a.code)).toEqual(['PACE_RISK']);
    expect(result.alerts[0].formula).toContain('20 elapsed days');
    expect(result.alerts[0].message).toContain('₹400');
  });

  it('warns at 80%, treats exactly 100% as near-limit, and exceeds strictly above 100%', () => {
    for (const [amount, code] of [[80000, 'NEAR_LIMIT'], [100000, 'NEAR_LIMIT'], [100001, 'BUDGET_EXCEEDED']] as const) {
      const result = getBudgetInsights([expense(amount, '2026-04-30')], budget(100000), '2026-04-30');
      expect(result.alerts.map(a => a.code)).toContain(code);
      expect(result.alerts.map(a => a.code)).not.toContain(code === 'NEAR_LIMIT' ? 'BUDGET_EXCEEDED' : 'NEAR_LIMIT');
    }
  });

  it('avoids division by zero for missing and zero limits', () => {
    for (const value of [undefined, budget(0)]) {
      const result = getBudgetInsights([expense(10000)], value, '2026-04-20');
      expect(result.limitPaise).toBeNull();
      expect(result.usagePercent).toBeNull();
      expect(result.safeDailyPaise).toBeNull();
      expect(result.forecastPaise).toBe(15000);
      expect(result.alerts.map(a => a.code)).toEqual(['BUDGET_UNSET']);
    }
  });

  it('floors daily allowance to whole paise and never advises a negative amount', () => {
    expect(getBudgetInsights([expense(1)], budget(102), '2026-04-20').safeDailyPaise).toBe(10);
    expect(getBudgetInsights([expense(103)], budget(102), '2026-04-20').safeDailyPaise).toBe(0);
  });

  it('uses the remaining amount for the final day without dividing by zero', () => {
    const result = getBudgetInsights([expense(560000)], budget(), '2026-04-30');
    expect(result.daysRemaining).toBe(0);
    expect(result.forecastPaise).toBe(560000);
    expect(result.safeDailyPaise).toBe(240000);
  });

  it('handles leap-year February and century exceptions', () => {
    expect(getBudgetInsights([], budget(10000, '2024-02'), '2024-02-10').daysInMonth).toBe(29);
    expect(getBudgetInsights([], budget(10000, '2100-02'), '2100-02-10').daysInMonth).toBe(28);
    expect(getBudgetInsights([], budget(10000, '2000-02'), '2000-02-10').daysInMonth).toBe(29);
  });

  it('uses historical actuals and excludes transactions recorded after the as-of date', () => {
    const records = [expense(40000, '2026-03-31'), expense(90000, '2026-04-01'), expense(30000, '2026-04-21')];
    const historical = getBudgetInsights(records, budget(50000, '2026-03'), '2026-04-20');
    expect(historical.netSpendPaise).toBe(40000);
    expect(historical.elapsedDays).toBe(31);
    expect(historical.forecastPaise).toBe(40000);
    expect(historical.safeDailyPaise).toBeNull();
    expect(historical.balancePaise).toBe(-130000);
    expect(historical.alerts.map(a => a.code)).not.toContain('PACE_RISK');
    expect(getBudgetInsights(records, budget(100000), '2026-04-20').netSpendPaise).toBe(90000);
  });

  it('keeps future months empty with no forecast or daily recommendation', () => {
    const result = getBudgetInsights([expense(20000, '2026-05-01')], budget(100000, '2026-05'), '2026-04-20');
    expect(result.netSpendPaise).toBe(0);
    expect(result.forecastPaise).toBe(0);
    expect(result.safeDailyPaise).toBeNull();
    expect(result.chartData).toEqual([]);
    expect(result.alerts).toEqual([]);
  });

  it('does not apply a budget from a different selected month', () => {
    const result = getBudgetInsights([expense(10000)], budget(), '2026-04-20', '2026-03');
    expect(result.monthKey).toBe('2026-03');
    expect(result.limitPaise).toBeNull();
  });

  it('counts refunds as returned cash, not income, and floors net budget spend at zero', () => {
    const records: Transaction[] = [expense(10000), { ...expense(3000), id: 'refund', type: 'refund' },
      { ...expense(20000), id: 'income', type: 'income', category: 'Allowance' }];
    const result = getBudgetInsights(records, budget(100000), '2026-04-20');
    expect(result.totalIncomePaise).toBe(20000);
    expect(result.totalExpensePaise).toBe(10000);
    expect(result.totalRefundPaise).toBe(3000);
    expect(result.netSpendPaise).toBe(7000);
    expect(result.balancePaise).toBe(13000);
    expect(result.categorySpend.find(c => c.category === 'Food')?.spentPaise).toBe(7000);
    const excess = getBudgetInsights([{ ...expense(12000), type: 'refund' }], budget(10000), '2026-04-20');
    expect(excess.netSpendPaise).toBe(0);
    expect(excess.balancePaise).toBe(12000);
    expect(excess.safeDailyPaise).toBe(1000);
  });

  it('issues explainable category alerts independently of the monthly budget', () => {
    const limits: Budget = { ...budget(), categoryLimits: { Food: 10000, Travel: 10000, Health: 0 } };
    const result = getBudgetInsights([expense(8000), expense(10001, '2026-04-20', 'Travel')], limits, '2026-04-20');
    expect(result.alerts.find(a => a.category === 'Food')?.code).toBe('CATEGORY_NEAR_LIMIT');
    expect(result.alerts.find(a => a.category === 'Travel')?.code).toBe('CATEGORY_EXCEEDED');
    expect(result.categorySpend.find(c => c.category === 'Health')?.usagePercent).toBeNull();
  });

  it('calculates cumulative chart data, refunds, and daily budget pace using integer paise', () => {
    const records: Transaction[] = [expense(1000, '2026-04-01'), { ...expense(200, '2026-04-02'), type: 'refund' }];
    const result = getBudgetInsights(records, budget(30000), '2026-04-03');
    expect(result.chartData).toEqual([
      { day: 1, spentPaise: 1000, cumulativePaise: 1000, budgetPacePaise: 1000 },
      { day: 2, spentPaise: -200, cumulativePaise: 800, budgetPacePaise: 2000 },
      { day: 3, spentPaise: 0, cumulativePaise: 800, budgetPacePaise: 3000 },
    ]);
  });

  it('does not mutate or reorder caller transaction arrays', () => {
    const records = [expense(10, '2026-04-01'), expense(20, '2026-04-20')];
    const ids = records.map(t => t.id);
    const result = getBudgetInsights(records, budget(), '2026-04-20');
    expect(records.map(t => t.id)).toEqual(ids);
    expect(result.recentTransactions[0].date).toBe('2026-04-20');
  });

  it('uses one policy and suppresses the future-tense pace warning when the budget is already exceeded', () => {
    expect(BUDGET_POLICY.warningUsagePercent).toBe(80);
    expect(BUDGET_POLICY.exceededUsagePercent).toBe(100);
    const result = getBudgetInsights([expense(800001)], budget(), '2026-04-20');
    expect(result.alerts.map(alert => alert.code)).toContain('BUDGET_EXCEEDED');
    expect(result.alerts.map(alert => alert.code)).not.toContain('PACE_RISK');
    expect(result.alerts.map(alert => alert.code)).not.toContain('NEAR_LIMIT');
  });

  it('exposes signed category refunds and a reconciliation adjustment instead of inventing positive spend', () => {
    const result = getBudgetInsights([expense(10000), { ...expense(5000, '2026-04-20', 'Travel'), type: 'refund' }], budget(), '2026-04-20');
    expect(result.netExpensePaise).toBe(5000);
    expect(result.signedCategorySpend.find(item => item.category === 'Travel')?.netExpensePaise).toBe(-5000);
    expect(result.signedCategorySpend.reduce((total, item) => total + item.netExpensePaise, 0)).toBe(result.netExpensePaise);
    expect(result.categorySpend.reduce((total, item) => total + item.spentPaise, 0) - result.refundAdjustmentPaise).toBe(result.netExpensePaise);
    const excess = getBudgetInsights([{ ...expense(10000), type: 'refund' }], budget(), '2026-04-20');
    expect(excess.netExpensePaise).toBe(-10000);
    expect(excess.netSpendPaise).toBe(0);
    expect(excess.refundAdjustmentPaise).toBe(10000);
  });

  it('does not crash for accepted boundary inputs and makes precision-limited advice unavailable', () => {
    const result = getBudgetInsights([expense(Number.MAX_SAFE_INTEGER, '2026-04-01')], budget(), '2026-04-01');
    expect(result.arithmeticLimited).toBe(true);
    expect(result.forecastAvailable).toBe(false);
    expect(result.forecastPaise).toBe(Number.MAX_SAFE_INTEGER);
    expect(result.safeDailyPaise).toBeNull();
    expect(result.usagePercent).toBeNull();
    expect(result.calculationWarning).toContain('safe integer range');
    const aggregate = getBudgetInsights([expense(Number.MAX_SAFE_INTEGER), { ...expense(Number.MAX_SAFE_INTEGER), id: 'second' }], budget(), '2026-04-20');
    expect(aggregate.arithmeticLimited).toBe(true);
    expect(aggregate.balanceAvailable).toBe(false);
  });
});

describe('input validation and exports', () => {
  const validInput: TransactionInput = { type: 'expense', amountPaise: 12345, category: 'Food', date: '2026-04-20', note: '' };

  it('parses decimal rupees exactly without binary floating-point multiplication', () => {
    expect(parseAmount('0.29')).toBe(29);
    expect(parseAmount(' 123.45 ')).toBe(12345);
    expect(parseAmount('.50')).toBe(50);
    expect(parseAmount('001.05')).toBe(105);
    expect(parseAmount('90071992547409.91')).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each(['', '0', '-1', '1.001', '1e3', 'NaN', 'Infinity', '1,000', '90071992547409.92'])('rejects invalid or inaccurate amount %s', value => {
    expect(() => parseAmount(value)).toThrow();
  });

  it.each(['2026-02-29', '2026-04-31', '2026-00-10', '2026-13-01', '2026-04-00', '2026-4-1', '0000-01-01'])('rejects malformed calendar date %s', date => {
    expect(() => validateTransaction({ ...validInput, date }, '2026-12-31')).toThrow();
  });

  it('rejects future dates, invalid categories, fractional paise, and oversized notes', () => {
    expect(() => validateTransaction({ ...validInput, date: '2026-04-21' }, '2026-04-20')).toThrow(/Future/);
    expect(() => validateTransaction({ ...validInput, type: 'income' }, '2026-04-20')).toThrow(/category/);
    expect(() => validateTransaction({ ...validInput, amountPaise: 0.5 }, '2026-04-20')).toThrow(/integer/);
    expect(() => validateTransaction({ ...validInput, note: 'a'.repeat(501) }, '2026-04-20')).toThrow(/500/);
    expect(() => validateTransaction({ ...validInput, date: '2024-02-29' }, '2026-04-20')).not.toThrow();
  });

  it('validates normalized budgets and fixed category limit keys', () => {
    expect(() => validateBudget(budget(0))).not.toThrow();
    expect(() => validateBudget(budget(-1))).toThrow();
    expect(() => validateBudget(budget(10, '2026-4'))).toThrow();
    expect(() => validateBudget({ ...budget(), categoryLimits: { Unknown: 100 } })).toThrow();
    expect(() => validateBudget({ ...budget(), categoryLimits: { Food: 0.1 } })).toThrow();
  });

  it('normalizes legacy INR records and rejects unsupported currency throughout financial operations', () => {
    expect(normalizeCurrency(undefined)).toBe('INR');
    expect(() => validateTransaction({ ...validInput, currency: 'INR' }, '2026-04-20')).not.toThrow();
    const wrong = { ...expense(10000), currency: 'USD' } as unknown as Transaction;
    expect(() => validateTransaction(wrong, '2026-04-20')).toThrow(/INR/);
    expect(() => validateBudget({ ...budget(), currency: 'USD' } as unknown as Budget)).toThrow(/INR/);
    expect(() => getBudgetInsights([wrong], budget(), '2026-04-20')).toThrow(/INR/);
    expect(() => getMonthlyTrend([wrong], '2026-04-20')).toThrow(/INR/);
    expect(() => transactionsToCSV([wrong])).toThrow(/INR/);
  });

  it('counts deadline calendar days across leap days and daylight-saving boundaries', () => {
    expect(calendarDaysBetween('2024-02-28', '2024-03-01')).toBe(2);
    expect(calendarDaysBetween('2026-03-07', '2026-03-09')).toBe(2);
    expect(calendarDaysBetween('2026-04-20', '2026-04-19')).toBe(-1);
  });

  it('handles six-month trends across the year boundary and includes refunds', () => {
    const records: Transaction[] = [expense(10000, '2025-12-31'), { ...expense(2000, '2025-12-31'), type: 'refund' },
      { ...expense(50000, '2026-01-01'), type: 'income', category: 'Allowance' }, expense(20000, '2026-01-21')];
    const trend = getMonthlyTrend(records, '2026-01-20');
    expect(trend.map(p => p.monthKey)).toEqual(['2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01']);
    expect(trend[4].expensePaise).toBe(8000);
    expect(trend[5].incomePaise).toBe(50000);
    expect(trend[5].expensePaise).toBe(0);
  });

  it('quotes CSV commas, quotes and newlines and neutralizes spreadsheet formulas', () => {
    const csv = transactionsToCSV([
      { ...expense(29), note: 'Lunch, "small"\nSecond line' },
      { ...expense(12345), note: '=HYPERLINK("https://example.com")' },
      { ...expense(1), note: '  +SUM(1,2)' },
    ]);
    expect(csv).toContain('"0.29"');
    expect(csv).toContain('"Lunch, ""small""\nSecond line"');
    expect(csv).toContain('"\'=HYPERLINK(""https://example.com"")"');
    expect(csv).toContain('"\'  +SUM(1,2)"');
    expect(csv).toContain('"123.45"');
  });

  it('exports the maximum safe paise amount without losing decimal precision', () => {
    expect(transactionsToCSV([expense(Number.MAX_SAFE_INTEGER)])).toContain('"90071992547409.91"');
  });

  it('formats Indian currency and readable month labels', () => {
    expect(formatMoney(12345)).toBe('₹123.45');
    expect(formatMoney(10000000)).toBe('₹1,00,000');
    expect(formatMoney(-29)).toBe('-₹0.29');
    expect(formatMoney(Number.MAX_SAFE_INTEGER)).toBe('₹9,00,71,99,25,47,409.91');
    expect(monthLabel('2026-04')).toBe('April 2026');
  });
});
