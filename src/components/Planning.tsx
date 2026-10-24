import { useRef, useState, type FormEvent } from 'react';
import {
  CalendarCheck,
  Check,
  CircleDollarSign,
  Pencil,
  Plus,
  Target,
  Trash2,
  X,
} from 'lucide-react';
import { useSpendSmart } from '../data/SpendSmartProvider';
import { formatMoney, monthLabel, parseAmount } from '../domain/engine';
import {
  getFinancialIntelligence,
  validateGoalAllocation,
  validatePlannedExpense,
  validateSavingsGoal,
  validateStudentPlan,
} from '../domain/intelligence';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES, type Budget } from '../domain/types';
import type {
  FinancialContext,
  PlannedExpense,
  SavingsGoal,
  StudentPlan,
} from '../domain/planning-types';

const moneyInput = (paise = 0) =>
  paise ? `${BigInt(paise) / 100n}.${String(BigInt(paise) % 100n).padStart(2, '0')}` : '';
const optionalAmount = (value: FormDataEntryValue | null) => {
  const text = String(value ?? '').trim();
  return !text || /^0(?:\.0{1,2})?$/.test(text) ? 0 : parseAmount(text);
};
const sourceNames: Record<string, string> = {
  Allowance: 'Allowance / family support',
  Scholarship: 'Scholarship / stipend',
  Salary: 'Salary / part-time work',
  Other: 'Other expected income',
};

function useSave() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const run = async (action: () => Promise<void>) => {
    if (pending.current) return false;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save. Please try again.');
      return false;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function AllowanceForm({
  monthKey,
  plan,
  notify,
}: {
  monthKey: string;
  plan?: StudentPlan;
  notify: (message: string) => void;
}) {
  const store = useSpendSmart();
  const action = useSave();
  const [essentials, setEssentials] = useState(
    plan?.essentialCategories ?? ['Food', 'Travel', 'Bills', 'Education', 'Health'],
  );
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await action.run(async () => {
      const next: StudentPlan = {
        monthKey,
        currency: 'INR',
        expectedIncome: {},
        essentialCategories: essentials,
      };
      for (const source of INCOME_CATEGORIES)
        next.expectedIncome[source] = optionalAmount(form.get(source));
      validateStudentPlan(next);
      await store.savePlan(next);
      notify('Income plan and essential categories saved.');
    });
  }
  return (
    <form className="planning-stack" onSubmit={submit}>
      <section className="panel">
        <div className="section-heading">
          <div>
            <span className="eyebrow">PLAN WHAT IS COMING IN</span>
            <h2>{monthLabel(monthKey)} income plan</h2>
            <p className="muted">
              Expected money informs projections. It becomes available cash only when you record
              income.
            </p>
          </div>
          <CircleDollarSign className="planning-section-icon" aria-hidden="true" />
        </div>
        <div className="category-limit-grid">
          {INCOME_CATEGORIES.map((source) => (
            <label key={source}>
              {sourceNames[source]} (₹)
              <input
                name={source}
                inputMode="decimal"
                placeholder="No amount planned"
                defaultValue={moneyInput(plan?.expectedIncome[source])}
                disabled={action.busy}
              />
            </label>
          ))}
        </div>
      </section>
      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>What counts as essential for you?</h2>
            <p className="muted">
              Choose the categories you need to protect. This changes the spending breakdown, not
              your budget total.
            </p>
          </div>
        </div>
        <div className="essential-options">
          {EXPENSE_CATEGORIES.map((category) => (
            <label key={category}>
              <input
                type="checkbox"
                checked={essentials.includes(category)}
                onChange={(event) =>
                  setEssentials(
                    event.target.checked
                      ? [...essentials, category]
                      : essentials.filter((value) => value !== category),
                  )
                }
                disabled={action.busy}
              />
              <span>{category}</span>
            </label>
          ))}
        </div>
      </section>
      {action.error && (
        <p className="form-error" role="alert">
          {action.error}
        </p>
      )}
      <div className="planning-form-actions">
        <button className="button button-primary" disabled={action.busy}>
          {action.busy ? 'Saving…' : 'Save income plan'}
          <Check size={16} aria-hidden="true" />
        </button>
      </div>
    </form>
  );
}

function ExpenseForm({
  item,
  asOf,
  onSaved,
  onCancel,
}: {
  item?: PlannedExpense;
  asOf: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const store = useSpendSmart();
  const action = useSave();
  const operation = useRef({
    id: item?.id ?? crypto.randomUUID(),
    createdAt: item?.createdAt ?? Date.now(),
  });
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const success = await action.run(async () => {
      const next: PlannedExpense = {
        ...operation.current,
        title: String(form.get('title')).trim(),
        amountPaise: parseAmount(String(form.get('amount'))),
        category: String(form.get('category')),
        dueDate: String(form.get('date')),
        status: 'planned',
      };
      validatePlannedExpense(next);
      await store.savePlannedExpense(next);
    });
    if (success) onSaved();
  }
  return (
    <form className="panel planning-editor stack-form" onSubmit={submit}>
      <div className="section-heading">
        <h2>{item ? 'Edit planned expense' : 'Plan an upcoming expense'}</h2>
        {item && (
          <button
            type="button"
            className="icon-button"
            onClick={onCancel}
            disabled={action.busy}
            aria-label="Cancel expense edit"
          >
            <X size={18} aria-hidden="true" />
          </button>
        )}
      </div>
      <label>
        Expense title
        <input
          name="title"
          required
          maxLength={100}
          placeholder="Hostel fees, books, bus pass…"
          defaultValue={item?.title ?? ''}
          disabled={action.busy}
        />
      </label>
      <div className="form-two-columns">
        <label>
          Planned amount (₹)
          <input
            name="amount"
            inputMode="decimal"
            required
            placeholder="0.00"
            defaultValue={moneyInput(item?.amountPaise)}
            disabled={action.busy}
          />
        </label>
        <label>
          Due date
          <input
            name="date"
            type="date"
            required
            defaultValue={item?.dueDate ?? asOf}
            disabled={action.busy}
          />
        </label>
      </div>
      <label>
        Expense category
        <select name="category" defaultValue={item?.category ?? 'Bills'} disabled={action.busy}>
          {EXPENSE_CATEGORIES.map((category) => (
            <option key={category}>{category}</option>
          ))}
        </select>
      </label>
      <p className="field-help">
        This reserves room in your plan. It does not record a payment. Use “Record payment” after
        you actually pay.
      </p>
      {action.error && (
        <p className="form-error" role="alert">
          {action.error}
        </p>
      )}
      <button className="button button-primary" disabled={action.busy}>
        {action.busy ? 'Saving…' : 'Save planned expense'}
        <Plus size={16} aria-hidden="true" />
      </button>
    </form>
  );
}

function Upcoming({
  monthKey,
  asOf,
  notify,
}: {
  monthKey: string;
  asOf: string;
  notify: (message: string) => void;
}) {
  const store = useSpendSmart();
  const action = useSave();
  const [editing, setEditing] = useState<PlannedExpense | undefined>();
  const [version, setVersion] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const items = store.plannedExpenses
    .filter(
      (item) =>
        showAll ||
        item.dueDate.startsWith(monthKey) ||
        (item.status === 'planned' && item.dueDate < `${monthKey}-01`),
    )
    .sort((a, b) => a.status.localeCompare(b.status) * -1 || a.dueDate.localeCompare(b.dueDate));
  async function remove(item: PlannedExpense) {
    if (
      !window.confirm(
        `Remove the plan for ${item.title}? Any recorded payment stays in your ledger.`,
      )
    )
      return;
    await action.run(async () => {
      await store.deletePlannedExpense(item.id);
      notify('Planned expense removed. Actual transactions were retained.');
    });
  }
  async function record(item: PlannedExpense) {
    if (
      !window.confirm(
        `Record ${formatMoney(item.amountPaise)} paid for ${item.title} today? This creates one actual expense.`,
      )
    )
      return;
    await action.run(async () => {
      await store.recordPlannedExpense(item.id, asOf);
      notify('Payment recorded once. The commitment is now marked paid.');
    });
  }
  return (
    <div className="planning-columns">
      <ExpenseForm
        key={`${editing?.id ?? 'new'}-${version}`}
        item={editing}
        asOf={asOf}
        onCancel={() => setEditing(undefined)}
        onSaved={() => {
          setEditing(undefined);
          setVersion((value) => value + 1);
          notify('Planned expense saved. Guidance refreshed.');
        }}
      />
      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Upcoming commitments</h2>
            <p className="muted">Unpaid essentials are reserved before discretionary spending.</p>
          </div>
        </div>
        <label className="inline-checkbox">
          <input
            type="checkbox"
            checked={showAll}
            onChange={(event) => setShowAll(event.target.checked)}
          />
          Show all periods
        </label>
        {action.error && (
          <p className="form-error" role="alert">
            {action.error}
          </p>
        )}
        {items.length ? (
          <ul className="planning-list">
            {items.map((item) => (
              <li key={item.id}>
                <div className="planning-list-heading">
                  <strong>{item.title}</strong>
                  <strong>{formatMoney(item.amountPaise)}</strong>
                </div>
                <p className="muted">
                  {item.category} · Due {item.dueDate} ·{' '}
                  <span
                    className={
                      item.status === 'paid'
                        ? 'positive-text'
                        : item.dueDate < asOf
                          ? 'warning-text'
                          : ''
                    }
                  >
                    {item.status === 'paid'
                      ? 'Payment recorded'
                      : item.dueDate < asOf
                        ? 'Overdue · still reserved'
                        : 'Not paid yet'}
                  </span>
                </p>
                <div className="planning-item-actions">
                  {item.status === 'planned' && (
                    <>
                      <button
                        className="button button-secondary"
                        disabled={action.busy}
                        onClick={() => void record(item)}
                      >
                        <CalendarCheck size={15} aria-hidden="true" />
                        Record payment
                      </button>
                      <button
                        className="icon-button"
                        disabled={action.busy}
                        aria-label={`Edit plan ${item.title}`}
                        onClick={() => setEditing(item)}
                      >
                        <Pencil size={16} aria-hidden="true" />
                      </button>
                    </>
                  )}
                  <button
                    className="icon-button danger-icon"
                    disabled={action.busy}
                    aria-label={`Remove plan ${item.title}`}
                    onClick={() => void remove(item)}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="empty-state">
            <CalendarCheck size={30} aria-hidden="true" />
            <h3>No upcoming expenses here.</h3>
            <p>Add your hostel fee or next book purchase to protect that money.</p>
          </div>
        )}
      </section>
    </div>
  );
}

interface GoalProps {
  monthKey: string;
  asOf: string;
  budget?: Budget;
  context: FinancialContext;
  notify: (message: string) => void;
}

function GoalForm({
  item,
  asOf,
  monthKey,
  budget,
  context,
  onSaved,
  onCancel,
}: Omit<GoalProps, 'notify'> & { item?: SavingsGoal; onSaved: () => void; onCancel: () => void }) {
  const store = useSpendSmart();
  const action = useSave();
  const operation = useRef({
    id: item?.id ?? crypto.randomUUID(),
    createdAt: item?.createdAt ?? Date.now(),
  });
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const success = await action.run(async () => {
      const next: SavingsGoal = {
        ...operation.current,
        title: String(form.get('title')).trim(),
        targetPaise: parseAmount(String(form.get('target'))),
        reservedPaise: optionalAmount(form.get('reserved')),
        targetDate: String(form.get('date')),
      };
      validateSavingsGoal(next);
      const intelligence = getFinancialIntelligence(
        store.transactions,
        budget,
        asOf,
        monthKey,
        context,
      );
      validateGoalAllocation(next, store.goals, intelligence);
      await store.saveGoal(next);
    });
    if (success) onSaved();
  }
  return (
    <form className="panel planning-editor stack-form" onSubmit={submit}>
      <div className="section-heading">
        <h2>{item ? 'Edit savings goal' : 'Give your savings a purpose'}</h2>
        {item && (
          <button
            type="button"
            className="icon-button"
            onClick={onCancel}
            disabled={action.busy}
            aria-label="Cancel goal edit"
          >
            <X size={18} aria-hidden="true" />
          </button>
        )}
      </div>
      <label>
        Goal name
        <input
          name="title"
          required
          maxLength={100}
          placeholder="A new laptop, a course, a trip…"
          defaultValue={item?.title ?? ''}
          disabled={action.busy}
        />
      </label>
      <div className="form-two-columns">
        <label>
          Target amount (₹)
          <input
            name="target"
            inputMode="decimal"
            required
            placeholder="0.00"
            defaultValue={moneyInput(item?.targetPaise)}
            disabled={action.busy}
          />
        </label>
        <label>
          Target date
          <input
            name="date"
            type="date"
            required
            defaultValue={item?.targetDate ?? ''}
            disabled={action.busy}
          />
        </label>
      </div>
      <label>
        Reserve from recorded cash (₹)
        <input
          name="reserved"
          inputMode="decimal"
          placeholder="Optional — start with 0"
          defaultValue={moneyInput(item?.reservedPaise)}
          disabled={action.busy}
        />
      </label>
      <p className="field-help">
        A reservation earmarks cash you already recorded. It is not an expense or a bank transfer.
        Progress drops if your cash no longer backs the reservation.
      </p>
      {action.error && (
        <p className="form-error" role="alert">
          {action.error}
        </p>
      )}
      <button className="button button-primary" disabled={action.busy}>
        {action.busy ? 'Saving…' : 'Save savings goal'}
        <Target size={16} aria-hidden="true" />
      </button>
    </form>
  );
}

function Goals(props: GoalProps) {
  const store = useSpendSmart();
  const action = useSave();
  const [editing, setEditing] = useState<SavingsGoal | undefined>();
  const [version, setVersion] = useState(0);
  const intelligence = getFinancialIntelligence(
    store.transactions,
    props.budget,
    props.asOf,
    props.monthKey,
    props.context,
  );
  async function remove(id: string, title: string) {
    if (
      !window.confirm(
        `Remove ${title}? Reserved cash will become available again; ledger transactions stay unchanged.`,
      )
    )
      return;
    await action.run(async () => {
      await store.deleteGoal(id);
      props.notify('Savings goal removed. Its reservation has been released.');
    });
  }
  return (
    <div className="planning-columns">
      <GoalForm
        key={`${editing?.id ?? 'new'}-${version}`}
        {...props}
        item={editing}
        onCancel={() => setEditing(undefined)}
        onSaved={() => {
          setEditing(undefined);
          setVersion((value) => value + 1);
          props.notify('Savings goal saved. Your available spending has been updated.');
        }}
      />
      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Progress backed by your money</h2>
            <p className="muted">
              Cash is allocated to older goals first, so the same rupee is never counted twice.
            </p>
          </div>
        </div>
        {action.error && (
          <p className="form-error" role="alert">
            {action.error}
          </p>
        )}
        {intelligence.goalProgress.length ? (
          <ul className="planning-list">
            {intelligence.goalProgress.map((goal) => (
              <li key={goal.id}>
                <div className="planning-list-heading">
                  <strong>{goal.title}</strong>
                  <span className="category-tag">{Math.floor(goal.percent)}% funded</span>
                </div>
                <p>
                  <strong>{formatMoney(goal.backedPaise)}</strong>
                  <span className="muted">
                    {' '}
                    of {formatMoney(goal.targetPaise)} · by {goal.targetDate}
                  </span>
                </p>
                <progress
                  value={goal.backedPaise}
                  max={goal.targetPaise}
                  aria-label={`${goal.title} funded progress`}
                />
                <p className="muted">{goal.reason}</p>
                {goal.remainingPaise > 0 && (
                  <p className="goal-weekly">
                    {formatMoney(goal.weeklyPaise)} per week still needed. This is a target, not a
                    guarantee.
                  </p>
                )}
                <div className="planning-item-actions">
                  <button
                    className="button button-secondary"
                    onClick={() => setEditing(store.goals.find((item) => item.id === goal.id))}
                    disabled={action.busy}
                  >
                    <Pencil size={15} aria-hidden="true" />
                    Edit allocation
                  </button>
                  <button
                    className="icon-button danger-icon"
                    aria-label={`Delete goal ${goal.title}`}
                    disabled={action.busy}
                    onClick={() => void remove(goal.id, goal.title)}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="empty-state">
            <Target size={30} aria-hidden="true" />
            <h3>Start with something worth saving for.</h3>
            <p>
              Add a target. Reserve cash when you have it, and see what is still needed each week.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

export function Planning({ monthKey, asOf, budget, context, notify }: GoalProps) {
  const store = useSpendSmart();
  const [tab, setTab] = useState<'income' | 'upcoming' | 'goals'>('income');
  const plan = store.planning.find((item) => item.monthKey === monthKey);
  return (
    <div className="planning-stack">
      <div className="planning-tabs" role="tablist" aria-label="Student planning" onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const tabs = ['income', 'upcoming', 'goals'] as const;
        const current = tabs.indexOf(tab);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (current + (event.key === 'ArrowRight' ? 1 : 2)) % 3;
        setTab(tabs[next]);
        event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
      }}>
        <button id="planning-tab-income" role="tab" aria-controls="planning-panel" tabIndex={tab === 'income' ? 0 : -1} aria-selected={tab === 'income'} onClick={() => setTab('income')}>
          <CircleDollarSign size={17} aria-hidden="true" />
          Allowance
        </button>
        <button id="planning-tab-upcoming" role="tab" aria-controls="planning-panel" tabIndex={tab === 'upcoming' ? 0 : -1} aria-selected={tab === 'upcoming'} onClick={() => setTab('upcoming')}>
          <CalendarCheck size={17} aria-hidden="true" />
          Upcoming expenses
        </button>
        <button id="planning-tab-goals" role="tab" aria-controls="planning-panel" tabIndex={tab === 'goals' ? 0 : -1} aria-selected={tab === 'goals'} onClick={() => setTab('goals')}>
          <Target size={17} aria-hidden="true" />
          Savings goals
        </button>
      </div>
      <div
        id="planning-panel"
        aria-labelledby={`planning-tab-${tab}`}
        role="tabpanel"
        aria-label={
          tab === 'income'
            ? 'Allowance plan'
            : tab === 'upcoming'
              ? 'Upcoming expenses'
              : 'Savings goals'
        }
      >
        {tab === 'income' && (
          <AllowanceForm
            key={`${monthKey}-${JSON.stringify(plan)}`}
            monthKey={monthKey}
            plan={plan}
            notify={notify}
          />
        )}
        {tab === 'upcoming' && <Upcoming monthKey={monthKey} asOf={asOf} notify={notify} />}
        {tab === 'goals' && (
          <Goals
            monthKey={monthKey}
            asOf={asOf}
            budget={budget}
            context={context}
            notify={notify}
          />
        )}
      </div>
    </div>
  );
}
