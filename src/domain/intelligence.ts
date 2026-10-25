import {
  BUDGET_POLICY, calendarDaysBetween, formatMoney, getBudgetInsights,
  validateCalendarDate, validateMonthKey, type BudgetComputation,
} from './engine';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES, type Budget, type Transaction } from './types';
import type { FinancialContext, PlannedExpense, SavingsGoal, StudentPlan } from './planning-types';

export interface FinancialIntelligence {
  base: BudgetComputation;
  /** Covers both ledger totals and additional planning/projection aggregates. */
  arithmeticLimited: boolean;
  calculationWarning: string | null;
  safeTodayPaise: number | null;
  budgetDailyPaise: number | null;
  actualBalancePaise: number | null;
  cashAvailablePaise: number | null;
  reservedGoalsPaise: number;
  upcomingPaise: number;
  expectedRemainingIncomePaise: number;
  projectedCashBalancePaise: number | null;
  /** Positive means projected under budget; negative means projected over budget. */
  projectedBudgetVariancePaise: number | null;
  forecastStatus: 'unavailable' | 'early' | 'run-rate' | 'historical';
  forecastReason: string;
  status: { tone: 'good' | 'warning' | 'danger' | 'neutral'; label: string; reason: string };
  categoryConstraint: string | null;
  daysIncludingToday: number;
  /** Signed net expenses: refunds can make an essential/discretionary total negative. */
  essentialPaise: number;
  discretionaryPaise: number;
  goalProgress: {
    id: string; title: string; targetPaise: number; backedPaise: number; remainingPaise: number;
    weeklyPaise: number; percent: number; targetDate: string; reason: string;
  }[];
}

const MAX = BigInt(Number.MAX_SAFE_INTEGER);
const DEFAULT_ESSENTIALS = ['Food', 'Bills', 'Education', 'Health', 'Travel'];
const sum = (amounts: number[]) => amounts.reduce((value, amount) => value + BigInt(amount), 0n);
const fits = (amount: bigint) => amount >= -MAX && amount <= MAX;
const positive = (amount: bigint) => amount > 0n ? amount : 0n;
const maximum = (first: bigint, second: bigint) => first > second ? first : second;
const minimum = (first: bigint, second: bigint) => first < second ? first : second;

function validatePaise(value: unknown, zeroAllowed: boolean, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || (zeroAllowed ? value < 0 : value <= 0)) {
    throw new Error(`${label} must be ${zeroAllowed ? 'a nonnegative' : 'a positive'} safe integer amount in paise.`);
  }
}

function validateId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || value.includes('/')) {
    throw new Error(`${label} must be a nonempty document ID of at most 128 characters.`);
  }
}

function validateTitle(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 100) throw new Error('Use a title of 1–100 characters.');
}

function validateTimestamp(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Use a valid creation timestamp.');
}

export function validateStudentPlan(plan: StudentPlan): void {
  if (!plan || typeof plan !== 'object') throw new Error('Enter a monthly student plan.');
  validateMonthKey(plan.monthKey);
  if (plan.currency !== BUDGET_POLICY.currency) throw new Error('SpendSmart student plans support INR only.');
  if (!plan.expectedIncome || typeof plan.expectedIncome !== 'object' || Array.isArray(plan.expectedIncome)) {
    throw new Error('Expected income must be an income-source-to-amount map.');
  }
  for (const [source, amount] of Object.entries(plan.expectedIncome)) {
    if (!(INCOME_CATEGORIES as readonly string[]).includes(source)) throw new Error('Choose a supported expected-income source.');
    validatePaise(amount, true, 'Expected income');
  }
  if (!Array.isArray(plan.essentialCategories) || new Set(plan.essentialCategories).size !== plan.essentialCategories.length
    || plan.essentialCategories.some(category => !(EXPENSE_CATEGORIES as readonly string[]).includes(category))) {
    throw new Error('Essential categories must be unique supported expense categories.');
  }
}

export function validatePlannedExpense(expense: PlannedExpense): void {
  if (!expense || typeof expense !== 'object') throw new Error('Enter a planned expense.');
  validateId(expense.id, 'Planned expense ID');
  validateTitle(expense.title);
  validatePaise(expense.amountPaise, false, 'Planned expense');
  if (!(EXPENSE_CATEGORIES as readonly string[]).includes(expense.category)) throw new Error('Choose a valid planned-expense category.');
  validateCalendarDate(expense.dueDate);
  validateTimestamp(expense.createdAt);
  if (!['planned', 'paid'].includes(expense.status)) throw new Error('A planned expense must be planned or paid.');
  if (expense.transactionId !== undefined) validateId(expense.transactionId, 'Payment transaction ID');
  if (expense.status === 'paid' && !expense.transactionId) throw new Error('A paid plan must link to its recorded payment.');
  if (expense.status === 'planned' && expense.transactionId !== undefined) throw new Error('An unpaid planned expense cannot retain a payment link.');
}

export function validateSavingsGoal(goal: SavingsGoal): void {
  if (!goal || typeof goal !== 'object') throw new Error('Enter a savings goal.');
  validateId(goal.id, 'Savings goal ID');
  validateTitle(goal.title);
  validatePaise(goal.targetPaise, false, 'Savings target');
  validatePaise(goal.reservedPaise, true, 'Savings reservation');
  if (goal.reservedPaise > goal.targetPaise) throw new Error('A reservation cannot exceed its savings target.');
  validateCalendarDate(goal.targetDate);
  validateTimestamp(goal.createdAt);
}

function validateUniqueIds(items: { id: string }[], label: string): void {
  if (new Set(items.map(item => item.id)).size !== items.length) throw new Error(`${label} IDs must be unique.`);
}

function recordedPlanIds(plans: PlannedExpense[]): Set<string> {
  // Paid status/link is maintained atomically by the datastore. Its payment may be outside the loaded month slice.
  return new Set(plans.filter(plan => plan.status === 'paid' && plan.transactionId).map(plan => plan.id));
}

export function getFinancialIntelligence(
  transactions: Transaction[], budget: Budget | undefined, asOf: string, monthKey: string,
  context: FinancialContext = {},
): FinancialIntelligence {
  const base = getBudgetInsights(transactions, budget, asOf, monthKey);
  if (!context || typeof context !== 'object') throw new Error('Use a valid financial context.');
  if (context.planning) validateStudentPlan(context.planning);
  const plans = context.plannedExpenses ?? [];
  const goals = context.goals ?? [];
  if (!Array.isArray(plans) || !Array.isArray(goals)) throw new Error('Planned expenses and savings goals must be lists.');
  plans.forEach(validatePlannedExpense);
  goals.forEach(validateSavingsGoal);
  validateUniqueIds(plans, 'Planned expense');
  validateUniqueIds(goals, 'Savings goal');
  const paidLinks = plans.filter(plan => plan.status === 'paid').map(plan => plan.transactionId);
  if (new Set(paidLinks).size !== paidLinks.length) throw new Error('Separate paid plans must link to separate recorded payments.');
  if (context.balanceOverridePaise !== undefined && context.balanceOverridePaise !== null
    && !Number.isSafeInteger(context.balanceOverridePaise)) throw new Error('A known cash balance must be a safe integer in paise.');
  const selectedCategory = context.selectedCategory || undefined;
  if (selectedCategory && !(EXPENSE_CATEGORIES as readonly string[]).includes(selectedCategory)) throw new Error('Choose a valid expense category for guidance.');
  const planning = context.planning?.monthKey === monthKey ? context.planning : undefined;
  const currentMonth = asOf.slice(0, 7);
  const current = monthKey === currentMonth;
  const historical = monthKey < currentMonth;
  const daysIncludingToday = current ? base.daysRemaining + 1 : 0;
  let precisionLimited = base.arithmeticLimited;
  const bounded = (amount: bigint): number => {
    if (!fits(amount)) precisionLimited = true;
    return Number(amount > MAX ? MAX : amount < -MAX ? -MAX : amount);
  };
  const monthly = transactions.filter(transaction => !transaction.excludedFromAnalysis
    && transaction.date <= asOf && transaction.date.slice(0, 7) === monthKey);
  const monthlyExpenseCount = monthly.filter(transaction => transaction.type === 'expense').length;
  const satisfiedPlans = recordedPlanIds(plans);
  const unpaid = plans.filter(plan => !satisfiedPlans.has(plan.id)
    && (current ? plan.dueDate.slice(0, 7) <= monthKey : plan.dueDate.slice(0, 7) === monthKey));
  const upcomingRaw = sum(unpaid.map(plan => plan.amountPaise));
  const upcomingPaise = bounded(upcomingRaw);
  let expectedRaw = 0n;
  for (const [source, expected] of Object.entries(planning?.expectedIncome ?? {})) {
    const received = sum(monthly.filter(transaction => transaction.type === 'income' && transaction.category === source).map(transaction => transaction.amountPaise));
    expectedRaw += positive(BigInt(expected) - received);
  }
  const expectedRemainingIncomePaise = bounded(expectedRaw);
  const actualBalancePaise = base.arithmeticLimited || !base.balanceAvailable || context.balanceOverridePaise === null
    ? null : context.balanceOverridePaise ?? base.balancePaise;

  let availableForGoals = actualBalancePaise === null ? 0n : positive(BigInt(actualBalancePaise));
  let reservedRaw = 0n;
  const goalProgress = [...goals].sort((first, second) => first.createdAt - second.createdAt || (first.id < second.id ? -1 : first.id > second.id ? 1 : 0)).map(goal => {
    const backed = minimum(availableForGoals, BigInt(goal.reservedPaise));
    availableForGoals -= backed;
    reservedRaw += backed;
    const remaining = BigInt(goal.targetPaise) - backed;
    const daysLeft = calendarDaysBetween(asOf, goal.targetDate);
    const weeks = BigInt(Math.max(1, Math.ceil(Math.max(0, daysLeft) / 7)));
    const weekly = (remaining + weeks - 1n) / weeks;
    const backedPaise = Number(backed);
    const remainingPaise = Number(remaining);
    const reason = actualBalancePaise === null
      ? 'Cash balance is unavailable, so no reservation can be verified as funded.'
      : remaining === 0n ? 'The full target is backed by recorded cash.'
        : `${formatMoney(backedPaise)} of the reservation is backed by recorded cash; ${formatMoney(remainingPaise)} still needs funding.${daysLeft < 0 ? ' The target date has passed.' : daysLeft === 0 ? ' The target date is today.' : ''}`;
    return { id: goal.id, title: goal.title, targetPaise: goal.targetPaise, backedPaise, remainingPaise,
      weeklyPaise: Number(weekly), percent: backedPaise / goal.targetPaise * 100, targetDate: goal.targetDate, reason };
  });
  const reservedGoalsPaise = bounded(reservedRaw);
  const cashAvailableRaw = actualBalancePaise === null ? null : positive(BigInt(actualBalancePaise) - reservedRaw - upcomingRaw);
  const cashAvailablePaise = cashAvailableRaw === null ? null : bounded(cashAvailableRaw);
  const budgetAvailableRaw = base.remainingPaise === null ? null : positive(BigInt(base.remainingPaise) - upcomingRaw);
  const budgetDailyPaise = !current || budgetAvailableRaw === null || precisionLimited
    ? null : Number(budgetAvailableRaw / BigInt(daysIncludingToday));
  let allowedRaw = budgetAvailableRaw === null || cashAvailableRaw === null ? null : minimum(budgetAvailableRaw, cashAvailableRaw);
  let categoryConstraint: string | null = null;
  if (selectedCategory) {
    const category = base.categorySpend.find(item => item.category === selectedCategory)!;
    const categoryUpcoming = sum(unpaid.filter(plan => plan.category === selectedCategory).map(plan => plan.amountPaise));
    if (category.limitPaise !== null) {
      const categoryRemaining = positive(BigInt(category.limitPaise) - BigInt(category.spentPaise) - categoryUpcoming);
      if (allowedRaw !== null) allowedRaw = minimum(allowedRaw, categoryRemaining);
      categoryConstraint = `${selectedCategory}: ${formatMoney(category.spentPaise)} spent, ${formatMoney(category.limitPaise)} limit, ${formatMoney(bounded(categoryUpcoming))} unpaid commitments. ${formatMoney(Number(categoryRemaining))} remains for this category.${current ? ` Spread over ${daysIncludingToday} days including today.` : ''}`;
    } else categoryConstraint = `${selectedCategory} has no separate category cap; the overall budget and available cash still apply.`;
  }

  const essentialCategories = planning?.essentialCategories ?? DEFAULT_ESSENTIALS;
  const essentialPaise = bounded(sum(base.signedCategorySpend.filter(item => essentialCategories.includes(item.category)).map(item => item.netExpensePaise)));
  const discretionaryPaise = bounded(sum(base.signedCategorySpend.filter(item => !essentialCategories.includes(item.category)).map(item => item.netExpensePaise)));
  let forecastStatus: FinancialIntelligence['forecastStatus'];
  let forecastReason: string;
  if (precisionLimited || !base.forecastAvailable) {
    forecastStatus = 'unavailable';
    forecastReason = 'Amounts exceed the safe integer range; an exact forecast and affordable allowance are unavailable.';
  } else if (historical) {
    forecastStatus = 'historical';
    forecastReason = 'This month is closed. The month-end figure is recorded net spending, not a forecast.';
  } else if (!current) {
    forecastStatus = 'unavailable';
    forecastReason = 'This month has not started; no spending pace or daily allowance is available.';
  } else if (monthlyExpenseCount === 0) {
    forecastStatus = 'unavailable';
    forecastReason = 'There are no recorded expenses this month. A zero run-rate is not evidence of future zero spending.';
  } else if (base.elapsedDays < BUDGET_POLICY.earlyForecastDays || monthlyExpenseCount < BUDGET_POLICY.minExpenseRecordsForRunRate) {
    forecastStatus = 'early';
    forecastReason = `Early estimate from ${monthlyExpenseCount} expense record${monthlyExpenseCount === 1 ? '' : 's'} over ${base.elapsedDays} elapsed day${base.elapsedDays === 1 ? '' : 's'}. Run-rate assumes the ledger is complete and that the pace continues; it is not statistical confidence.`;
  } else {
    forecastStatus = 'run-rate';
    forecastReason = `Based on ${monthlyExpenseCount} expense records over ${base.elapsedDays} elapsed days. Run-rate assumes the ledger is complete and current spending pace continues; it is not a prediction.`;
  }

  const forecastKnown = forecastStatus === 'early' || forecastStatus === 'run-rate';
  const remainingRunRate = positive(BigInt(base.forecastPaise) - BigInt(base.netSpendPaise));
  // Commitments are a floor for projected future spend, not an addition to an estimate that may already include them.
  const remainingProjected = maximum(remainingRunRate, upcomingRaw);
  const projectedCashRaw = current && forecastKnown && actualBalancePaise !== null
    ? BigInt(actualBalancePaise) + expectedRaw - remainingProjected : null;
  const projectedBudgetRaw = base.limitPaise === null ? null
    : historical ? BigInt(base.limitPaise) - BigInt(base.netSpendPaise)
      : current && forecastKnown ? BigInt(base.limitPaise) - maximum(BigInt(base.forecastPaise), BigInt(base.netSpendPaise) + upcomingRaw) : null;
  const projectedCashBalancePaise = projectedCashRaw === null ? null : bounded(projectedCashRaw);
  const projectedBudgetVariancePaise = projectedBudgetRaw === null ? null : bounded(projectedBudgetRaw);
  const safeTodayPaise = !current || allowedRaw === null || precisionLimited ? null : Number(positive(allowedRaw) / BigInt(daysIncludingToday));
  const category = selectedCategory ? base.categorySpend.find(item => item.category === selectedCategory) : undefined;
  const status = (): FinancialIntelligence['status'] => {
    if (precisionLimited) return { tone: 'neutral', label: 'Calculation unavailable', reason: 'Oversized totals cannot be represented accurately. Correct the records before relying on these amounts.' };
    if (historical) return { tone: 'neutral', label: 'Closed month', reason: 'Review actual spending and budget variance; current cash is not a historical balance snapshot.' };
    if (!current) return { tone: 'neutral', label: 'Future month', reason: 'Set the plan now; spending guidance begins when the month starts.' };
    if (actualBalancePaise === null) return { tone: 'neutral', label: 'Cash balance unavailable', reason: 'A budget limit and expected income are not verified cash. Load a complete ledger to calculate affordability.' };
    if (base.remainingPaise !== null && base.remainingPaise < 0) return { tone: 'danger', label: 'Budget exceeded', reason: `${formatMoney(-base.remainingPaise)} of recorded net spending is above the monthly limit. The affordable allowance is zero.` };
    if (actualBalancePaise < 0) return { tone: 'danger', label: 'Recorded cash deficit', reason: `Recorded expenses exceed received cash by ${formatMoney(-actualBalancePaise)}. Expected income does not repair today's cash balance.` };
    if (BigInt(actualBalancePaise) - reservedRaw < upcomingRaw) return { tone: 'danger', label: 'Commitments need funding', reason: 'Unpaid commitments exceed cash left after backed savings reservations. Resolve that shortfall before discretionary spending.' };
    if (category?.limitPaise !== null && category?.limitPaise !== undefined && category.spentPaise >= category.limitPaise) return { tone: category.spentPaise > category.limitPaise ? 'danger' : 'warning', label: `${selectedCategory} limit reached`, reason: 'The selected category has no remaining allowance even if other categories and the overall budget have room.' };
    if (base.remainingPaise === 0) return { tone: 'warning', label: 'Budget fully used', reason: 'No monthly budget remains for additional spending.' };
    if (projectedCashBalancePaise !== null && projectedCashBalancePaise < 0) return { tone: 'danger', label: 'Projected cash deficit', reason: `If current pace and expected income hold, projected cash is ${formatMoney(-projectedCashBalancePaise)} below zero. Upcoming commitments are included as a spending floor, not counted twice.` };
    if (projectedBudgetVariancePaise !== null && projectedBudgetVariancePaise < 0) return { tone: 'warning', label: 'Pace risk', reason: `Projected spending is ${formatMoney(-projectedBudgetVariancePaise)} above the monthly cap.${forecastStatus === 'early' ? ' This estimate has limited spending history.' : ''}` };
    if (base.limitPaise === null) return { tone: 'neutral', label: 'Set a monthly budget', reason: 'Recorded cash is available separately; set a positive spending cap to calculate an affordable daily allowance.' };
    if (monthlyExpenseCount === 0) return { tone: 'neutral', label: 'Waiting for spending history', reason: 'There is no spending history for a month-end forecast. Any allowance shown is a cash-constrained plan, not a prediction.' };
    if (cashAvailablePaise === 0) return { tone: 'warning', label: 'No unallocated cash', reason: 'Recorded cash is exhausted or fully reserved for savings and commitments. Budget headroom is not cash.' };
    if (base.alerts.some(alert => alert.code.startsWith('CATEGORY_'))) return { tone: 'warning', label: 'Category pressure', reason: 'At least one category has reached its warning threshold; the total monthly budget can still have room.' };
    if (base.usagePercent !== null && base.usagePercent >= BUDGET_POLICY.warningUsagePercent) return { tone: 'warning', label: 'Near the monthly limit', reason: 'Most of the spending cap has been used. Follow the affordable allowance rather than the remaining cap alone.' };
    if (forecastStatus === 'early') return { tone: 'neutral', label: 'Early estimate', reason: forecastReason };
    return { tone: 'good', label: 'On track', reason: 'Recorded cash, commitments and current spending pace fit the monthly plan. Keep recording transactions so the guidance stays current.' };
  };

  return { base, arithmeticLimited: precisionLimited,
    calculationWarning: precisionLimited ? 'A ledger or planning total exceeds the safe integer range. Bounded number fields are placeholders; exact aggregates and recommendations are unavailable.' : null,
    safeTodayPaise, budgetDailyPaise: precisionLimited ? null : budgetDailyPaise,
    actualBalancePaise: precisionLimited ? null : actualBalancePaise, cashAvailablePaise: precisionLimited ? null : cashAvailablePaise,
    reservedGoalsPaise, upcomingPaise, expectedRemainingIncomePaise,
    projectedCashBalancePaise: precisionLimited ? null : projectedCashBalancePaise,
    projectedBudgetVariancePaise: precisionLimited ? null : projectedBudgetVariancePaise,
    forecastStatus: precisionLimited ? 'unavailable' : forecastStatus,
    forecastReason: precisionLimited ? 'An aggregate exceeds the safe integer range; exact cash and forecast amounts are unavailable.' : forecastReason,
    status: status(), categoryConstraint, daysIncludingToday, essentialPaise, discretionaryPaise, goalProgress };
}

/** Current cash capacity for one goal; other goals keep their actual-backed allocations. */
export function getGoalReservationCapacity(
  goalId: string | undefined, goals: SavingsGoal[], intelligence: FinancialIntelligence,
): number | null {
  goals.forEach(validateSavingsGoal);
  validateUniqueIds(goals, 'Savings goal');
  if (intelligence.arithmeticLimited || intelligence.actualBalancePaise === null) return null;
  const progress = new Map(intelligence.goalProgress.map(goal => [goal.id, goal]));
  const others = goals.filter(goal => goal.id !== goalId);
  if (others.some(goal => !progress.has(goal.id))) return null;
  const otherBacked = sum(others.map(goal => progress.get(goal.id)!.backedPaise));
  const capacity = positive(BigInt(intelligence.actualBalancePaise) - otherBacked - BigInt(intelligence.upcomingPaise));
  return fits(capacity) ? Number(capacity) : null;
}

/** Existing promises can remain underfunded after cash changes; new/increased reservations need current cash backing. */
export function validateGoalAllocation(
  goal: SavingsGoal, existingGoals: SavingsGoal[], intelligence: FinancialIntelligence,
): void {
  validateSavingsGoal(goal);
  const previous = existingGoals.find(existing => existing.id === goal.id)?.reservedPaise ?? 0;
  if (goal.reservedPaise <= previous) return;
  const capacity = getGoalReservationCapacity(goal.id, existingGoals, intelligence);
  if (capacity === null) throw new Error('Cash balance is unavailable. Load the complete ledger before increasing a savings reservation.');
  if (goal.reservedPaise > capacity) throw new Error(`Only ${formatMoney(capacity)} of recorded cash is available after other backed goals and unpaid commitments.`);
}

export interface ExpenseReductionSimulation {
  before: FinancialIntelligence;
  after: FinancialIntelligence;
  reductionPaise: number;
  reason: string;
}

/** A counterfactual reduction of already-recorded expense, using copies only. No refund or transaction is persisted. */
export function simulateExpenseReduction(
  transactions: Transaction[], budget: Budget | undefined, asOf: string, monthKey: string,
  context: FinancialContext, category: string, reductionPaise: number,
): ExpenseReductionSimulation {
  if (!(EXPENSE_CATEGORIES as readonly string[]).includes(category)) throw new Error('Choose a supported expense category to simulate.');
  validatePaise(reductionPaise, true, 'Simulated reduction');
  const before = getFinancialIntelligence(transactions, budget, asOf, monthKey, context);
  if (before.base.arithmeticLimited) throw new Error('Correct oversized amounts before simulating a reduction.');
  const categoryNet = Math.max(0, before.base.signedCategorySpend.find(item => item.category === category)!.netExpensePaise);
  const appliedReduction = Math.min(reductionPaise, categoryNet);
  let remaining = appliedReduction;
  const sortedEligible = [...transactions].filter(transaction => !transaction.excludedFromAnalysis
    && transaction.type === 'expense' && transaction.category === category
    && transaction.date <= asOf && transaction.date.slice(0, 7) === monthKey)
    .sort((first, second) => second.date.localeCompare(first.date) || second.createdAt - first.createdAt || first.id.localeCompare(second.id));
  const adjustments = new Map<string, number>();
  for (const transaction of sortedEligible) {
    const removed = Math.min(transaction.amountPaise, remaining);
    if (removed) adjustments.set(transaction.id, removed);
    remaining -= removed;
    if (!remaining) break;
  }
  const simulated = transactions.flatMap(transaction => {
    const amountPaise = transaction.amountPaise - (adjustments.get(transaction.id) ?? 0);
    return amountPaise > 0 ? [{ ...transaction, amountPaise }] : [];
  });
  const simulatedById = new Map(simulated.map(transaction => [transaction.id, transaction]));
  const satisfiedPlans = recordedPlanIds(context.plannedExpenses ?? []);
  const overriddenBalance = context.balanceOverridePaise === undefined || context.balanceOverridePaise === null
    ? context.balanceOverridePaise : BigInt(context.balanceOverridePaise) + BigInt(appliedReduction);
  const simulatedContext: FinancialContext = {
    ...context,
    balanceOverridePaise: typeof overriddenBalance === 'bigint' ? fits(overriddenBalance) ? Number(overriddenBalance) : null : overriddenBalance,
    // The counterfactual changes the matching payment too; do not recreate an unpaid commitment merely because its amount changed.
    plannedExpenses: context.plannedExpenses?.flatMap(plan => {
      if (!plan.transactionId || !adjustments.has(plan.transactionId) || !satisfiedPlans.has(plan.id)) return [{ ...plan }];
      const payment = simulatedById.get(plan.transactionId);
      return payment ? [{ ...plan, amountPaise: payment.amountPaise }] : [{ ...plan }];
    }),
    goals: context.goals?.map(goal => ({ ...goal })),
  };
  const after = getFinancialIntelligence(simulated, budget, asOf, monthKey, simulatedContext);
  return { before, after, reductionPaise: appliedReduction,
    reason: `${formatMoney(appliedReduction)} less ${category} expense in this counterfactual.${appliedReduction < reductionPaise ? ' The reduction was limited to actual net category spending.' : ''} Paid plans stay paid in the counterfactual; this does not reopen a bill or simulate a new payment. Your actual transactions, plans and savings reservations were not changed.` };
}
