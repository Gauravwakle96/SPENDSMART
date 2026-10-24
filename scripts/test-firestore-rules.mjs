import { after, before, beforeEach, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, updateDoc, serverTimestamp, Timestamp, writeBatch, deleteField, setLogLevel } from 'firebase/firestore';

setLogLevel('silent');

let environment;
const projectId = 'demo-spendsmart';
const validTransaction = {
  type: 'expense',
  amountPaise: 12550,
  category: 'Food',
  date: '2026-10-24',
  note: 'Lunch',
  createdAt: serverTimestamp(),
  updatedAt: serverTimestamp(),
};
const validBudget = { monthKey: '2026-10', limitPaise: 800000, categoryLimits: { Food: 300000, Travel: 100000 }, updatedAt: serverTimestamp() };

before(async () => {
  const emulator = process.env.FIRESTORE_EMULATOR_HOST;
  if (!emulator) throw new Error('Run this script through npm run test:rules so it uses only the local Firestore emulator.');
  const [host, port] = emulator.split(':');
  environment = await initializeTestEnvironment({
    projectId,
    firestore: {
      host,
      port: Number(port),
      rules: await readFile(new URL('../firestore.rules', import.meta.url), 'utf8'),
    },
  });
});

beforeEach(async () => { await environment.clearFirestore(); });
after(async () => { if (environment) await environment.cleanup(); });

function owner() { return environment.authenticatedContext('alice').firestore(); }
function stranger() { return environment.authenticatedContext('bob').firestore(); }
function transaction(db, id = 'entry') { return doc(db, 'users', 'alice', 'transactions', id); }
function budget(db, monthKey = '2026-10') { return doc(db, 'users', 'alice', 'budgets', monthKey); }

test('owner can create, read, edit, list and delete transactions', async () => {
  const db = owner();
  await assertSucceeds(setDoc(transaction(db), validTransaction));
  await assertSucceeds(getDoc(transaction(db)));
  await assertSucceeds(getDocs(collection(db, 'users', 'alice', 'transactions')));
  await assertSucceeds(updateDoc(transaction(db), { amountPaise: 15000, note: 'Updated lunch', updatedAt: serverTimestamp() }));
  await assertSucceeds(deleteDoc(transaction(db)));
});

test('unauthenticated requests cannot read, list, write or delete financial records', async () => {
  await setDoc(transaction(owner()), validTransaction);
  await setDoc(budget(owner()), validBudget);
  const db = environment.unauthenticatedContext().firestore();
  await assertFails(getDoc(transaction(db)));
  await assertFails(getDocs(collection(db, 'users', 'alice', 'transactions')));
  await assertFails(setDoc(transaction(db, 'new'), validTransaction));
  await assertFails(deleteDoc(transaction(db)));
  await assertFails(getDoc(budget(db)));
  await assertFails(setDoc(budget(db), validBudget));
});

test('another signed-in user cannot read, list, create, edit or delete the owner data', async () => {
  await setDoc(transaction(owner()), validTransaction);
  await setDoc(budget(owner()), validBudget);
  const db = stranger();
  await assertFails(getDoc(transaction(db)));
  await assertFails(getDocs(collection(db, 'users', 'alice', 'transactions')));
  await assertFails(setDoc(transaction(db, 'new'), validTransaction));
  await assertFails(updateDoc(transaction(db), { note: 'Changed by stranger' }));
  await assertFails(deleteDoc(transaction(db)));
  await assertFails(getDoc(budget(db)));
  await assertFails(setDoc(budget(db), validBudget));
});

test('owner can record valid refunds and income with their accepted categories', async () => {
  const db = owner();
  await assertSucceeds(setDoc(transaction(db, 'refund'), { ...validTransaction, type: 'refund', category: 'Shopping' }));
  await assertSucceeds(setDoc(transaction(db, 'income'), { ...validTransaction, type: 'income', category: 'Scholarship' }));
});

test('transaction writes reject zero, negative, fractional, unsafe and string amounts', async () => {
  const db = owner();
  const invalidAmounts = [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '12550'];
  for (let index = 0; index < invalidAmounts.length; index++) {
    await assertFails(setDoc(transaction(db, `amount-${index}`), { ...validTransaction, amountPaise: invalidAmounts[index] }));
  }
});

test('transaction writes reject unknown types, wrong categories, oversized notes and extra fields', async () => {
  const db = owner();
  const invalid = [
    { ...validTransaction, type: 'transfer' },
    { ...validTransaction, category: 'Unlisted' },
    { ...validTransaction, type: 'income', category: 'Food' },
    { ...validTransaction, type: 'refund', category: 'Allowance' },
    { ...validTransaction, note: 'x'.repeat(501) },
    { ...validTransaction, uid: 'bob' },
    { ...validTransaction, createdAt: -1 },
    { ...validTransaction, createdAt: 1.5 },
    { ...validTransaction, note: null },
  ];
  for (let index = 0; index < invalid.length; index++) {
    await assertFails(setDoc(transaction(db, `schema-${index}`), invalid[index]));
  }
  const missing = { ...validTransaction };
  delete missing.note;
  await assertFails(setDoc(transaction(db, 'missing'), missing));
});

test('calendar date rules reject impossible dates and accept valid leap days', async () => {
  const db = owner();
  const invalid = ['2026-02-29', '1900-02-29', '2026-02-30', '2026-04-31', '2026-13-01', '2026-10-00', '0000-01-01', '2026-1-01'];
  for (let index = 0; index < invalid.length; index++) {
    await assertFails(setDoc(transaction(db, `date-${index}`), { ...validTransaction, date: invalid[index] }));
  }
  await assertSucceeds(setDoc(transaction(db, 'leap'), { ...validTransaction, date: '2028-02-29' }));
  await assertSucceeds(setDoc(transaction(db, 'century'), { ...validTransaction, date: '2000-02-29' }));
});

test('createdAt cannot be changed by an owner update', async () => {
  const db = owner();
  await setDoc(transaction(db), validTransaction);
  await assertFails(updateDoc(transaction(db), { createdAt: Timestamp.fromMillis(1), updatedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(transaction(db), { amountPaise: 20000, updatedAt: serverTimestamp() }));
});

test('owner can create, read, update and delete budgets, including zero or unset category limits', async () => {
  const db = owner();
  await assertSucceeds(setDoc(budget(db), validBudget));
  await assertSucceeds(getDoc(budget(db)));
  await assertSucceeds(updateDoc(budget(db), { limitPaise: 0, categoryLimits: { Food: 0 }, updatedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(budget(db), { categoryLimits: {}, updatedAt: serverTimestamp() }));
  await assertSucceeds(deleteDoc(budget(db)));
});

test('budget writes reject invalid totals, month mismatch, unknown keys and malformed category maps', async () => {
  const db = owner();
  const invalid = [
    { ...validBudget, limitPaise: -1 },
    { ...validBudget, limitPaise: 1.5 },
    { ...validBudget, limitPaise: Number.MAX_SAFE_INTEGER + 1 },
    { ...validBudget, monthKey: '2026-11' },
    { ...validBudget, categoryLimits: { Unknown: 10000 } },
    { ...validBudget, categoryLimits: { Food: -1 } },
    { ...validBudget, categoryLimits: { Food: 1.5 } },
    { ...validBudget, categoryLimits: { Food: '10000' } },
    { ...validBudget, categoryLimits: { Food: Number.MAX_SAFE_INTEGER + 1 } },
    { ...validBudget, categoryLimits: [] },
    { ...validBudget, categoryLimits: null },
    { ...validBudget, arbitrary: true },
  ];
  for (const record of invalid) await assertFails(setDoc(budget(db), record));
  await assertFails(setDoc(budget(db, '0000-01'), { ...validBudget, monthKey: '0000-01' }));
  await assertFails(setDoc(budget(db, '2026-13'), { ...validBudget, monthKey: '2026-13' }));
});

test('unmatched document paths remain inaccessible', async () => {
  const db = owner();
  await assertFails(setDoc(doc(db, 'users', 'alice'), { name: 'Alice' }));
  await assertFails(setDoc(doc(db, 'public', 'ledger'), validTransaction));
});

const validPlan = { monthKey: '2026-10', currency: 'INR', expectedIncome: { Allowance: 1500000, Scholarship: 300000 }, essentialCategories: ['Food', 'Bills'], updatedAt: serverTimestamp() };
const validPlannedExpense = { title: 'Project printing', amountPaise: 30000, category: 'Education', dueDate: '2026-10-28', status: 'planned', createdAt: serverTimestamp(), updatedAt: serverTimestamp(), currency: 'INR' };
const validGoal = { title: 'Laptop fund', targetPaise: 4000000, reservedPaise: 800000, targetDate: '2027-01-01', createdAt: serverTimestamp(), updatedAt: serverTimestamp(), currency: 'INR' };
const planning = (db) => doc(db, 'users', 'alice', 'planning', '2026-10');
const planned = (db) => doc(db, 'users', 'alice', 'plannedExpenses', 'bill');
const goal = (db) => doc(db, 'users', 'alice', 'goals', 'laptop');

test('planning entities support valid owner writes and deny cross-user or anonymous access', async () => {
  const db = owner();
  await assertSucceeds(setDoc(planning(db), validPlan));
  await assertSucceeds(setDoc(planned(db), validPlannedExpense));
  await assertSucceeds(setDoc(goal(db), validGoal));
  for (const other of [stranger(), environment.unauthenticatedContext().firestore()]) {
    await assertFails(getDoc(planning(other))); await assertFails(setDoc(planning(other), validPlan));
    await assertFails(getDoc(planned(other))); await assertFails(setDoc(planned(other), validPlannedExpense));
    await assertFails(getDoc(goal(other))); await assertFails(setDoc(goal(other), validGoal));
  }
});

test('planning validates INR, expected-income maps, essential categories and fields', async () => {
  const db = owner();
  for (const data of [
    { ...validPlan, currency: 'USD' }, { ...validPlan, expectedIncome: { Food: 100 } },
    { ...validPlan, expectedIncome: { Allowance: -1 } }, { ...validPlan, expectedIncome: { Allowance: 1.5 } },
    { ...validPlan, essentialCategories: ['Food', 'Food'] }, { ...validPlan, essentialCategories: ['Unknown'] },
    { ...validPlan, monthKey: '2026-11' }, { ...validPlan, extra: true },
  ]) await assertFails(setDoc(planning(db), data));
});

test('planned expenses and goals validate dates, integer paise, links and reservation bounds', async () => {
  const db = owner();
  for (const data of [
    { ...validPlannedExpense, amountPaise: 0 }, { ...validPlannedExpense, amountPaise: 1.5 },
    { ...validPlannedExpense, category: 'Allowance' }, { ...validPlannedExpense, dueDate: '2026-02-29' },
    { ...validPlannedExpense, status: 'paid' }, { ...validPlannedExpense, status: 'planned', transactionId: 'bad-link' },
    { ...validPlannedExpense, currency: 'USD' }, { ...validPlannedExpense, arbitrary: true },
  ]) await assertFails(setDoc(planned(db), data));
  for (const data of [
    { ...validGoal, targetPaise: 0 }, { ...validGoal, reservedPaise: -1 }, { ...validGoal, reservedPaise: 4000001 },
    { ...validGoal, reservedPaise: 1.5 }, { ...validGoal, targetDate: '2026-04-31' }, { ...validGoal, currency: 'USD' },
    { ...validGoal, extra: true },
  ]) await assertFails(setDoc(goal(db), data));
});

test('new records require server timestamps while legacy integer creation times remain editable', async () => {
  const db = owner();
  await assertFails(setDoc(transaction(db), { ...validTransaction, createdAt: 1792800000000 }));
  await assertFails(setDoc(transaction(db), { ...validTransaction, createdAt: Timestamp.fromMillis(1) }));
  await assertFails(setDoc(transaction(db), { ...validTransaction, updatedAt: Timestamp.fromMillis(1) }));
  await environment.withSecurityRulesDisabled(async (context) => {
    await setDoc(transaction(context.firestore()), { type: 'expense', amountPaise: 10000, category: 'Food', date: '2026-10-24', note: 'Legacy', createdAt: 1792800000000 });
  });
  await assertSucceeds(updateDoc(transaction(db), { note: 'Legacy edit', updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(transaction(db), { currency: 'USD', updatedAt: serverTimestamp() }));
});

test('paid status and linked transaction must be committed atomically and remain consistent', async () => {
  const db = owner();
  await setDoc(planned(db), validPlannedExpense);
  await assertFails(updateDoc(planned(db), { status: 'paid', transactionId: 'payment', updatedAt: serverTimestamp() }));
  await assertFails(setDoc(transaction(db, 'payment'), { ...validTransaction, category: 'Education', amountPaise: 30000, plannedExpenseId: 'bill' }));
  const batch = writeBatch(db);
  batch.set(transaction(db, 'payment'), { ...validTransaction, category: 'Education', amountPaise: 30000, plannedExpenseId: 'bill' });
  batch.update(planned(db), { status: 'paid', transactionId: 'payment', updatedAt: serverTimestamp() });
  await assertSucceeds(batch.commit());
  await assertFails(updateDoc(transaction(db, 'payment'), { type: 'income', category: 'Allowance', updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(transaction(db, 'payment'), { amountPaise: 40000, updatedAt: serverTimestamp() }));
  const edit = writeBatch(db);
  edit.update(transaction(db, 'payment'), { amountPaise: 40000, updatedAt: serverTimestamp() });
  edit.update(planned(db), { amountPaise: 40000, updatedAt: serverTimestamp() });
  await assertSucceeds(edit.commit());
  await assertFails(deleteDoc(transaction(db, 'payment')));
  const reopen = writeBatch(db);
  reopen.delete(transaction(db, 'payment'));
  reopen.update(planned(db), { status: 'planned', transactionId: deleteField(), updatedAt: serverTimestamp() });
  await assertSucceeds(reopen.commit());
});

test('removing a paid planning item preserves the expense and clears its reciprocal link atomically', async () => {
  const db = owner(); await setDoc(planned(db), validPlannedExpense);
  const pay = writeBatch(db);
  pay.set(transaction(db, 'payment'), { ...validTransaction, amountPaise: 30000, category: 'Education', plannedExpenseId: 'bill' });
  pay.update(planned(db), { status: 'paid', transactionId: 'payment', updatedAt: serverTimestamp() }); await pay.commit();
  await assertFails(deleteDoc(planned(db)));
  const remove = writeBatch(db);
  remove.delete(planned(db)); remove.update(transaction(db, 'payment'), { plannedExpenseId: deleteField(), updatedAt: serverTimestamp() });
  await assertSucceeds(remove.commit()); await assertSucceeds(getDoc(transaction(db, 'payment')));
});
