import { calendarDaysBetween, formatMoney, monthLabel, validateCalendarDate } from './engine';
import { normalizeDescription } from './import-engine';
import { EXPENSE_CATEGORIES, type Transaction } from './types';

const MAX = BigInt(Number.MAX_SAFE_INTEGER);

export interface AnalysisPeriod {
  start: string;
  end: string;
  label: string;
  kind: 'indian-financial-year' | 'calendar-year' | 'custom' | 'month';
}

export interface PeriodAnalysis {
  period: AnalysisPeriod;
  arithmeticLimited: boolean;
  totalIncomePaise: number;
  totalExpensePaise: number;
  totalRefundPaise: number;
  netExpensePaise: number;
  netCashFlowPaise: number;
  averageMonthlyExpensePaise: number;
  transactionCount: number;
  months: { monthKey: string; label: string; incomePaise: number; expensePaise: number; refundPaise: number; netExpensePaise: number }[];
  categories: { category: string; grossExpensePaise: number; refundPaise: number; netExpensePaise: number }[];
  merchants: { merchant: string; amountPaise: number; count: number }[];
  accounts: { account: string; incomePaise: number; expensePaise: number; refundPaise: number; netCashFlowPaise: number; count: number }[];
  largestTransactions: Transaction[];
  highestSpendingMonth: { monthKey: string; amountPaise: number } | null;
  monthChanges: { monthKey: string; previousMonthKey: string; changePercent: number; changePaise: number }[];
  comparison: { label: string; incomePaise: number; netExpensePaise: number; incomeChangePercent: number | null; expenseChangePercent: number | null } | null;
  coverage: { expectedMonths: number; observedMonths: number; missingMonths: string[]; firstDate: string | null; lastDate: string | null; complete: boolean };
  warnings: string[];
}

export interface RecurringInsight {
  id: string;
  merchant: string;
  transactionIds: string[];
  observedCount: number;
  frequency: 'weekly' | 'fortnightly' | 'monthly' | 'quarterly' | 'annual';
  typicalAmountPaise: number;
  estimatedMonthlyPaise: number;
  estimatedAnnualPaise: number;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

export interface SpendingAnomaly {
  id: string;
  kind: 'category-increase' | 'large-transaction' | 'repeated-looking' | 'new-merchant';
  title: string;
  reason: string;
  transactionIds: string[];
  severity: 'review' | 'notice';
}

export interface BudgetRecommendation {
  category: string;
  suggestedPaise: number;
  medianPaise: number;
  averagePaise: number;
  recentAveragePaise: number;
  monthsUsed: number;
  variabilityPercent: number;
  confidence: 'high' | 'medium' | 'low';
  rationale: string;
}

function dateFromParts(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function monthEnd(year: number, month: number): string {
  const date = new Date(0);
  date.setUTCFullYear(year, month, 0);
  return dateFromParts(year, month, date.getUTCDate());
}

export function indianFinancialYear(startYear: number): AnalysisPeriod {
  if (!Number.isInteger(startYear) || startYear < 1 || startYear > 9998) throw new Error('Choose a valid financial year.');
  return { start: `${startYear}-04-01`, end: `${startYear + 1}-03-31`, label: `FY ${startYear}–${String(startYear + 1).slice(-2)}`, kind: 'indian-financial-year' };
}

export function indianFinancialYearFor(date: string): AnalysisPeriod {
  validateCalendarDate(date);
  const year = Number(date.slice(0, 4));
  return indianFinancialYear(Number(date.slice(5, 7)) >= 4 ? year : year - 1);
}

export function calendarYear(year: number): AnalysisPeriod {
  if (!Number.isInteger(year) || year < 1 || year > 9999) throw new Error('Choose a valid calendar year.');
  return { start: `${year}-01-01`, end: `${year}-12-31`, label: String(year), kind: 'calendar-year' };
}

export function calendarMonth(monthKey: string): AnalysisPeriod {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey)) throw new Error('Choose a valid month.');
  const [year, month] = monthKey.split('-').map(Number);
  return { start: `${monthKey}-01`, end: monthEnd(year, month), label: monthLabel(monthKey), kind: 'month' };
}

export function customPeriod(start: string, end: string): AnalysisPeriod {
  validateCalendarDate(start);
  validateCalendarDate(end);
  if (start > end) throw new Error('The period start must be on or before its end.');
  return { start, end, label: `${start} to ${end}`, kind: 'custom' };
}

function monthsBetween(start: string, end: string): string[] {
  const [startYear, startMonth] = start.slice(0, 7).split('-').map(Number);
  const [endYear, endMonth] = end.slice(0, 7).split('-').map(Number);
  const first = startYear * 12 + startMonth - 1;
  const last = endYear * 12 + endMonth - 1;
  return Array.from({ length: last - first + 1 }, (_, index) => {
    const value = first + index;
    return `${String(Math.floor(value / 12)).padStart(4, '0')}-${String(value % 12 + 1).padStart(2, '0')}`;
  });
}

function bounded(value: bigint): { value: number; limited: boolean } {
  return { value: Number(value > MAX ? MAX : value < -MAX ? -MAX : value), limited: value > MAX || value < -MAX };
}

function sum(values: number[]): bigint {
  return values.reduce((total, value) => total + BigInt(value), 0n);
}

function percentChange(current: number, previous: number): number | null {
  return previous === 0 ? null : (current - previous) / Math.abs(previous) * 100;
}

function previousPeriod(period: AnalysisPeriod): AnalysisPeriod {
  const days = calendarDaysBetween(period.start, period.end) + 1;
  const startDate = new Date(`${period.start}T00:00:00Z`);
  startDate.setUTCDate(startDate.getUTCDate() - days);
  const endDate = new Date(`${period.start}T00:00:00Z`);
  endDate.setUTCDate(endDate.getUTCDate() - 1);
  const iso = (date: Date) => date.toISOString().slice(0, 10);
  return { start: iso(startDate), end: iso(endDate), label: `${iso(startDate)} to ${iso(endDate)}`, kind: 'custom' };
}

function merchantLabel(transaction: Transaction): string {
  return (transaction.merchant || normalizeDescription(transaction.note) || transaction.category).slice(0, 100);
}

function totalsFor(transactions: Transaction[]) {
  const income = sum(transactions.filter((transaction) => transaction.type === 'income').map((transaction) => transaction.amountPaise));
  const expense = sum(transactions.filter((transaction) => transaction.type === 'expense').map((transaction) => transaction.amountPaise));
  const refund = sum(transactions.filter((transaction) => transaction.type === 'refund').map((transaction) => transaction.amountPaise));
  return { income, expense, refund, netExpense: expense - refund, cashFlow: income + refund - expense };
}

export function analyzePeriod(allTransactions: Transaction[], period: AnalysisPeriod): PeriodAnalysis {
  validateCalendarDate(period.start);
  validateCalendarDate(period.end);
  if (period.start > period.end) throw new Error('The analysis period is invalid.');
  const included = allTransactions.filter((transaction) => !transaction.excludedFromAnalysis
    && transaction.date >= period.start && transaction.date <= period.end);
  const totals = totalsFor(included);
  let arithmeticLimited = false;
  const safe = (value: bigint) => { const result = bounded(value); arithmeticLimited ||= result.limited; return result.value; };
  const expectedMonthKeys = monthsBetween(period.start, period.end);
  const months = expectedMonthKeys.map((monthKey) => {
    const values = included.filter((transaction) => transaction.date.startsWith(monthKey));
    const monthly = totalsFor(values);
    return { monthKey, label: monthLabel(monthKey), incomePaise: safe(monthly.income), expensePaise: safe(monthly.expense),
      refundPaise: safe(monthly.refund), netExpensePaise: safe(monthly.netExpense) };
  });
  const observedKeys = new Set(included.map((transaction) => transaction.date.slice(0, 7)));
  const missingMonths = expectedMonthKeys.filter((monthKey) => !observedKeys.has(monthKey));
  const categories = EXPENSE_CATEGORIES.map((category) => {
    const values = included.filter((transaction) => transaction.category === category);
    const gross = sum(values.filter((transaction) => transaction.type === 'expense').map((transaction) => transaction.amountPaise));
    const refund = sum(values.filter((transaction) => transaction.type === 'refund').map((transaction) => transaction.amountPaise));
    return { category, grossExpensePaise: safe(gross), refundPaise: safe(refund), netExpensePaise: safe(gross - refund) };
  }).sort((first, second) => second.netExpensePaise - first.netExpensePaise);
  const merchantMap = new Map<string, { amount: bigint; count: number }>();
  for (const transaction of included.filter((value) => value.type === 'expense')) {
    const merchant = merchantLabel(transaction);
    const current = merchantMap.get(merchant) ?? { amount: 0n, count: 0 };
    current.amount += BigInt(transaction.amountPaise);
    current.count += 1;
    merchantMap.set(merchant, current);
  }
  const merchants = [...merchantMap].map(([merchant, value]) => ({ merchant, amountPaise: safe(value.amount), count: value.count }))
    .sort((first, second) => second.amountPaise - first.amountPaise).slice(0, 20);
  const accountMap = new Map<string, Transaction[]>();
  included.forEach((transaction) => {
    const account = transaction.accountLabel || 'Manual / unlabelled';
    accountMap.set(account, [...(accountMap.get(account) ?? []), transaction]);
  });
  const accounts = [...accountMap].map(([account, values]) => {
    const total = totalsFor(values);
    return { account, incomePaise: safe(total.income), expensePaise: safe(total.expense), refundPaise: safe(total.refund),
      netCashFlowPaise: safe(total.cashFlow), count: values.length };
  }).sort((first, second) => second.count - first.count);
  const highest = months.reduce<typeof months[number] | null>((best, month) => !best || month.netExpensePaise > best.netExpensePaise ? month : best, null);
  const monthChanges = months.slice(1).flatMap((month, index) => {
    const previous = months[index];
    const change = percentChange(month.netExpensePaise, previous.netExpensePaise);
    return change === null ? [] : [{ monthKey: month.monthKey, previousMonthKey: previous.monthKey,
      changePercent: change, changePaise: month.netExpensePaise - previous.netExpensePaise }];
  });
  const comparisonPeriod = previousPeriod(period);
  const comparisonTransactions = allTransactions.filter((transaction) => !transaction.excludedFromAnalysis
    && transaction.date >= comparisonPeriod.start && transaction.date <= comparisonPeriod.end);
  const prior = totalsFor(comparisonTransactions);
  const priorIncome = safe(prior.income);
  const priorExpense = safe(prior.netExpense);
  const income = safe(totals.income);
  const netExpense = safe(totals.netExpense);
  const sortedDates = included.map((transaction) => transaction.date).sort();
  const observedMonths = observedKeys.size;
  const warnings: string[] = [];
  if (missingMonths.length) warnings.push(`${missingMonths.length} month${missingMonths.length === 1 ? '' : 's'} in this period have no recorded transactions. Zero activity may mean missing statements.`);
  if (included.length === 0) warnings.push('No included transactions are available for this period.');
  if (arithmeticLimited) warnings.push('One or more aggregates exceed the exact safe-integer range; bounded figures must not be used for decisions.');
  if (allTransactions.some((transaction) => transaction.excludedFromAnalysis && transaction.date >= period.start && transaction.date <= period.end)) {
    warnings.push('Transfers, card payments, investments, cash withdrawals, loan movements, or uncertain rows excluded during review are not counted in these totals.');
  }
  return {
    period, arithmeticLimited, totalIncomePaise: income, totalExpensePaise: safe(totals.expense), totalRefundPaise: safe(totals.refund),
    netExpensePaise: netExpense, netCashFlowPaise: safe(totals.cashFlow),
    averageMonthlyExpensePaise: observedMonths ? Math.round(netExpense / observedMonths) : 0,
    transactionCount: included.length, months, categories, merchants, accounts,
    largestTransactions: included.slice().sort((first, second) => second.amountPaise - first.amountPaise || second.date.localeCompare(first.date)).slice(0, 10),
    highestSpendingMonth: highest && highest.netExpensePaise > 0 ? { monthKey: highest.monthKey, amountPaise: highest.netExpensePaise } : null,
    monthChanges,
    comparison: comparisonTransactions.length ? { label: comparisonPeriod.label, incomePaise: priorIncome, netExpensePaise: priorExpense,
      incomeChangePercent: percentChange(income, priorIncome), expenseChangePercent: percentChange(netExpense, priorExpense) } : null,
    coverage: { expectedMonths: expectedMonthKeys.length, observedMonths, missingMonths,
      firstDate: sortedDates[0] ?? null, lastDate: sortedDates[sortedDates.length - 1] ?? null,
      complete: Boolean(included.length) && missingMonths.length === 0 },
    warnings,
  };
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function frequency(interval: number): RecurringInsight['frequency'] | null {
  if (interval >= 5 && interval <= 9) return 'weekly';
  if (interval >= 12 && interval <= 18) return 'fortnightly';
  if (interval >= 25 && interval <= 35) return 'monthly';
  if (interval >= 80 && interval <= 100) return 'quarterly';
  if (interval >= 350 && interval <= 380) return 'annual';
  return null;
}

export function detectRecurringPayments(transactions: Transaction[], period: AnalysisPeriod): RecurringInsight[] {
  const groups = new Map<string, Transaction[]>();
  transactions.filter((transaction) => !transaction.excludedFromAnalysis && transaction.type === 'expense'
    && transaction.date >= period.start && transaction.date <= period.end).forEach((transaction) => {
    const merchant = merchantLabel(transaction);
    if (merchant.length < 3) return;
    groups.set(merchant, [...(groups.get(merchant) ?? []), transaction]);
  });
  return [...groups].flatMap(([merchant, values]) => {
    if (values.length < 3) return [];
    const sorted = values.sort((first, second) => first.date.localeCompare(second.date));
    const intervals = sorted.slice(1).map((transaction, index) => calendarDaysBetween(sorted[index].date, transaction.date));
    const typicalInterval = median(intervals);
    const estimatedFrequency = frequency(typicalInterval);
    if (!estimatedFrequency) return [];
    const amounts = sorted.map((transaction) => transaction.amountPaise);
    const typicalAmountPaise = median(amounts);
    const amountVariation = typicalAmountPaise ? Math.max(...amounts.map((amount) => Math.abs(amount - typicalAmountPaise))) / typicalAmountPaise : 1;
    const intervalVariation = Math.max(...intervals.map((days) => Math.abs(days - typicalInterval)));
    const confidence: RecurringInsight['confidence'] = values.length >= 4 && amountVariation <= 0.1 && intervalVariation <= 5 ? 'high'
      : amountVariation <= 0.25 && intervalVariation <= 9 ? 'medium' : 'low';
    const estimatedMonthlyPaise = Math.round(typicalAmountPaise * 30.4375 / typicalInterval);
    return [{ id: `recurring-${normalizeDescription(merchant).replace(/\s+/g, '-').slice(0, 60)}`, merchant,
      transactionIds: sorted.map((transaction) => transaction.id), observedCount: values.length,
      frequency: estimatedFrequency, typicalAmountPaise, estimatedMonthlyPaise,
      estimatedAnnualPaise: estimatedMonthlyPaise * 12, confidence,
      reason: `${values.length} observed payments, typically ${typicalInterval} days apart. This is recurring activity, not proof of an active subscription.` }];
  }).sort((first, second) => second.estimatedAnnualPaise - first.estimatedAnnualPaise);
}

export function detectSpendingAnomalies(transactions: Transaction[], period: AnalysisPeriod): SpendingAnomaly[] {
  const expenses = transactions.filter((transaction) => !transaction.excludedFromAnalysis && transaction.type === 'expense'
    && transaction.date >= period.start && transaction.date <= period.end).sort((first, second) => first.date.localeCompare(second.date));
  const anomalies: SpendingAnomaly[] = [];
  const monthKeys = monthsBetween(period.start, period.end);
  for (const category of EXPENSE_CATEGORIES) {
    const values = monthKeys.map((monthKey) => expenses.filter((transaction) => transaction.category === category && transaction.date.startsWith(monthKey))
      .reduce((total, transaction) => total + transaction.amountPaise, 0));
    for (let index = 3; index < values.length; index += 1) {
      const baseline = Math.round((values[index - 1] + values[index - 2] + values[index - 3]) / 3);
      const current = values[index];
      const increase = percentChange(current, baseline);
      if (baseline >= 50_000 && current >= 100_000 && increase !== null && increase >= 40) {
        anomalies.push({ id: `category-${category}-${monthKeys[index]}`, kind: 'category-increase', severity: 'notice',
          title: `${category} increased in ${monthLabel(monthKeys[index])}`,
          reason: `${formatMoney(current)} was ${increase.toFixed(0)}% higher than the previous three-month average of ${formatMoney(baseline)}.`, transactionIds: [] });
      }
    }
  }
  if (expenses.length >= 9) {
    expenses.forEach((transaction, index) => {
      const prior = expenses.slice(0, index).map((value) => value.amountPaise);
      if (prior.length < 8) return;
      const baseline = median(prior);
      if (transaction.amountPaise >= Math.max(500_000, baseline * 3)) {
        anomalies.push({ id: `large-${transaction.id}`, kind: 'large-transaction', severity: 'review',
          title: 'Large transaction to review', reason: `${formatMoney(transaction.amountPaise)} for ${transaction.note || transaction.category} is more than three times the prior median expense of ${formatMoney(baseline)}.`,
          transactionIds: [transaction.id] });
      }
    });
    const overallMedian = median(expenses.map((transaction) => transaction.amountPaise));
    const seen = new Set<string>();
    expenses.forEach((transaction) => {
      const merchant = merchantLabel(transaction);
      if (!seen.has(merchant) && transaction.amountPaise >= Math.max(500_000, overallMedian * 2)) {
        anomalies.push({ id: `merchant-${transaction.id}`, kind: 'new-merchant', severity: 'notice',
          title: 'New high-value merchant', reason: `${merchant} first appears in this coverage with a ${formatMoney(transaction.amountPaise)} expense. Review it if you do not recognize it.`,
          transactionIds: [transaction.id] });
      }
      seen.add(merchant);
    });
  }
  const repeated = new Map<string, Transaction[]>();
  expenses.forEach((transaction) => {
    const key = `${transaction.date}|${transaction.amountPaise}|${normalizeDescription(transaction.note)}|${transaction.accountKey ?? ''}`;
    repeated.set(key, [...(repeated.get(key) ?? []), transaction]);
  });
  repeated.forEach((values) => {
    if (values.length < 2) return;
    anomalies.push({ id: `repeat-${values[0].id}`, kind: 'repeated-looking', severity: 'review',
      title: 'Repeated-looking entries', reason: `${values.length} records share the same date, amount, description, and account. They may be legitimate repeated purchases; inspect them before removing anything.`,
      transactionIds: values.map((transaction) => transaction.id) });
  });
  return anomalies.slice(0, 30);
}

function roundedBudget(value: number): number {
  const unit = 10_000; // nearest ₹100
  return Math.max(unit, Math.ceil(value / unit) * unit);
}

export function recommendBudgets(transactions: Transaction[], period: AnalysisPeriod): BudgetRecommendation[] {
  const included = transactions.filter((transaction) => !transaction.excludedFromAnalysis
    && transaction.date >= period.start && transaction.date <= period.end);
  const observedMonths = [...new Set(included.map((transaction) => transaction.date.slice(0, 7)))].sort();
  if (observedMonths.length < 2) return [];
  return EXPENSE_CATEGORIES.flatMap((category) => {
    const monthly = observedMonths.map((monthKey) => {
      const values = included.filter((transaction) => transaction.category === category && transaction.date.startsWith(monthKey));
      return values.reduce((total, transaction) => total + (transaction.type === 'expense' ? transaction.amountPaise : transaction.type === 'refund' ? -transaction.amountPaise : 0), 0);
    }).map((value) => Math.max(0, value));
    if (!monthly.some(Boolean)) return [];
    const categoryMedian = median(monthly);
    const average = Math.round(monthly.reduce((total, value) => total + value, 0) / monthly.length);
    const recent = monthly.slice(-Math.min(3, monthly.length));
    const recentAverage = Math.round(recent.reduce((total, value) => total + value, 0) / recent.length);
    const variability = categoryMedian ? (Math.max(...monthly) - Math.min(...monthly)) / categoryMedian * 100 : 100;
    const buffer = variability > 75 ? 1.15 : 1.1;
    const suggestedPaise = roundedBudget(Math.max(categoryMedian, recentAverage) * buffer);
    const confidence: BudgetRecommendation['confidence'] = monthly.length >= 6 ? 'high' : monthly.length >= 3 ? 'medium' : 'low';
    return [{ category, suggestedPaise, medianPaise: categoryMedian, averagePaise: average,
      recentAveragePaise: recentAverage, monthsUsed: monthly.length, variabilityPercent: variability,
      confidence, rationale: `Uses ${monthly.length} observed months. The higher of median (${formatMoney(categoryMedian)}) and recent average (${formatMoney(recentAverage)}) receives a ${Math.round((buffer - 1) * 100)}% variability buffer and is rounded up to ₹100.` }];
  }).sort((first, second) => second.suggestedPaise - first.suggestedPaise);
}

export function deterministicFinancialSummary(analysis: PeriodAnalysis, recurring: RecurringInsight[], anomalies: SpendingAnomaly[]): string[] {
  if (!analysis.transactionCount) return ['No included transactions are available for this period, so no financial conclusions are shown.'];
  const top = analysis.categories.find((category) => category.netExpensePaise > 0);
  const lines = [
    `${analysis.period.label} contains ${analysis.transactionCount} included transactions across ${analysis.coverage.observedMonths} observed month${analysis.coverage.observedMonths === 1 ? '' : 's'}.`,
    `Recorded income was ${formatMoney(analysis.totalIncomePaise)} and signed net expenses were ${formatMoney(analysis.netExpensePaise)}. Net cash flow from included records was ${formatMoney(analysis.netCashFlowPaise)}.`,
  ];
  if (top) lines.push(`${top.category} was the largest expense category at ${formatMoney(top.netExpensePaise)}.`);
  if (analysis.highestSpendingMonth) lines.push(`${monthLabel(analysis.highestSpendingMonth.monthKey)} was the highest-spending month at ${formatMoney(analysis.highestSpendingMonth.amountPaise)}.`);
  if (recurring.length) lines.push(`${recurring.length} recurring pattern${recurring.length === 1 ? '' : 's'} were observed; these are suggestions, not verified active subscriptions.`);
  if (anomalies.length) lines.push(`${anomalies.length} unusual pattern${anomalies.length === 1 ? '' : 's'} met the minimum-data rules and may be worth reviewing. This is not fraud detection.`);
  if (!analysis.coverage.complete) lines.push('Coverage is incomplete, so period comparisons and averages may understate actual activity.');
  return lines;
}
