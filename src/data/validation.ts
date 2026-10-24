import { monthLabel, validateTransaction } from '../domain/engine';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from '../domain/types';
import type { PlannedExpense, SavingsGoal, StudentPlan } from '../domain/planning-types';

export const MAX_OPEN_PLANNED_EXPENSES = 200;
export const MAX_GOALS = 50;
export const MAX_TITLE_LENGTH = 80;

export function validRecordId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,95}$/.test(id);
}

export function safePaise(value: unknown, allowZero = false): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && (allowZero ? value >= 0 : value > 0);
}

export function validateCalendarDate(date: string): void {
  // The transaction validator already handles Gregorian dates; using the date as
  // the cutoff permits future planning dates without weakening transaction entry.
  validateTransaction({ type: 'expense', amountPaise: 1, category: 'Other', date, note: '' }, date);
}

function validTitle(title: string): void {
  if (typeof title !== 'string' || !title.trim() || title.length > MAX_TITLE_LENGTH) {
    throw new Error(`Enter a title between 1 and ${MAX_TITLE_LENGTH} characters.`);
  }
}

export function validateStudentPlan(plan: StudentPlan): void {
  if (!plan) throw new Error('Enter a student plan.');
  monthLabel(plan.monthKey);
  if (plan.currency !== 'INR') throw new Error('SpendSmart currently supports INR only.');
  if (!plan.expectedIncome || typeof plan.expectedIncome !== 'object' || Array.isArray(plan.expectedIncome)) {
    throw new Error('Expected income must contain category amounts.');
  }
  for (const [category, amount] of Object.entries(plan.expectedIncome)) {
    if (!(INCOME_CATEGORIES as readonly string[]).includes(category) || !safePaise(amount, true)) {
      throw new Error('Use valid income categories and nonnegative integer-paise amounts.');
    }
  }
  if (!Array.isArray(plan.essentialCategories) || plan.essentialCategories.length > EXPENSE_CATEGORIES.length
    || new Set(plan.essentialCategories).size !== plan.essentialCategories.length
    || plan.essentialCategories.some((category) => !(EXPENSE_CATEGORIES as readonly string[]).includes(category))) {
    throw new Error('Choose each essential expense category at most once.');
  }
}

export function validatePlannedExpense(item: PlannedExpense): void {
  if (!item || !validRecordId(item.id)) throw new Error('The planned expense ID is invalid.');
  validTitle(item.title);
  if (!safePaise(item.amountPaise)) throw new Error('The planned amount must be positive integer paise.');
  if (!(EXPENSE_CATEGORIES as readonly string[]).includes(item.category)) throw new Error('Choose an expense category.');
  validateCalendarDate(item.dueDate);
  if (item.status !== 'planned' && item.status !== 'paid') throw new Error('Choose planned or paid status.');
  if (item.status === 'paid' && !validRecordId(item.transactionId)) throw new Error('A paid expense must link to its ledger transaction.');
  if (item.status === 'planned' && item.transactionId !== undefined) throw new Error('A planned expense cannot already link to a payment.');
  if (!Number.isSafeInteger(item.createdAt) || item.createdAt < 0) throw new Error('The creation time is invalid.');
}

export function validateSavingsGoal(goal: SavingsGoal): void {
  if (!goal || !validRecordId(goal.id)) throw new Error('The savings goal ID is invalid.');
  validTitle(goal.title);
  if (!safePaise(goal.targetPaise) || !safePaise(goal.reservedPaise, true) || goal.reservedPaise > goal.targetPaise) {
    throw new Error('Use a positive goal target and a reserved amount between zero and the target.');
  }
  validateCalendarDate(goal.targetDate);
  if (!Number.isSafeInteger(goal.createdAt) || goal.createdAt < 0) throw new Error('The creation time is invalid.');
}
