import {
  EXPENSE_CATEGORIES,
  INCOME_CATEGORIES,
  type Budget,
  type BudgetAlert,
  type BudgetInsights,
  type Transaction,
  type TransactionInput,
} from './types';

const MAX_SAFE_PAISE = BigInt(Number.MAX_SAFE_INTEGER);
export const BUDGET_POLICY = Object.freeze({
  currency: 'INR' as const,
  warningUsagePercent: 80,
  exceededUsagePercent: 100,
  earlyForecastDays: 7,
  minExpenseRecordsForRunRate: 3,
});

export interface BudgetComputation extends BudgetInsights {
  /** Numeric legacy fields are bounded placeholders if arithmeticLimited is true; do not present them as exact totals. */
  arithmeticLimited: boolean;
  balanceAvailable: boolean;
  forecastAvailable: boolean;
  calculationWarning: string | null;
  /** Signed expense minus refunds, before the budget-guidance floor at zero. */
  netExpensePaise: number;
  signedCategorySpend: { category: string; grossExpensePaise: number; refundPaise: number; netExpensePaise: number }[];
  /** Positive chart slices minus this adjustment equals signed net spending. */
  refundAdjustmentPaise: number;
}
const rupees = new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: BUDGET_POLICY.currency, minimumFractionDigits: 0, maximumFractionDigits: 2,
});

function checkedInteger(value: bigint): number {
  // Keep legacy number fields renderable. Consumers must honor the accompanying precision flags.
  return Number(value > MAX_SAFE_PAISE ? MAX_SAFE_PAISE : value < -MAX_SAFE_PAISE ? -MAX_SAFE_PAISE : value);
}

function fitsInteger(value: bigint): boolean { return value <= MAX_SAFE_PAISE && value >= -MAX_SAFE_PAISE; }
function sumRaw(values: number[]): bigint { return values.reduce((sum, amount) => sum + BigInt(amount), 0n); }

export function normalizeCurrency(currency: unknown): 'INR' {
  if (currency !== undefined && currency !== BUDGET_POLICY.currency) throw new Error('SpendSmart supports INR only.');
  return BUDGET_POLICY.currency;
}

export function validateCalendarDate(date: string): void { dateParts(date); }
export function validateMonthKey(monthKey: string): void { monthParts(monthKey); }

export function calendarDaysBetween(start: string, end: string): number {
  const toUTC = (value: string) => {
    const { year, month, day } = dateParts(value);
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(0, 0, 0, 0);
    return date.getTime();
  };
  return Math.round((toUTC(end) - toUTC(start)) / 86400000);
}

function monthParts(monthKey: string): { year: number; month: number } {
  if (typeof monthKey !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey)) {
    throw new Error('Use a valid month in YYYY-MM format.');
  }
  const [year, month] = monthKey.split('-').map(Number);
  if (year === 0) throw new Error('Use a calendar year greater than zero.');
  return { year, month };
}

function monthLength(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function dateParts(date: string): { year: number; month: number; day: number } {
  if (typeof date !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(date)) {
    throw new Error('Use a valid date in YYYY-MM-DD format.');
  }
  const { year, month } = monthParts(date.slice(0, 7));
  const day = Number(date.slice(8));
  if (day < 1 || day > monthLength(year, month)) throw new Error('That calendar date does not exist.');
  return { year, month, day };
}

function isPaise(value: unknown, allowZero = false): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && (allowZero ? value >= 0 : value > 0);
}

export function todayISO(): string {
  const date = new Date();
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function monthLabel(monthKey: string): string {
  const { year, month } = monthParts(monthKey);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, 1);
  return new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date);
}

export function formatMoney(paise: number): string {
  if (!Number.isSafeInteger(paise)) throw new Error('Money must be a safe integer number of paise.');
  // Format whole rupees as a bigint so the largest valid amounts keep their exact paise.
  const value = BigInt(paise);
  const absolute = value < 0n ? -value : value;
  const fraction = absolute % 100n;
  return (value < 0n ? '-' : '') + rupees.format(absolute / 100n)
    + (fraction ? `.${String(fraction).padStart(2, '0').replace(/0$/, '')}` : '');
}

export function parseAmount(value: string): number {
  const amount = typeof value === 'string' ? value.trim() : '';
  if (!/^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(amount)) {
    throw new Error('Enter a positive amount with at most two decimal places.');
  }
  const [whole, fraction = ''] = amount.split('.');
  const paise = BigInt(whole || '0') * 100n + BigInt(fraction.padEnd(2, '0'));
  if (paise <= 0n || paise > MAX_SAFE_PAISE) throw new Error('Enter a positive amount that can be stored accurately.');
  return Number(paise);
}

export function validateTransaction(input: TransactionInput, asOf = todayISO()): void {
  dateParts(asOf);
  if (!input || !['expense', 'income', 'refund'].includes(input.type)) throw new Error('Choose expense, income, or refund.');
  normalizeCurrency(input.currency);
  if (!isPaise(input.amountPaise)) throw new Error('The amount must be a positive, safe integer number of paise.');
  const categories: readonly string[] = input.type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
  if (!categories.includes(input.category)) throw new Error('Choose a valid category for this transaction type.');
  dateParts(input.date);
  if (input.date > asOf) throw new Error('Future transactions cannot be recorded yet.');
  if (typeof input.note !== 'string' || input.note.length > 500) throw new Error('Keep the note to 500 characters or fewer.');
}

export function validateBudget(budget: Budget): void {
  if (!budget) throw new Error('Enter a budget.');
  normalizeCurrency(budget.currency);
  monthParts(budget.monthKey);
  if (!isPaise(budget.limitPaise, true)) throw new Error('The budget must be zero or a positive, safe integer number of paise.');
  if (!budget.categoryLimits || typeof budget.categoryLimits !== 'object' || Array.isArray(budget.categoryLimits)) {
    throw new Error('Category limits must be a category-to-amount map.');
  }
  for (const [category, amount] of Object.entries(budget.categoryLimits)) {
    if (!(EXPENSE_CATEGORIES as readonly string[]).includes(category) || !isPaise(amount, true)) {
      throw new Error('Each category budget must use a valid expense category and a nonnegative integer amount.');
    }
  }
}

/** All asOf dates are local calendar dates; no UTC conversion can move a transaction into another month. */
export function getBudgetInsights(
  transactions: Transaction[], budget: Budget | undefined, asOf: string, selectedMonth?: string,
): BudgetComputation {
  const current = dateParts(asOf);
  const monthKey = selectedMonth ?? budget?.monthKey ?? asOf.slice(0, 7);
  const { year, month } = monthParts(monthKey);
  if (budget) validateBudget(budget);
  const effectiveBudget = budget?.monthKey === monthKey ? budget : undefined;
  const daysInMonth = monthLength(year, month);
  const currentMonth = asOf.slice(0, 7);
  const isCurrent = monthKey === currentMonth;
  const elapsedDays = isCurrent ? current.day : monthKey < currentMonth ? daysInMonth : 0;
  const daysRemaining = isCurrent ? daysInMonth - elapsedDays : monthKey < currentMonth ? 0 : daysInMonth;

  const recorded = transactions.filter(transaction => {
    // Validate the record itself; a historical asOf still excludes later valid records rather than rejecting them.
    validateTransaction(transaction, transaction.date);
    return transaction.date <= asOf;
  });
  const monthly = recorded.filter(transaction => transaction.date.slice(0, 7) === monthKey);
  const incomeRaw = sumRaw(monthly.filter(t => t.type === 'income').map(t => t.amountPaise));
  const expenseRaw = sumRaw(monthly.filter(t => t.type === 'expense').map(t => t.amountPaise));
  const refundRaw = sumRaw(monthly.filter(t => t.type === 'refund').map(t => t.amountPaise));
  const netRaw = expenseRaw - refundRaw;
  const spendingRaw = netRaw > 0n ? netRaw : 0n;
  const balanceRaw = sumRaw(recorded.map(t => t.type === 'expense' ? -t.amountPaise : t.amountPaise));
  const forecastRaw = elapsedDays === 0 ? 0n :
    (spendingRaw * BigInt(daysInMonth) + BigInt(Math.floor(elapsedDays / 2))) / BigInt(elapsedDays);
  let arithmeticLimited = [incomeRaw, expenseRaw, refundRaw, netRaw, balanceRaw, forecastRaw].some(value => !fitsInteger(value));
  const totalIncomePaise = checkedInteger(incomeRaw);
  const totalExpensePaise = checkedInteger(expenseRaw);
  const totalRefundPaise = checkedInteger(refundRaw);
  const netExpensePaise = checkedInteger(netRaw);
  const netSpendPaise = checkedInteger(spendingRaw);
  const balancePaise = checkedInteger(balanceRaw);
  const limitPaise = effectiveBudget && effectiveBudget.limitPaise > 0 ? effectiveBudget.limitPaise : null;
  const remainingPaise = limitPaise === null ? null : limitPaise - netSpendPaise;
  const usagePercent = limitPaise === null ? null : netSpendPaise / limitPaise * 100;
  const forecastPaise = checkedInteger(forecastRaw);
  const safeDailyPaise = !isCurrent || remainingPaise === null || arithmeticLimited
    ? null : Math.floor(Math.max(0, remainingPaise) / Math.max(1, daysRemaining));

  const signedCategorySpend = EXPENSE_CATEGORIES.map(category => {
    const gross = sumRaw(monthly.filter(t => t.category === category && t.type === 'expense').map(t => t.amountPaise));
    const refunded = sumRaw(monthly.filter(t => t.category === category && t.type === 'refund').map(t => t.amountPaise));
    if (![gross, refunded, gross - refunded].every(fitsInteger)) arithmeticLimited = true;
    return { category, grossExpensePaise: checkedInteger(gross), refundPaise: checkedInteger(refunded), netExpensePaise: checkedInteger(gross - refunded) };
  });
  const categorySpend = signedCategorySpend.map(item => {
    const category = item.category;
    const spentPaise = Math.max(0, item.netExpensePaise);
    const categoryLimit = effectiveBudget?.categoryLimits[category];
    const limit = categoryLimit && categoryLimit > 0 ? categoryLimit : null;
    return { category, spentPaise, limitPaise: limit, usagePercent: limit === null ? null : spentPaise / limit * 100 };
  }).sort((a, b) => b.spentPaise - a.spentPaise);

  const alerts: BudgetAlert[] = [];
  if (arithmeticLimited) {
    // Precision-limited totals have no trustworthy percentage or risk recommendation.
  } else if (limitPaise === null) {
    alerts.push({ code: 'BUDGET_UNSET', severity: 'info', title: 'Give this month a spending limit',
      message: 'Set a positive monthly budget to calculate usage and a safe daily amount. A zero limit is treated as unset.' });
  } else {
    const usageFormula = `${formatMoney(netSpendPaise)} ÷ ${formatMoney(limitPaise)} × 100 = ${usagePercent!.toFixed(1)}%`;
    if (usagePercent! > BUDGET_POLICY.exceededUsagePercent) {
      alerts.push({ code: 'BUDGET_EXCEEDED', severity: 'danger', title: 'Monthly budget exceeded',
        message: `Recorded net spending is ${formatMoney(netSpendPaise - limitPaise)} over your monthly limit.`, formula: usageFormula });
    } else if (usagePercent! >= BUDGET_POLICY.warningUsagePercent) {
      alerts.push({ code: 'NEAR_LIMIT', severity: 'warning', title: netSpendPaise === limitPaise ? 'Monthly budget fully used' : 'Getting close to your monthly limit',
        message: `You have used ${usagePercent!.toFixed(1)}% of your budget. ${formatMoney(Math.max(0, remainingPaise!))} remains.`, formula: usageFormula });
    }
    if (isCurrent && netSpendPaise <= limitPaise && forecastPaise > limitPaise) {
      alerts.push({ code: 'PACE_RISK', severity: 'warning', title: 'Your current pace could exceed the budget',
        message: `At this pace, month-end spending is projected at ${formatMoney(forecastPaise)} — ${formatMoney(forecastPaise - limitPaise)} over the limit. This is a run-rate estimate, not a prediction.`,
        formula: `(${formatMoney(netSpendPaise)} ÷ ${elapsedDays} elapsed days) × ${daysInMonth} days = ${formatMoney(forecastPaise)}` });
    }
  }
  for (const item of categorySpend) {
    if (arithmeticLimited || item.limitPaise === null || item.usagePercent === null || item.usagePercent < BUDGET_POLICY.warningUsagePercent) continue;
    const exceeded = item.usagePercent > BUDGET_POLICY.exceededUsagePercent;
    alerts.push({ code: exceeded ? 'CATEGORY_EXCEEDED' : 'CATEGORY_NEAR_LIMIT', severity: exceeded ? 'danger' : 'warning',
      category: item.category, title: `${item.category}: ${exceeded ? 'category budget exceeded' : item.spentPaise === item.limitPaise ? 'category budget fully used' : 'close to the limit'}`,
      message: `${formatMoney(item.spentPaise)} spent against a ${formatMoney(item.limitPaise)} category limit (${item.usagePercent.toFixed(1)}%).`,
      formula: `${formatMoney(item.spentPaise)} ÷ ${formatMoney(item.limitPaise)} × 100 = ${item.usagePercent.toFixed(1)}%` });
  }

  let cumulativeRawPaise = 0n;
  const chartData = Array.from({ length: elapsedDays }, (_, index) => {
    const day = index + 1;
    const date = `${monthKey}-${String(day).padStart(2, '0')}`;
    const dailyRaw = sumRaw(monthly.filter(t => t.date === date && t.type !== 'income').map(t => t.type === 'refund' ? -t.amountPaise : t.amountPaise));
    cumulativeRawPaise += dailyRaw;
    if (!fitsInteger(dailyRaw) || !fitsInteger(cumulativeRawPaise)) arithmeticLimited = true;
    return { day, spentPaise: checkedInteger(dailyRaw), cumulativePaise: Math.max(0, checkedInteger(cumulativeRawPaise)),
      budgetPacePaise: limitPaise === null ? null : checkedInteger(BigInt(limitPaise) * BigInt(day) / BigInt(daysInMonth)) };
  });

  return { monthKey, totalIncomePaise, totalExpensePaise, totalRefundPaise, netSpendPaise, balancePaise, limitPaise,
    remainingPaise: arithmeticLimited ? null : remainingPaise, usagePercent: arithmeticLimited ? null : usagePercent,
    forecastPaise, safeDailyPaise: arithmeticLimited ? null : safeDailyPaise, elapsedDays, daysInMonth, daysRemaining,
    arithmeticLimited, balanceAvailable: fitsInteger(balanceRaw), forecastAvailable: !arithmeticLimited && fitsInteger(forecastRaw),
    calculationWarning: arithmeticLimited ? 'These amounts exceed the safe integer range. Exact totals, forecasts and affordable spending are unavailable; correct the oversized records.' : null,
    netExpensePaise, signedCategorySpend,
    refundAdjustmentPaise: checkedInteger(sumRaw(categorySpend.map(item => item.spentPaise)) - netRaw),
    categorySpend, alerts, chartData,
    recentTransactions: [...monthly].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt).slice(0, 5) };
}

export function getMonthlyTrend(transactions: Transaction[], asOf: string): { monthKey: string; label: string; incomePaise: number; expensePaise: number; netExpensePaise: number; arithmeticLimited: boolean }[] {
  const { year, month } = dateParts(asOf);
  const recorded = transactions.filter(transaction => {
    validateTransaction(transaction, transaction.date);
    return transaction.date <= asOf;
  });
  return Array.from({ length: 6 }, (_, index) => {
    const monthIndex = year * 12 + month - 1 - (5 - index);
    const targetYear = Math.floor(monthIndex / 12);
    const targetMonth = monthIndex % 12 + 1;
    const monthKey = `${String(targetYear).padStart(4, '0')}-${String(targetMonth).padStart(2, '0')}`;
    const monthly = recorded.filter(t => t.date.slice(0, 7) === monthKey);
    const income = sumRaw(monthly.filter(t => t.type === 'income').map(t => t.amountPaise));
    const net = sumRaw(monthly.filter(t => t.type !== 'income').map(t => t.type === 'refund' ? -t.amountPaise : t.amountPaise));
    return { monthKey, label: monthLabel(monthKey).split(' ')[0].slice(0, 3),
      incomePaise: checkedInteger(income), expensePaise: Math.max(0, checkedInteger(net)),
      netExpensePaise: checkedInteger(net), arithmeticLimited: !fitsInteger(income) || !fitsInteger(net) };
  });
}

function csvCell(value: string): string {
  // Quotes do not neutralize spreadsheet formulas, so prefix dangerous text with an apostrophe too.
  const safe = /^[\s]*[=+\-@\t\r]/.test(value) || /^[\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

function decimalRupees(paise: number): string {
  if (!isPaise(paise)) throw new Error('A transaction contains an invalid paise amount.');
  const amount = BigInt(paise);
  return `${amount / 100n}.${String(amount % 100n).padStart(2, '0')}`;
}

export function transactionsToCSV(transactions: Transaction[]): string {
  const rows = [['Date', 'Type', 'Category', `Amount (${BUDGET_POLICY.currency})`, 'Note'], ...transactions.map(t => {
    validateTransaction(t, t.date);
    return [t.date, t.type, t.category, decimalRupees(t.amountPaise), t.note];
  })];
  return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
