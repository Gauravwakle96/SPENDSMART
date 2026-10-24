import { todayISO, validateBudget, validateTransaction } from '../domain/engine';
import type { Budget, Transaction } from '../domain/types';
import type { PlannedExpense, SavingsGoal, StudentPlan } from '../domain/planning-types';
import { validatePlannedExpense, validateSavingsGoal, validateStudentPlan, validRecordId } from './validation';

export const DEMO_DATA_KEY = 'spendsmart.demo.data.v1';
export const DEMO_SESSION_KEY = 'spendsmart.demo.session.v1';

export interface DemoData {
  transactions: Transaction[];
  budgets: Budget[];
  planning: StudentPlan[];
  plannedExpenses: PlannedExpense[];
  goals: SavingsGoal[];
}

export interface RecoveredDemoData extends DemoData {
  warning: string | null;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readCreatedAt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (object(value) && typeof value.toMillis === 'function') {
    try {
      const millis: unknown = value.toMillis();
      if (typeof millis === 'number' && Number.isSafeInteger(millis) && millis >= 0) return millis;
    } catch { return null; }
  }
  return null;
}

export function readTransaction(id: string, value: unknown, asOf = todayISO()): Transaction | null {
  if (!object(value) || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) return null;
  const { type, amountPaise, category, date, note } = value;
  const createdAt = readCreatedAt(value.createdAt);
  if (createdAt === null) return null;
  if (value.currency !== undefined && value.currency !== 'INR') return null;
  if (typeof type !== 'string' || typeof amountPaise !== 'number' || typeof category !== 'string'
    || typeof date !== 'string' || typeof note !== 'string') return null;
  const transaction = { id, type, amountPaise, category, date, note, createdAt } as Transaction;
  try {
    validateTransaction(transaction, asOf);
    return transaction;
  } catch {
    return null;
  }
}

export function readBudget(id: string, value: unknown): Budget | null {
  if (!object(value) || value.monthKey !== id || typeof value.limitPaise !== 'number'
    || !object(value.categoryLimits)) return null;
  if (value.currency !== undefined && value.currency !== 'INR') return null;
  const budget = { monthKey: id, limitPaise: value.limitPaise, categoryLimits: value.categoryLimits } as Budget;
  try {
    validateBudget(budget);
    return budget;
  } catch {
    return null;
  }
}

export function readStudentPlan(id: string, value: unknown): StudentPlan | null {
  if (!object(value) || value.monthKey !== id) return null;
  const plan = { monthKey: id, currency: value.currency, expectedIncome: value.expectedIncome, essentialCategories: value.essentialCategories } as StudentPlan;
  try { validateStudentPlan(plan); return plan; } catch { return null; }
}

export function readPlannedExpense(id: string, value: unknown): PlannedExpense | null {
  if (!object(value) || !validRecordId(id) || (value.currency !== undefined && value.currency !== 'INR')) return null;
  const createdAt = readCreatedAt(value.createdAt);
  if (createdAt === null) return null;
  const item = { id, title: value.title, amountPaise: value.amountPaise, category: value.category, dueDate: value.dueDate, status: value.status, createdAt,
    ...(value.status === 'paid' && value.transactionId !== undefined ? { transactionId: value.transactionId } : {}) } as PlannedExpense;
  try { validatePlannedExpense(item); return item; } catch { return null; }
}

export function readSavingsGoal(id: string, value: unknown): SavingsGoal | null {
  if (!object(value) || !validRecordId(id) || (value.currency !== undefined && value.currency !== 'INR')) return null;
  const createdAt = readCreatedAt(value.createdAt);
  if (createdAt === null) return null;
  const goal = { id, title: value.title, targetPaise: value.targetPaise, reservedPaise: value.reservedPaise, targetDate: value.targetDate, createdAt } as SavingsGoal;
  try { validateSavingsGoal(goal); return goal; } catch { return null; }
}

export function recoverDemoData(raw: string, asOf = todayISO()): RecoveredDemoData {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!object(parsed) || (parsed.version !== 1 && parsed.version !== 2) || !Array.isArray(parsed.transactions)
      || !Array.isArray(parsed.budgets)) throw new Error('Invalid local data');
    const transactions = new Map<string, Transaction>();
    const budgets = new Map<string, Budget>();
    const planning = new Map<string, StudentPlan>();
    const plannedExpenses = new Map<string, PlannedExpense>();
    const goals = new Map<string, SavingsGoal>();
    let rejected = 0;
    for (const value of parsed.transactions) {
      const record = object(value) && typeof value.id === 'string'
        ? readTransaction(value.id, value, asOf) : null;
      if (record && !transactions.has(record.id)) transactions.set(record.id, record);
      else rejected++;
    }
    for (const value of parsed.budgets) {
      const record = object(value) && typeof value.monthKey === 'string'
        ? readBudget(value.monthKey, value) : null;
      if (record && !budgets.has(record.monthKey)) budgets.set(record.monthKey, record);
      else rejected++;
    }
    if (parsed.version === 2) {
      if (!Array.isArray(parsed.planning) || !Array.isArray(parsed.plannedExpenses) || !Array.isArray(parsed.goals)) throw new Error('Invalid planning data');
      for (const value of parsed.planning) {
        const record = object(value) && typeof value.monthKey === 'string' ? readStudentPlan(value.monthKey, value) : null;
        if (record && !planning.has(record.monthKey)) planning.set(record.monthKey, record); else rejected++;
      }
      for (const value of parsed.plannedExpenses) {
        const record = object(value) && typeof value.id === 'string' ? readPlannedExpense(value.id, value) : null;
        const payment = record?.transactionId ? transactions.get(record.transactionId) : null;
        if (record && !plannedExpenses.has(record.id) && (record.status === 'planned' || (payment?.type === 'expense' && payment.amountPaise === record.amountPaise && payment.category === record.category))) {
          plannedExpenses.set(record.id, record);
        } else if (record && record.status === 'paid' && !plannedExpenses.has(record.id)) {
          const { transactionId: discarded, ...reopened } = record;
          void discarded;
          plannedExpenses.set(record.id, { ...reopened, status: 'planned' });
          rejected++;
        } else rejected++;
      }
      for (const value of parsed.goals) {
        const record = object(value) && typeof value.id === 'string' ? readSavingsGoal(value.id, value) : null;
        if (record && !goals.has(record.id)) goals.set(record.id, record); else rejected++;
      }
    }
    return {
      transactions: [...transactions.values()],
      budgets: [...budgets.values()],
      planning: [...planning.values()],
      plannedExpenses: [...plannedExpenses.values()],
      goals: [...goals.values()],
      warning: rejected ? `${rejected} invalid saved demo record${rejected === 1 ? ' was' : 's were'} skipped. Valid records were recovered.` : null,
    };
  } catch {
    return {
      transactions: [],
      budgets: [],
      planning: [],
      plannedExpenses: [],
      goals: [],
      warning: 'Saved demo data could not be read. You can continue with an empty ledger; the next save will replace the unreadable demo data.',
    };
  }
}

export function serializeDemoData(data: DemoData): string {
  return JSON.stringify({ version: 2, transactions: data.transactions, budgets: data.budgets, planning: data.planning, plannedExpenses: data.plannedExpenses, goals: data.goals });
}

export function createDemoData(asOf = todayISO()): DemoData {
  const [year, month, currentDay] = asOf.split('-').map(Number);
  const transactions: Transaction[] = [];
  const budgets: Budget[] = [];
  const historicalSpend = [650000, 790000, 720000, 840000, 680000];
  for (let offset = -5; offset <= 0; offset++) {
    const monthDate = new Date(year, month - 1 + offset, 1);
    const recordYear = monthDate.getFullYear();
    const recordMonth = monthDate.getMonth() + 1;
    const monthKey = `${recordYear}-${String(recordMonth).padStart(2, '0')}`;
    const days = new Date(recordYear, recordMonth, 0).getDate();
    const availableDay = offset === 0 ? currentDay : days;
    const refund = availableDay >= 12 ? 15000 : 0;
    const netSpend = offset === 0 ? Math.round(950000 * currentDay / days) : historicalSpend[offset + 5];
    const grossSpend = netSpend + refund;
    let index = 0;
    const append = (type: Transaction['type'], amountPaise: number, category: string, day: number, note: string) => {
      const safeDay = Math.min(day, availableDay);
      transactions.push({
        id: `demo-${monthKey}-${index}`,
        type,
        amountPaise,
        category,
        date: `${monthKey}-${String(safeDay).padStart(2, '0')}`,
        note,
        createdAt: Date.UTC(recordYear, recordMonth - 1, safeDay, 12) + index++,
      });
    };
    append('income', 1500000, 'Allowance', 1, 'Monthly allowance');
    const portions = [
      { category: 'Food', fraction: 0.19, day: 3, note: 'Mess and groceries' },
      { category: 'Food', fraction: 0.13, day: 18, note: 'Cafeteria and snacks' },
      { category: 'Bills', fraction: 0.24, day: 5, note: 'Room share and mobile recharge' },
      { category: 'Travel', fraction: 0.13, day: 9, note: 'Bus pass and weekend travel' },
      { category: 'Education', fraction: 0.14, day: 12, note: 'Books and printing' },
      { category: 'Shopping', fraction: 0.09, day: 16, note: 'Everyday essentials' },
      { category: 'Entertainment', fraction: 0.08, day: 22, note: 'Movie and outings' },
    ];
    let allocated = 0;
    portions.forEach((portion, portionIndex) => {
      const amount = portionIndex === portions.length - 1 ? grossSpend - allocated : Math.round(grossSpend * portion.fraction);
      allocated += amount;
      append('expense', amount, portion.category, portion.day, portion.note);
    });
    if (refund) append('refund', refund, 'Shopping', 12, 'Returned stationery');
    budgets.push({
      monthKey,
      limitPaise: 800000,
      categoryLimits: { Food: 280000, Bills: 180000, Travel: 100000, Education: 100000, Shopping: 70000, Entertainment: 70000 },
    });
  }
  const monthKey = asOf.slice(0, 7);
  const daysThisMonth = new Date(year, month, 0).getDate();
  const dueDate = `${monthKey}-${String(Math.min(currentDay + 4, daysThisMonth)).padStart(2, '0')}`;
  const targetMonth = new Date(year, month + 2, 1);
  const targetDate = `${targetMonth.getFullYear()}-${String(targetMonth.getMonth() + 1).padStart(2, '0')}-01`;
  const createdAt = Date.UTC(year, month - 1, currentDay, 12);
  const planning: StudentPlan[] = [{ monthKey, currency: 'INR', expectedIncome: { Allowance: 1500000, Scholarship: 300000 }, essentialCategories: ['Food', 'Bills', 'Travel', 'Education'] }];
  const plannedExpenses: PlannedExpense[] = [
    { id: 'demo-upcoming-printing', title: 'Project printing', amountPaise: 45000, category: 'Education', dueDate, status: 'planned', createdAt },
    { id: 'demo-upcoming-bus', title: 'Bus pass renewal', amountPaise: 18000, category: 'Travel', dueDate, status: 'planned', createdAt: createdAt + 1 },
  ];
  const goals: SavingsGoal[] = [{ id: 'demo-goal-laptop', title: 'Laptop fund', targetPaise: 4000000, reservedPaise: 800000, targetDate, createdAt }];
  return { transactions, budgets, planning, plannedExpenses, goals };
}
