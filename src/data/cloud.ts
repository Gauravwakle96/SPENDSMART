import {
  collection, deleteField, doc, getAggregateFromServer, getCountFromServer, getDocs, limit, orderBy,
  query, runTransaction, serverTimestamp, sum, where, writeBatch, type Firestore,
} from 'firebase/firestore';
import { getMonthlyTrend, monthLabel, todayISO } from '../domain/engine';
import type { Budget, TransactionInput } from '../domain/types';
import type { MonthlySummary, PlannedExpense, SavingsGoal, StudentPlan } from '../domain/planning-types';
import type { CategoryRule, ImportRecord, ImportRollbackResult, PreparedImportTransaction } from '../domain/import-types';
import { transactionCoreHash } from '../domain/import-engine';
import { readImportRecord, readPlannedExpense, readTransaction } from './demo';
import { MAX_CATEGORY_RULES, MAX_GOALS, MAX_OPEN_PLANNED_EXPENSES, validateCategoryRule, validateImportRecord } from './validation';

export function monthRange(monthKey: string): { start: string; end: string } {
  monthLabel(monthKey);
  const [year, month] = monthKey.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month, 0);
  return { start: `${monthKey}-01`, end: `${monthKey}-${String(date.getUTCDate()).padStart(2, '0')}` };
}

function checkedAmount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('A cloud total is too large to represent exactly in paise.');
  return value;
}

function checkedBalance(income: number, expense: number, refund: number): number {
  const value = BigInt(income) - BigInt(expense) + BigInt(refund);
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('The ledger balance is too large to represent exactly in paise.');
  }
  return Number(value);
}

export async function loadCloudSummaries(db: Firestore, uid: string, asOf = todayISO()): Promise<{ balance: number; trend: MonthlySummary[] }> {
  const entries = collection(db, 'users', uid, 'transactions');
  const total = async (type: 'income' | 'expense' | 'refund', start?: string, end = asOf) => {
    const constraints = [where('type', '==', type), where('date', '<=', end)];
    if (start) constraints.push(where('date', '>=', start));
    const snapshot = await getAggregateFromServer(query(entries, ...constraints), { amount: sum('amountPaise') });
    return checkedAmount(snapshot.data().amount);
  };
  const periods = getMonthlyTrend([], asOf);
  const [all, months] = await Promise.all([
    Promise.all([total('income'), total('expense'), total('refund')]),
    Promise.all(periods.map(async (period) => {
      const range = monthRange(period.monthKey);
      const end = range.end < asOf ? range.end : asOf;
      const [income, expense, refund] = await Promise.all([total('income', range.start, end), total('expense', range.start, end), total('refund', range.start, end)]);
      return { ...period, incomePaise: income, expensePaise: Math.max(0, expense - refund) };
    })),
  ]);
  return { balance: checkedBalance(all[0], all[1], all[2]), trend: months };
}

export class CloudWriter {
  constructor(private db: Firestore, private uid: string) {}

  private ref(name: string, id: string) { return doc(this.db, 'users', this.uid, name, id); }
  private entries(name: string) { return collection(this.db, 'users', this.uid, name); }

  async addTransaction(input: TransactionInput, id: string): Promise<void> {
    const reference = this.ref('transactions', id);
    await runTransaction(this.db, async (transaction) => {
      const existing = await transaction.get(reference);
      if (existing.exists()) {
        const record = readTransaction(id, existing.data());
        if (record && record.type === input.type && record.amountPaise === input.amountPaise && record.category === input.category
          && record.date === input.date && record.note === input.note) return;
        throw new Error('This operation ID already belongs to a different transaction. Refresh before retrying.');
      }
      transaction.set(reference, { ...input, currency: 'INR', createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    });
  }

  async updateTransaction(id: string, input: TransactionInput): Promise<void> {
    await runTransaction(this.db, async (transaction) => {
      const reference = this.ref('transactions', id);
      const current = await transaction.get(reference);
      if (!current.exists()) throw new Error('This transaction was deleted. Refresh your ledger.');
      const linkedId = current.data().plannedExpenseId;
      const linkedRef = typeof linkedId === 'string' ? this.ref('plannedExpenses', linkedId) : null;
      const linked = linkedRef ? await transaction.get(linkedRef) : null;
      if (linkedRef && input.type !== 'expense') throw new Error('A linked bill payment must remain an expense. Delete the payment to reopen the planned bill.');
      if (linkedRef && (!linked?.exists() || linked.data().transactionId !== id)) throw new Error('The planned payment link changed. Refresh before editing.');
      transaction.update(reference, { ...input, currency: 'INR', updatedAt: serverTimestamp() });
      if (linkedRef) transaction.update(linkedRef, { amountPaise: input.amountPaise, category: input.category, updatedAt: serverTimestamp() });
    });
  }

  async deleteTransaction(id: string): Promise<void> {
    await runTransaction(this.db, async (transaction) => {
      const reference = this.ref('transactions', id);
      const current = await transaction.get(reference);
      if (!current.exists()) return;
      const linkedId = current.data().plannedExpenseId;
      const linkedRef = typeof linkedId === 'string' ? this.ref('plannedExpenses', linkedId) : null;
      const linked = linkedRef ? await transaction.get(linkedRef) : null;
      if (linked?.exists() && linked.data().transactionId !== id) throw new Error('The payment link changed. Refresh before deleting.');
      transaction.delete(reference);
      if (linkedRef && linked?.exists()) transaction.update(linkedRef, { status: 'planned', transactionId: deleteField(), updatedAt: serverTimestamp() });
    });
  }

  async saveBudget(budget: Budget): Promise<void> {
    await runTransaction(this.db, async (transaction) => {
      const reference = this.ref('budgets', budget.monthKey);
      await transaction.get(reference);
      transaction.set(reference, { ...budget, currency: 'INR', updatedAt: serverTimestamp() });
    });
  }

  async savePlan(plan: StudentPlan): Promise<void> {
    await runTransaction(this.db, async (transaction) => {
      const reference = this.ref('planning', plan.monthKey);
      await transaction.get(reference);
      transaction.set(reference, { ...plan, updatedAt: serverTimestamp() });
    });
  }

  async savePlannedExpense(item: PlannedExpense): Promise<void> {
    const reference = this.ref('plannedExpenses', item.id);
    const { count } = (await getCountFromServer(query(this.entries('plannedExpenses'), where('status', '==', 'planned')))).data();
    await runTransaction(this.db, async (transaction) => {
      const current = await transaction.get(reference);
      const previous = current.exists() ? readPlannedExpense(item.id, current.data()) : null;
      if (!current.exists() && item.status === 'paid') throw new Error('Create a planned bill first, then record its payment.');
      if ((!previous || previous.status === 'paid') && item.status === 'planned' && count >= MAX_OPEN_PLANNED_EXPENSES) {
        throw new Error(`Keep at most ${MAX_OPEN_PLANNED_EXPENSES} open planned expenses. Pay or remove an item first.`);
      }
      if (previous?.status === 'paid' && (item.status !== 'paid' || item.transactionId !== previous.transactionId
        || item.amountPaise !== previous.amountPaise || item.category !== previous.category)) {
        throw new Error('Edit the linked ledger payment to change a paid bill amount/category, or delete that payment to reopen it.');
      }
      if (previous?.status === 'planned' && item.status === 'paid') throw new Error('Use Record payment to mark this bill paid.');
      const fields = { title: item.title.trim(), amountPaise: item.amountPaise, category: item.category, dueDate: item.dueDate,
        status: item.status, currency: 'INR', updatedAt: serverTimestamp(),
        ...(item.transactionId ? { transactionId: item.transactionId } : {}),
        createdAt: current.exists() ? current.data().createdAt : serverTimestamp() };
      transaction.set(reference, fields);
    });
  }

  async recordPlannedExpense(id: string, date: string): Promise<void> {
    const paymentId = `plan_${id}`;
    await runTransaction(this.db, async (transaction) => {
      const plannedRef = this.ref('plannedExpenses', id);
      const paymentRef = this.ref('transactions', paymentId);
      const [planned, existingPayment] = await Promise.all([transaction.get(plannedRef), transaction.get(paymentRef)]);
      if (!planned.exists()) throw new Error('This planned expense no longer exists.');
      const item = readPlannedExpense(id, planned.data());
      if (!item) throw new Error('This planned expense contains invalid data.');
      if (item.status === 'paid') {
        if (item.transactionId === paymentId && existingPayment.exists()) return;
        throw new Error('This bill is already paid. Refresh the ledger.');
      }
      if (existingPayment.exists()) throw new Error('The payment ID already exists. Refresh before recording this bill.');
      transaction.set(paymentRef, { type: 'expense', amountPaise: item.amountPaise, category: item.category, date, note: item.title,
        plannedExpenseId: id, currency: 'INR', createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      transaction.update(plannedRef, { status: 'paid', transactionId: paymentId, updatedAt: serverTimestamp() });
    });
  }

  async deletePlannedExpense(id: string): Promise<void> {
    await runTransaction(this.db, async (transaction) => {
      const reference = this.ref('plannedExpenses', id);
      const current = await transaction.get(reference);
      if (!current.exists()) return;
      const linkedId = current.data().transactionId;
      const linkedRef = typeof linkedId === 'string' ? this.ref('transactions', linkedId) : null;
      const linked = linkedRef ? await transaction.get(linkedRef) : null;
      transaction.delete(reference);
      if (linkedRef && linked?.exists()) transaction.update(linkedRef, { plannedExpenseId: deleteField(), updatedAt: serverTimestamp() });
    });
  }

  async saveGoal(goal: SavingsGoal): Promise<void> {
    const reference = this.ref('goals', goal.id);
    const { count } = (await getCountFromServer(this.entries('goals'))).data();
    await runTransaction(this.db, async (transaction) => {
      const current = await transaction.get(reference);
      if (!current.exists() && count >= MAX_GOALS) throw new Error(`Keep at most ${MAX_GOALS} savings goals. Remove a goal first.`);
      transaction.set(reference, { title: goal.title.trim(), targetPaise: goal.targetPaise, reservedPaise: goal.reservedPaise, targetDate: goal.targetDate,
        currency: 'INR', createdAt: current.exists() ? current.data().createdAt : serverTimestamp(), updatedAt: serverTimestamp() });
    });
  }

  async deleteGoal(id: string): Promise<void> {
    await runTransaction(this.db, async (transaction) => {
      const reference = this.ref('goals', id);
      const current = await transaction.get(reference);
      if (current.exists()) transaction.delete(reference);
    });
  }

  async importTransactions(record: ImportRecord, records: PreparedImportTransaction[]): Promise<void> {
    validateImportRecord(record);
    if (records.length !== record.importedCount) throw new Error('The prepared import does not match its reconciliation record.');
    records.forEach((entry) => {
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(entry.id) || entry.input.importId !== record.id) throw new Error('An imported transaction ID is invalid.');
    });
    const historyRef = this.ref('imports', record.id);
    await runTransaction(this.db, async (transaction) => {
      const current = await transaction.get(historyRef);
      if (current.exists()) {
        const saved = readImportRecord(record.id, current.data());
        if (!saved || saved.fileHashes.join('|') !== record.fileHashes.join('|') || saved.processedCount !== record.processedCount) {
          throw new Error('This import ID already belongs to another statement session.');
        }
        if (saved.status === 'completed') return;
        if (saved.status === 'rolled_back' || saved.status === 'partial_rollback') throw new Error('A rolled-back import cannot be submitted again. Start a new import session.');
        transaction.update(historyRef, { status: 'processing', updatedAt: serverTimestamp() });
        return;
      }
      const { id: discarded, createdAt: ignoredCreatedAt, updatedAt: ignoredUpdatedAt, ...fields } = record;
      void discarded; void ignoredCreatedAt; void ignoredUpdatedAt;
      transaction.set(historyRef, { ...fields, status: 'processing', createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    });
    for (let offset = 0; offset < records.length; offset += 150) {
      const chunk = records.slice(offset, offset + 150);
      await runTransaction(this.db, async (transaction) => {
        const references = chunk.map((entry) => this.ref('transactions', entry.id));
        const existing = await Promise.all(references.map((reference) => transaction.get(reference)));
        existing.forEach((snapshot, index) => {
          const entry = chunk[index];
          if (snapshot.exists()) {
            if (snapshot.data().importId !== record.id) throw new Error('An import transaction ID already belongs to another record.');
            return;
          }
          transaction.set(references[index], { ...entry.input, currency: 'INR', createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
        });
      });
    }
    await runTransaction(this.db, async (transaction) => {
      const current = await transaction.get(historyRef);
      if (!current.exists()) throw new Error('The import history record disappeared before confirmation.');
      transaction.update(historyRef, { status: 'completed', importedCount: records.length, updatedAt: serverTimestamp() });
    });
  }

  async rollbackImport(importId: string): Promise<ImportRollbackResult> {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(importId)) throw new Error('The import ID is invalid.');
    const snapshot = await getDocs(query(this.entries('transactions'), where('importId', '==', importId), limit(5001)));
    if (snapshot.size > 5000) throw new Error('This import exceeds the safe rollback limit. Contact support before deleting records.');
    const removable: (typeof snapshot.docs)[number][] = [];
    let conflictCount = 0;
    snapshot.docs.forEach((record) => {
      const value = record.data();
      const decoded = readTransaction(record.id, value, typeof value.date === 'string' ? value.date : todayISO());
      if (!decoded || value.plannedExpenseId !== undefined || !decoded.importOriginalHash) { conflictCount += 1; return; }
      const { id: discardedId, createdAt: discardedCreatedAt, ...input } = decoded;
      void discardedId; void discardedCreatedAt;
      if (transactionCoreHash(input) !== decoded.importOriginalHash) { conflictCount += 1; return; }
      removable.push(record);
    });
    for (let offset = 0; offset < removable.length; offset += 400) {
      const batch = writeBatch(this.db);
      removable.slice(offset, offset + 400).forEach((record) => batch.delete(record.ref));
      await batch.commit();
    }
    const historyRef = this.ref('imports', importId);
    await runTransaction(this.db, async (transaction) => {
      const history = await transaction.get(historyRef);
      if (!history.exists()) return;
      transaction.update(historyRef, { status: conflictCount ? 'partial_rollback' : 'rolled_back', updatedAt: serverTimestamp() });
    });
    return { deletedCount: removable.length, conflictCount };
  }

  async saveCategoryRule(rule: CategoryRule): Promise<void> {
    validateCategoryRule(rule);
    const reference = this.ref('categoryRules', rule.id);
    const { count } = (await getCountFromServer(this.entries('categoryRules'))).data();
    await runTransaction(this.db, async (transaction) => {
      const current = await transaction.get(reference);
      if (!current.exists() && count >= MAX_CATEGORY_RULES) throw new Error(`Keep at most ${MAX_CATEGORY_RULES} reusable categorization rules.`);
      transaction.set(reference, { matchText: rule.matchText, direction: rule.direction, category: rule.category,
        classification: rule.classification, excludedFromAnalysis: rule.excludedFromAnalysis,
        createdAt: current.exists() ? current.data().createdAt : serverTimestamp(), updatedAt: serverTimestamp() });
    });
  }

  async deleteCategoryRule(id: string): Promise<void> {
    await runTransaction(this.db, async (transaction) => {
      const reference = this.ref('categoryRules', id);
      const current = await transaction.get(reference);
      if (current.exists()) transaction.delete(reference);
    });
  }
}

export async function readCloudPage(db: Firestore, uid: string, monthKey: string): Promise<void> {
  // Exported query probe is used by emulator integration tests to verify the same
  // bounded-month query shape used by the live provider.
  const range = monthRange(monthKey);
  await getDocs(query(collection(db, 'users', uid, 'transactions'), where('date', '>=', range.start), where('date', '<=', range.end), orderBy('date', 'desc'), limit(100)));
}
