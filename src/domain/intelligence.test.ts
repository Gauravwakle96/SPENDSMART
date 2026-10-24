import { describe, expect, it } from 'vitest';
import { getFinancialIntelligence, getGoalReservationCapacity, simulateExpenseReduction, validateGoalAllocation, validatePlannedExpense, validateSavingsGoal, validateStudentPlan } from './intelligence';
import type { Budget, Transaction } from './types';
import type { FinancialContext, PlannedExpense, SavingsGoal, StudentPlan } from './planning-types';

const asOf = '2026-04-20';
const monthKey = '2026-04';
const budget: Budget = { monthKey, limitPaise: 800000, categoryLimits: {} };
const record = (id: string, type: Transaction['type'], amountPaise: number, category: string, date = asOf): Transaction =>
  ({ id, type, amountPaise, category, date, note: '', createdAt: 1 });
const records: Transaction[] = [
  record('income', 'income', 1000000, 'Allowance', '2026-04-01'),
  record('food', 'expense', 200000, 'Food', '2026-04-05'),
  record('travel', 'expense', 200000, 'Travel', '2026-04-10'),
  record('shopping', 'expense', 160000, 'Shopping'),
];
const plan = (id = 'rent', amountPaise = 100000, category = 'Bills'): PlannedExpense =>
  ({ id, title: 'Hostel rent', amountPaise, category, dueDate: '2026-04-25', status: 'planned', createdAt: 1 });
const goal = (id = 'laptop', reservedPaise = 200000, targetPaise = 300000): SavingsGoal =>
  ({ id, title: 'Laptop fund', reservedPaise, targetPaise, targetDate: '2026-05-04', createdAt: 1 });
const planning = (expectedIncome: Record<string, number> = {}): StudentPlan =>
  ({ monthKey, currency: 'INR', expectedIncome, essentialCategories: ['Food'] });
const insights = (context: FinancialContext = {}, transactions = records) =>
  getFinancialIntelligence(transactions, budget, asOf, monthKey, context);

describe('affordable spending and explainable financial health', () => {
  it('preserves the PDF after-today amount and exposes a separate inclusive-day recommendation', () => {
    const result = insights();
    expect(result.base.safeDailyPaise).toBe(24000);
    expect(result.daysIncludingToday).toBe(11);
    expect(result.budgetDailyPaise).toBe(21818);
    expect(result.safeTodayPaise).toBe(21818);
    expect(result.actualBalancePaise).toBe(440000);
    expect(result.cashAvailablePaise).toBe(440000);
    expect(result.base.forecastPaise).toBe(840000);
    expect(result.projectedBudgetVariancePaise).toBe(-40000);
    expect(result.projectedCashBalancePaise).toBe(160000);
    expect(result.forecastStatus).toBe('run-rate');
    expect(result.status.label).toBe('Pace risk');
  });

  it('limits the daily amount by real cash and never treats budget headroom as money', () => {
    const result = insights({ balanceOverridePaise: 10000 });
    expect(result.base.remainingPaise).toBe(240000);
    expect(result.cashAvailablePaise).toBe(10000);
    expect(result.budgetDailyPaise).toBe(21818);
    expect(result.safeTodayPaise).toBe(909);
    const empty = insights({}, []);
    expect(empty.actualBalancePaise).toBe(0);
    expect(empty.safeTodayPaise).toBe(0);
    expect(empty.status.tone).toBe('neutral');
  });

  it('keeps unknown cash unknown instead of converting it to a healthy zero', () => {
    const result = insights({ balanceOverridePaise: null });
    expect(result.actualBalancePaise).toBeNull();
    expect(result.cashAvailablePaise).toBeNull();
    expect(result.safeTodayPaise).toBeNull();
    expect(result.projectedCashBalancePaise).toBeNull();
    expect(result.status.label).toBe('Cash balance unavailable');
    expect(result.budgetDailyPaise).toBe(21818);
  });

  it('never increases actual cash or today allowance merely because income is expected', () => {
    const result = insights({ planning: planning({ Allowance: 1500000 }), balanceOverridePaise: 10000 });
    expect(result.expectedRemainingIncomePaise).toBe(500000);
    expect(result.actualBalancePaise).toBe(10000);
    expect(result.cashAvailablePaise).toBe(10000);
    expect(result.safeTodayPaise).toBe(909);
    expect(result.projectedCashBalancePaise).toBe(230000);
  });

  it('subtracts actual income from its matching expected source, never from unrelated sources or months', () => {
    const transactions = [...records,
      record('salary', 'income', 900000, 'Salary'),
      record('last-month', 'income', 1000000, 'Scholarship', '2026-03-20'),
      record('future', 'income', 500000, 'Scholarship', '2026-04-21')];
    const result = insights({ planning: planning({ Allowance: 1500000, Scholarship: 200000, Salary: 100000 }) }, transactions);
    expect(result.expectedRemainingIncomePaise).toBe(700000);
  });

  it('separates projected cash surplus from budget deficit', () => {
    const result = insights();
    expect(result.projectedCashBalancePaise).toBeGreaterThan(0);
    expect(result.projectedBudgetVariancePaise).toBeLessThan(0);
    expect(result.status.tone).toBe('warning');
  });

  it('shows no meaningful run-rate for an empty expense history and marks sparse history as early', () => {
    const empty = insights({}, [records[0]]);
    expect(empty.forecastStatus).toBe('unavailable');
    expect(empty.forecastReason).toContain('zero run-rate is not evidence');
    expect(empty.projectedCashBalancePaise).toBeNull();
    expect(empty.projectedBudgetVariancePaise).toBeNull();
    expect(empty.status.label).toBe('Waiting for spending history');
    const first = getFinancialIntelligence([
      record('allowance', 'income', 1000000, 'Allowance', '2026-04-01'),
      record('first', 'expense', 10000, 'Food', '2026-04-01')],
    { ...budget, limitPaise: 200000 }, '2026-04-01', monthKey);
    expect(first.forecastStatus).toBe('early');
    expect(first.forecastReason).toContain('1 expense record');
    expect(first.forecastReason).toContain('not statistical confidence');
    expect(first.status.reason).toContain('limited spending history');
  });

  it('does not advise negative spending or let expected income repair an actual cash deficit', () => {
    const result = insights({ balanceOverridePaise: -10000, planning: planning({ Allowance: 2000000 }) });
    expect(result.safeTodayPaise).toBe(0);
    expect(result.cashAvailablePaise).toBe(0);
    expect(result.status.label).toBe('Recorded cash deficit');
  });

  it('keeps historical and future month guidance explicitly non-actionable', () => {
    const transactions = [...records, record('old', 'expense', 10000, 'Food', '2026-03-15')];
    const historical = getFinancialIntelligence(transactions, { ...budget, monthKey: '2026-03' }, asOf, '2026-03');
    expect(historical.forecastStatus).toBe('historical');
    expect(historical.safeTodayPaise).toBeNull();
    expect(historical.budgetDailyPaise).toBeNull();
    expect(historical.projectedCashBalancePaise).toBeNull();
    expect(historical.projectedBudgetVariancePaise).toBe(790000);
    expect(historical.status.label).toBe('Closed month');
    const future = getFinancialIntelligence(transactions, { ...budget, monthKey: '2026-05' }, asOf, '2026-05');
    expect(future.forecastStatus).toBe('unavailable');
    expect(future.safeTodayPaise).toBeNull();
    expect(future.projectedBudgetVariancePaise).toBeNull();
  });

  it('handles the final day using exactly one inclusive day', () => {
    const result = getFinancialIntelligence(records, budget, '2026-04-30', monthKey);
    expect(result.daysIncludingToday).toBe(1);
    expect(result.safeTodayPaise).toBe(240000);
    expect(result.base.safeDailyPaise).toBe(240000);
  });

  it('keeps budget breach status authoritative and removes contradictory future-tense alerts', () => {
    const result = getFinancialIntelligence([...records, record('large', 'expense', 300000, 'Food')], budget, asOf, monthKey);
    expect(result.status.label).toBe('Budget exceeded');
    expect(result.safeTodayPaise).toBe(0);
    expect(result.base.alerts.map(alert => alert.code)).toContain('BUDGET_EXCEEDED');
    expect(result.base.alerts.map(alert => alert.code)).not.toContain('PACE_RISK');
  });
});

describe('commitments, category constraints and savings reservations', () => {
  it('subtracts unpaid commitments from available cash and remaining budget once', () => {
    const result = insights({ plannedExpenses: [plan()] });
    expect(result.upcomingPaise).toBe(100000);
    expect(result.cashAvailablePaise).toBe(340000);
    expect(result.budgetDailyPaise).toBe(12727);
    expect(result.safeTodayPaise).toBe(12727);
    // The run-rate already projects 280000 more spending; 100000 of commitments is a floor, not an addition.
    expect(result.projectedCashBalancePaise).toBe(160000);
    expect(result.projectedBudgetVariancePaise).toBe(-40000);
  });

  it('uses larger known commitments as the spending floor, not additive double counting', () => {
    const result = insights({ plannedExpenses: [plan('large-rent', 400000)] });
    expect(result.upcomingPaise).toBe(400000);
    expect(result.safeTodayPaise).toBe(0);
    expect(result.projectedCashBalancePaise).toBe(40000);
    expect(result.projectedBudgetVariancePaise).toBe(-160000);
  });

  it('recognizes a paid actual payment exactly once without reserving the expense again', () => {
    const payment = record('payment', 'expense', 100000, 'Bills', '2026-04-19');
    const result = insights({ plannedExpenses: [{ ...plan(), status: 'paid', transactionId: 'payment' }] }, [...records, payment]);
    expect(result.upcomingPaise).toBe(0);
    expect(result.base.netSpendPaise).toBe(660000);
    expect(result.actualBalancePaise).toBe(340000);
  });

  it('reserves a reopened plan after the provider clears paid state and the payment link', () => {
    const paid = { ...plan(), status: 'paid' as const, transactionId: 'outside-loaded-slice' };
    expect(insights({ plannedExpenses: [paid] }).upcomingPaise).toBe(0);
    const reopened = { ...plan(), status: 'planned' as const };
    expect(insights({ plannedExpenses: [reopened] }).upcomingPaise).toBe(100000);
  });

  it('does not reserve an October bill paid in September when only October transactions are loaded', () => {
    const october = [record('oct-income', 'income', 1000000, 'Allowance', '2026-10-01'),
      record('oct-food', 'expense', 560000, 'Food', '2026-10-20')];
    const paid = { ...plan('cross-month'), dueDate: '2026-10-25', status: 'paid' as const, transactionId: 'september-payment' };
    const result = getFinancialIntelligence(october, { ...budget, monthKey: '2026-10' }, '2026-10-24', '2026-10',
      { plannedExpenses: [paid], balanceOverridePaise: 390000 });
    expect(result.upcomingPaise).toBe(0);
    expect(result.actualBalancePaise).toBe(390000);
    expect(result.cashAvailablePaise).toBe(390000);
    expect(result.safeTodayPaise).toBe(30000);
  });

  it('does not let one recorded payment satisfy two separate commitments', () => {
    const payment = record('payment', 'expense', 100000, 'Bills', '2026-04-19');
    const first = { ...plan('first'), status: 'paid' as const, transactionId: 'payment', createdAt: 1 };
    const second = { ...plan('second'), status: 'paid' as const, transactionId: 'payment', createdAt: 2 };
    expect(() => insights({ plannedExpenses: [second, first] }, [...records, payment])).toThrow(/separate recorded payments/);
  });

  it('carries overdue unpaid obligations into the current month without borrowing next month obligations', () => {
    const result = insights({ plannedExpenses: [{ ...plan('overdue', 10000), dueDate: '2026-04-01' },
      { ...plan('last-month', 20000), dueDate: '2026-03-01' },
      { ...plan('next-month', 900000), dueDate: '2026-05-01' }] });
    expect(result.upcomingPaise).toBe(30000);
    const historical = getFinancialIntelligence(records, { ...budget, monthKey: '2026-03' }, asOf, '2026-03',
      { plannedExpenses: [{ ...plan('march', 20000), dueDate: '2026-03-01' }, { ...plan('february', 50000), dueDate: '2026-02-01' }] });
    expect(historical.upcomingPaise).toBe(20000);
  });

  it('constrains a selected category without adding all category caps or blocking other categories', () => {
    const cappedBudget = { ...budget, categoryLimits: { Food: 200000, Travel: 800000 } };
    const general = getFinancialIntelligence(records, cappedBudget, asOf, monthKey);
    expect(general.safeTodayPaise).toBe(21818);
    const food = getFinancialIntelligence(records, cappedBudget, asOf, monthKey, { selectedCategory: 'Food' });
    expect(food.safeTodayPaise).toBe(0);
    expect(food.status.label).toBe('Food limit reached');
    expect(food.categoryConstraint).toContain('Food:');
    const travel = getFinancialIntelligence(records, cappedBudget, asOf, monthKey, { selectedCategory: 'Travel' });
    expect(travel.safeTodayPaise).toBe(21818);
  });

  it('subtracts only the selected category commitments from its own cap', () => {
    const result = getFinancialIntelligence(records, { ...budget, categoryLimits: { Food: 300000 } }, asOf, monthKey,
      { selectedCategory: 'Food', plannedExpenses: [plan('food-plan', 50000, 'Food')] });
    expect(result.safeTodayPaise).toBe(4545);
    expect(result.categoryConstraint).toContain('₹500');
  });

  it('backs goal reservations in deterministic creation/ID order without double counting cash', () => {
    const result = insights({ balanceOverridePaise: 15000, goals: [goal('b', 10000, 10000), goal('a', 10000, 10000)] });
    expect(result.goalProgress.map(item => [item.id, item.backedPaise])).toEqual([['a', 10000], ['b', 5000]]);
    expect(result.reservedGoalsPaise).toBe(15000);
    expect(result.cashAvailablePaise).toBe(0);
    expect(result.safeTodayPaise).toBe(0);
    expect(result.goalProgress[0].percent).toBe(100);
    expect(result.goalProgress[1].percent).toBe(50);
  });

  it('reserves only actual cash and computes remaining/weekly funding from backed progress', () => {
    const result = insights({ goals: [goal('fund', 200000, 300000)] });
    expect(result.actualBalancePaise).toBe(440000);
    expect(result.reservedGoalsPaise).toBe(200000);
    expect(result.cashAvailablePaise).toBe(240000);
    expect(result.goalProgress[0].remainingPaise).toBe(100000);
    expect(result.goalProgress[0].weeklyPaise).toBe(50000);
    const unknown = insights({ balanceOverridePaise: null, goals: [goal()] });
    expect(unknown.goalProgress[0].backedPaise).toBe(0);
    expect(unknown.goalProgress[0].reason).toContain('unavailable');
  });

  it('handles overdue goals and integer-paise weekly rounding without division by zero', () => {
    const result = insights({ balanceOverridePaise: 0, goals: [{ ...goal('past', 0, 10001), targetDate: '2026-04-19' },
      { ...goal('eight-days', 0, 10001), targetDate: '2026-04-28' }] });
    expect(result.goalProgress.find(item => item.id === 'past')?.weeklyPaise).toBe(10001);
    expect(result.goalProgress.find(item => item.id === 'past')?.reason).toContain('date has passed');
    expect(result.goalProgress.find(item => item.id === 'eight-days')?.weeklyPaise).toBe(5001);
  });

  it('separates signed essential/discretionary expense and keeps refunds transparent', () => {
    const transactions = [...records, record('refund', 'refund', 50000, 'Entertainment')];
    const result = insights({ planning: planning() }, transactions);
    expect(result.essentialPaise).toBe(200000);
    expect(result.discretionaryPaise).toBe(310000);
    expect(result.essentialPaise + result.discretionaryPaise).toBe(result.base.netExpensePaise);
    expect(result.base.signedCategorySpend.find(item => item.category === 'Entertainment')?.netExpensePaise).toBe(-50000);
  });
});

describe('planning validation and pure what-if simulations', () => {
  it('validates INR plans, income sources, integer amounts and unique essential categories', () => {
    expect(() => validateStudentPlan(planning({ Allowance: 100000 }))).not.toThrow();
    expect(() => validateStudentPlan({ ...planning(), currency: 'USD' } as unknown as StudentPlan)).toThrow(/INR/);
    expect(() => validateStudentPlan(planning({ Food: 100000 }))).toThrow(/source/);
    expect(() => validateStudentPlan(planning({ Allowance: -1 }))).toThrow(/paise/);
    expect(() => validateStudentPlan({ ...planning(), essentialCategories: ['Food', 'Food'] })).toThrow(/unique/);
  });

  it('rejects malformed commitments, unlinked paid states and invalid goal reservations', () => {
    expect(() => validatePlannedExpense(plan())).not.toThrow();
    expect(() => validatePlannedExpense({ ...plan(), status: 'paid' })).toThrow(/link/);
    expect(() => validatePlannedExpense({ ...plan(), transactionId: 'stale-link' })).toThrow(/retain a payment link/);
    expect(() => validatePlannedExpense({ ...plan(), dueDate: '2026-04-31' })).toThrow(/calendar/);
    expect(() => validatePlannedExpense({ ...plan(), amountPaise: 0 })).toThrow(/positive/);
    expect(() => validateSavingsGoal({ ...goal(), reservedPaise: 400000 })).toThrow(/exceed/);
    expect(() => validateSavingsGoal({ ...goal(), targetDate: '2026-02-29' })).toThrow(/calendar/);
    expect(() => validateSavingsGoal({ ...goal(), createdAt: Number.NaN })).toThrow(/timestamp/);
    expect(() => insights({ goals: [goal('same'), goal('same')] })).toThrow(/unique/);
  });

  it('computes goal reservation capacity from actual cash minus OTHER backed goals and commitments', () => {
    const goals = [goal('existing', 100000, 300000), goal('other', 50000, 100000)];
    const result = insights({ goals, plannedExpenses: [plan('bill', 100000)] });
    expect(getGoalReservationCapacity('existing', goals, result)).toBe(290000);
    expect(getGoalReservationCapacity(undefined, goals, result)).toBe(190000);
    expect(() => validateGoalAllocation(goal('new', 200000, 300000), goals, result)).toThrow(/recorded cash/);
    expect(() => validateGoalAllocation(goal('new', 190000, 300000), goals, result)).not.toThrow();
    expect(() => validateGoalAllocation(goal('existing', 290000, 300000), goals, result)).not.toThrow();
  });

  it('allows an underfunded existing promise to stay or decrease, but rejects increases beyond current capacity', () => {
    const goals = [goal('existing', 100000, 300000)];
    const result = insights({ goals, balanceOverridePaise: 10000 });
    expect(result.goalProgress[0].backedPaise).toBe(10000);
    expect(getGoalReservationCapacity('existing', goals, result)).toBe(10000);
    expect(() => validateGoalAllocation(goal('existing', 100000, 300000), goals, result)).not.toThrow();
    expect(() => validateGoalAllocation(goal('existing', 90000, 300000), goals, result)).not.toThrow();
    expect(() => validateGoalAllocation(goal('existing', 110000, 300000), goals, result)).toThrow(/recorded cash/);
  });

  it('keeps goal capacity unknown when cash or the backed-goal snapshot is unavailable', () => {
    const goals = [goal('existing')];
    const unknown = insights({ goals, balanceOverridePaise: null });
    expect(getGoalReservationCapacity('existing', goals, unknown)).toBeNull();
    expect(() => validateGoalAllocation(goal('new', 1, 100), goals, unknown)).toThrow(/unavailable/);
    expect(() => validateGoalAllocation(goal('new', 0, 100), goals, unknown)).not.toThrow();
    expect(getGoalReservationCapacity(undefined, goals, insights())).toBeNull();
  });

  it('simulates an actual expense reduction and recomputes cash, forecast and budget without writing', () => {
    const original = JSON.stringify(records);
    const result = simulateExpenseReduction(records, budget, asOf, monthKey, {}, 'Shopping', 60000);
    expect(result.reductionPaise).toBe(60000);
    expect(result.before.base.netSpendPaise).toBe(560000);
    expect(result.after.base.netSpendPaise).toBe(500000);
    expect(result.after.actualBalancePaise).toBe(500000);
    expect(result.after.base.forecastPaise).toBe(750000);
    expect(result.after.projectedBudgetVariancePaise).toBe(50000);
    expect(result.after.safeTodayPaise).toBe(27272);
    expect(JSON.stringify(records)).toBe(original);
  });

  it('limits reductions to actual net category spend, including refunds', () => {
    const transactions = [...records, record('refund', 'refund', 100000, 'Shopping')];
    const result = simulateExpenseReduction(transactions, budget, asOf, monthKey, {}, 'Shopping', 900000);
    expect(result.reductionPaise).toBe(60000);
    expect(result.after.base.signedCategorySpend.find(item => item.category === 'Shopping')?.netExpensePaise).toBe(0);
    expect(result.reason).toContain('limited to actual net');
    expect(simulateExpenseReduction(records, budget, asOf, monthKey, {}, 'Health', 900000).reductionPaise).toBe(0);
  });

  it('does not resurrect a paid commitment when its payment is reduced in a counterfactual', () => {
    const payment = record('paid-bill', 'expense', 50000, 'Bills');
    const context: FinancialContext = { plannedExpenses: [{ ...plan('bill', 50000), status: 'paid', transactionId: payment.id }] };
    const snapshot = JSON.stringify(context);
    const partial = simulateExpenseReduction([...records, payment], budget, asOf, monthKey, context, 'Bills', 10000);
    expect(partial.after.upcomingPaise).toBe(0);
    expect(partial.after.base.netSpendPaise).toBe(600000);
    const removed = simulateExpenseReduction([...records, payment], budget, asOf, monthKey, context, 'Bills', 50000);
    expect(removed.after.upcomingPaise).toBe(0);
    expect(removed.after.base.netSpendPaise).toBe(560000);
    expect(removed.reason).toContain('Paid plans stay paid');
    expect(JSON.stringify(context)).toBe(snapshot);
  });

  it('updates a known cash override in the counterfactual while preserving unknown balances', () => {
    const known = simulateExpenseReduction(records, budget, asOf, monthKey, { balanceOverridePaise: 10000 }, 'Shopping', 50000);
    expect(known.after.actualBalancePaise).toBe(60000);
    const unknown = simulateExpenseReduction(records, budget, asOf, monthKey, { balanceOverridePaise: null }, 'Shopping', 50000);
    expect(unknown.after.actualBalancePaise).toBeNull();
    expect(unknown.after.safeTodayPaise).toBeNull();
  });

  it('keeps caller budgets, transactions, plans and goals untouched even when frozen', () => {
    const frozenRecords = records.map(transaction => Object.freeze({ ...transaction }));
    Object.freeze(frozenRecords);
    const context: FinancialContext = { planning: planning({ Allowance: 1100000 }), plannedExpenses: [plan()], goals: [goal()] };
    Object.freeze(context.plannedExpenses![0]); Object.freeze(context.plannedExpenses);
    Object.freeze(context.goals![0]); Object.freeze(context.goals);
    Object.freeze(context.planning!.expectedIncome); Object.freeze(context.planning!.essentialCategories); Object.freeze(context.planning);
    Object.freeze(context);
    expect(() => simulateExpenseReduction(frozenRecords as unknown as Transaction[], Object.freeze({ ...budget }), asOf, monthKey, context, 'Shopping', 60000)).not.toThrow();
  });

  it('handles safe-integer aggregate boundaries without crashing or pretending cash/forecasts are known', () => {
    const large = [record('large', 'expense', Number.MAX_SAFE_INTEGER, 'Food', '2026-04-01')];
    const result = getFinancialIntelligence(large, budget, '2026-04-01', monthKey);
    expect(result.forecastStatus).toBe('unavailable');
    expect(result.safeTodayPaise).toBeNull();
    expect(result.actualBalancePaise).toBeNull();
    expect(result.projectedCashBalancePaise).toBeNull();
    expect(result.status.label).toBe('Calculation unavailable');
    const overflow = insights({ plannedExpenses: [plan('one', Number.MAX_SAFE_INTEGER), plan('two', Number.MAX_SAFE_INTEGER)] });
    expect(overflow.arithmeticLimited).toBe(true);
    expect(overflow.calculationWarning).toContain('placeholders');
    expect(overflow.safeTodayPaise).toBeNull();
    expect(overflow.forecastStatus).toBe('unavailable');
    expect(overflow.projectedCashBalancePaise).toBeNull();
  });
});
