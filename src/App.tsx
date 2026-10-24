import {
  Component,
  Suspense,
  lazy,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronRight,
  CircleHelp,
  LayoutDashboard,
  Leaf,
  LogOut,
  Plus,
  ReceiptText,
  ShieldCheck,
  SlidersHorizontal,
  TrendingUp,
  Wallet,
  X,
  CalendarCheck,
  RotateCcw,
} from 'lucide-react';
import { Transactions } from './components/Transactions';
import { Planning } from './components/Planning';
import type { FinancialContext } from './domain/planning-types';
import { useSpendSmart } from './data/SpendSmartProvider';
import { cloudConfigured } from './data/firebase';
import {
  formatMoney,
  monthLabel,
  parseAmount,
  todayISO,
  validateBudget,
  validateTransaction,
} from './domain/engine';
import {
  EXPENSE_CATEGORIES,
  INCOME_CATEGORIES,
  type Budget,
  type Transaction,
  type TransactionInput,
  type TransactionType,
} from './domain/types';

type Page = 'dashboard' | 'transactions' | 'budgets' | 'planning' | 'reports' | 'guide';
const Dashboard = lazy(() =>
  import('./components/Insights').then((module) => ({ default: module.Dashboard })),
);
const Reports = lazy(() =>
  import('./components/Insights').then((module) => ({ default: module.Reports })),
);
const pages = [
  { id: 'dashboard' as const, label: 'Overview', icon: LayoutDashboard },
  { id: 'transactions' as const, label: 'Transactions', icon: ReceiptText },
  { id: 'budgets' as const, label: 'Budgets', icon: Wallet },
  { id: 'planning' as const, label: 'Plan ahead', icon: CalendarCheck },
  { id: 'reports' as const, label: 'Reports', icon: TrendingUp },
  { id: 'guide' as const, label: 'How it works', icon: CircleHelp },
];

function amountInput(paise: number): string {
  const value = BigInt(paise);
  return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
}

class InsightsBoundary extends Component<
  { children: ReactNode; onOpenLedger: () => void; resetSignal?: unknown },
  { message: string | null }
> {
  state: { message: string | null } = { message: null };
  static getDerivedStateFromError(error: Error) {
    return { message: error.message };
  }
  componentDidUpdate(previous: this['props']) {
    if (this.state.message && previous.resetSignal !== this.props.resetSignal)
      this.setState({ message: null });
  }
  render() {
    if (this.state.message)
      return (
        <section className="panel">
          <h2>These totals need a closer look.</h2>
          <p className="muted">{this.state.message}</p>
          <button className="button button-secondary" onClick={this.props.onOpenLedger}>
            Review transactions
          </button>
        </section>
      );
    return this.props.children;
  }
}

function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <Wallet size={23} aria-hidden="true" />
      </span>
      <span>
        spend<span className="brand-light">smart</span>
        <small>BUDGET INTELLIGENCE FOR STUDENTS</small>
      </span>
    </div>
  );
}

function AuthScreen() {
  const store = useSpendSmart();
  const [view, setView] = useState<'login' | 'signup' | 'reset'>('login');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [formError, setFormError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    setFormError('');
    const data = new FormData(event.currentTarget);
    try {
      const email = String(data.get('email')).trim();
      const password = String(data.get('password') ?? '');
      if (view === 'signup') await store.signUp(String(data.get('name')).trim(), email, password);
      else if (view === 'reset') {
        await store.resetPassword(email);
        setMessage('If an account exists for that email, a password reset link will arrive.');
      } else await store.signIn(email, password);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  }
  function switchView(next: typeof view) {
    setView(next);
    setMessage('');
    setFormError('');
    store.clearError();
  }
  return (
    <main className="auth-page">
      <section className="auth-story">
        <Brand />
        <div className="auth-story-content">
          <span className="story-tag">BUILT FOR STUDENT LIFE</span>
          <h1>
            Your money,
            <br />a little <em>clearer.</em>
          </h1>
          <p>
            From the canteen to the end of the month. Know where your money goes, what is safe to
            spend, and why.
          </p>
          <div className="story-preview">
            <div className="story-preview-icon">
              <TrendingUp aria-hidden="true" />
            </div>
            <div>
              <strong>See the month ahead.</strong>
              <span>Spending pace. Daily guidance. Clear explanations.</span>
            </div>
            <Check size={20} aria-hidden="true" />
          </div>
        </div>
        <p className="auth-footnote">
          <ShieldCheck size={16} aria-hidden="true" /> Your ledger. Your account. No bank
          credentials.
        </p>
      </section>
      <section className="auth-form-side">
        <div className="auth-card">
          <span className="eyebrow">A SMALL STEP TOWARD BETTER HABITS</span>
          <h2>
            {view === 'signup'
              ? 'Make yourself at home.'
              : view === 'reset'
                ? 'Let’s get you back in.'
                : 'Welcome to SpendSmart.'}
          </h2>
          <p className="muted">
            {view === 'signup'
              ? 'Create your private student spending account.'
              : view === 'reset'
                ? 'We’ll send a password reset link to your email.'
                : 'A calmer way to keep your budget on track.'}
          </p>
          {view !== 'reset' && (
            <div className="auth-tabs">
              <button
                className={view === 'login' ? 'active' : ''}
                onClick={() => switchView('login')}
              >
                Log in
              </button>
              <button
                className={view === 'signup' ? 'active' : ''}
                onClick={() => switchView('signup')}
              >
                Create account
              </button>
            </div>
          )}
          {!cloudConfigured && (
            <div className="setup-note">
              <BookOpen size={18} aria-hidden="true" />
              <p>
                Cloud sign-in is not configured yet. Try the working demo below; your demo records
                stay in this browser.
              </p>
            </div>
          )}
          <form onSubmit={submit} className="stack-form">
            {view === 'signup' && (
              <label>
                Your name
                <input
                  name="name"
                  autoComplete="name"
                  placeholder="What should we call you?"
                  required
                  minLength={2}
                  maxLength={80}
                  disabled={!cloudConfigured || busy}
                />
              </label>
            )}
            <label>
              Email address
              <input
                type="email"
                name="email"
                autoComplete="email"
                placeholder="you@college.edu"
                required
                disabled={!cloudConfigured || busy}
              />
            </label>
            {view !== 'reset' && (
              <label>
                Password
                <input
                  type="password"
                  name="password"
                  autoComplete={view === 'signup' ? 'new-password' : 'current-password'}
                  minLength={6}
                  maxLength={128}
                  required
                  placeholder="At least 6 characters"
                  disabled={!cloudConfigured || busy}
                />
              </label>
            )}
            {(formError || store.error) && (
              <p className="form-error" role="alert">
                {formError || store.error}
              </p>
            )}
            {message && (
              <p className="form-success" role="status">
                {message}
              </p>
            )}
            <button className="button button-primary" disabled={!cloudConfigured || busy}>
              {busy
                ? 'One moment…'
                : view === 'signup'
                  ? 'Create my account'
                  : view === 'reset'
                    ? 'Send reset link'
                    : 'Log in'}
              <ChevronRight size={17} aria-hidden="true" />
            </button>
          </form>
          <button
            className="text-button auth-reset"
            onClick={() => switchView(view === 'reset' ? 'login' : 'reset')}
          >
            {view === 'reset' ? 'Back to log in' : 'Forgot your password?'}
          </button>
          <div className="auth-divider">
            <span>or take a look around</span>
          </div>
          <button
            className="button button-secondary demo-button"
            onClick={() => {
              setFormError('');
              store.startDemo();
            }}
          >
            Try the free demo <ArrowUpRight size={17} aria-hidden="true" />
          </button>
          <p className="auth-fine-print">
            No signup needed for the demo. Sample data is clearly labeled.
          </p>
        </div>
      </section>
    </main>
  );
}

function TransactionDialog({
  transaction,
  initialType = 'expense',
  onClose,
  onSaved,
}: {
  transaction?: Transaction;
  initialType?: TransactionType;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const store = useSpendSmart();
  const dialog = useRef<HTMLDialogElement>(null);
  const [type, setType] = useState<TransactionType>(transaction?.type ?? initialType);
  const [category, setCategory] = useState(
    transaction?.category ?? (initialType === 'income' ? 'Allowance' : 'Food'),
  );
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const operationId = useRef(crypto.randomUUID());
  const [error, setError] = useState('');
  const categories = type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element?.showModal();
    element?.querySelector<HTMLInputElement>('input')?.focus();
    return () => { if (element?.open) element.close(); previousFocus?.focus(); };
  }, []);
  function changeType(next: TransactionType) {
    setType(next);
    const allowed = next === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
    if (!(allowed as readonly string[]).includes(category)) setCategory(allowed[0]);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setError('');
    setBusy(true);
    try {
      const data = new FormData(event.currentTarget);
      const input: TransactionInput = {
        type,
        currency: 'INR',
        category,
        amountPaise: parseAmount(String(data.get('amount'))),
        date: String(data.get('date')),
        note: String(data.get('note') ?? '').trim(),
      };
      validateTransaction(input, todayISO());
      if (transaction) await store.updateTransaction(transaction.id, input);
      else await store.addTransaction(input, operationId.current);
      onSaved(
        transaction ? 'Transaction updated.' : 'Transaction added. Your guidance is up to date.',
      );
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not save this transaction.');
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="transaction-dialog"
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
      }}
      aria-labelledby="transaction-dialog-title"
    >
      <div className="dialog-heading">
        <div>
          <span className="eyebrow">KEEP YOUR LEDGER CURRENT</span>
          <h2 id="transaction-dialog-title">
            {transaction ? 'Edit transaction' : 'Add a transaction'}
          </h2>
        </div>
        <button
          className="icon-button"
          aria-label="Close transaction form"
          onClick={onClose}
          disabled={busy}
        >
          <X aria-hidden="true" />
        </button>
      </div>
      <form onSubmit={submit} className="stack-form">
        <fieldset className="type-picker">
          <legend className="sr-only">Transaction type</legend>
          {(['expense', 'income', 'refund'] as const).map((value) => (
            <button
              type="button"
              key={value}
              aria-pressed={type === value}
              className={type === value ? 'selected' : ''}
              disabled={busy}
              onClick={() => changeType(value)}
            >
              {value}
            </button>
          ))}
        </fieldset>
        {type === 'refund' && (
          <p className="field-help">
            Refunds return cash and reduce spending in their recorded month and category. They are
            not new income.
          </p>
        )}
        <label>
          Amount (₹)
          <input
            name="amount"
            inputMode="decimal"
            placeholder="0.00"
            required
            defaultValue={transaction ? amountInput(transaction.amountPaise) : ''}
            disabled={busy}
          />
        </label>
        <div className="form-two-columns">
          <label>
            Category
            <select
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              disabled={busy}
            >
              {categories.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            Date
            <input
              name="date"
              type="date"
              required
              max={todayISO()}
              defaultValue={transaction?.date ?? todayISO()}
              disabled={busy}
            />
          </label>
        </div>
        <label>
          Note <span className="optional">optional</span>
          <input
            name="note"
            maxLength={500}
            placeholder="Lunch with friends, bus pass…"
            defaultValue={transaction?.note ?? ''}
            disabled={busy}
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button
            type="button"
            className="button button-secondary"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button className="button button-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save transaction'}
            <Check size={16} aria-hidden="true" />
          </button>
        </div>
      </form>
    </dialog>
  );
}

function BudgetEditor({
  monthKey,
  budget,
  notify,
}: {
  monthKey: string;
  budget?: Budget;
  notify: (message: string) => void;
}) {
  const store = useSpendSmart();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const form = new FormData(event.currentTarget);
      function amount(field: string) {
        const text = String(form.get(field) ?? '').trim();
        return !text || /^0(?:\.0{1,2})?$/.test(text) ? 0 : parseAmount(text);
      }
      const input: Budget = { monthKey, limitPaise: amount('limit'), categoryLimits: {} };
      for (const category of EXPENSE_CATEGORIES) {
        const value = amount(category);
        if (value > 0) input.categoryLimits[category] = value;
      }
      validateBudget(input);
      await store.saveBudget(input);
      notify('Budget saved. Your forecast and alerts have been refreshed.');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not save your budget.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="budget-page">
      <section className="panel">
        <div className="section-heading">
          <div>
            <span className="eyebrow">GIVE YOUR MONTH SOME DIRECTION</span>
            <h2>A plan for {monthLabel(monthKey)}</h2>
            <p className="muted">Your spending limit is a guide you can adjust as life changes.</p>
          </div>
          <span className="budget-heading-icon">
            <Wallet size={27} aria-hidden="true" />
          </span>
        </div>
        <label className="monthly-limit-label">
          Monthly spending limit (₹)
          <input
            name="limit"
            inputMode="decimal"
            placeholder="e.g. 8000.00"
            defaultValue={budget?.limitPaise ? amountInput(budget.limitPaise) : ''}
            disabled={busy}
          />
        </label>
        <p className="field-help">
          Leave blank or enter zero to keep the monthly limit unset. Income does not automatically
          change this limit.
        </p>
      </section>
      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Make room for each category</h2>
            <p className="muted">
              Optional category limits help you spot where the pressure is building.
            </p>
          </div>
          <SlidersHorizontal size={23} aria-hidden="true" />
        </div>
        <div className="category-limit-grid">
          {EXPENSE_CATEGORIES.map((category) => (
            <label key={category}>
              {category}
              <span className="currency-input">
                <span aria-hidden="true">₹</span>
                <input
                  name={category}
                  inputMode="decimal"
                  placeholder="No limit"
                  defaultValue={
                    budget?.categoryLimits[category]
                      ? amountInput(budget.categoryLimits[category])
                      : ''
                  }
                  disabled={busy}
                />
              </span>
            </label>
          ))}
        </div>
        <p className="field-help">
          Category limits are independent guides. Their total does not need to equal your monthly
          limit.
        </p>
      </section>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="budget-save-row">
        <p className="muted">
          <ShieldCheck size={16} aria-hidden="true" /> Applies only to {monthLabel(monthKey)}.
        </p>
        <button className="button button-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save budget'}
          <Check size={17} aria-hidden="true" />
        </button>
      </div>
    </form>
  );
}

function Guide({ isDemo }: { isDemo: boolean }) {
  return (
    <section className="guide-page">
      <div className="panel guide-intro">
        <span className="eyebrow">NO MYSTERY MATH</span>
        <h2>Every recommendation has a reason.</h2>
        <p>
          SpendSmart uses your recorded transactions and budget to explain your spending pace. Open
          “Why this alert?” on an alert to see its inputs.
        </p>
      </div>
      <div className="guide-grid">
        {[
          [
            'Budget usage',
            'Net spending ÷ monthly limit × 100',
            'A warning starts at 80%. Spending above 100% means the limit has been exceeded. An unset or zero limit produces no percentage.',
          ],
          [
            'Month-end forecast',
            'Net spending ÷ elapsed days × days in month',
            'This is a projection of your current pace, not a prediction of future purchases. A forecast above your limit triggers a pace-risk alert.',
          ],
          [
            'Safe daily allowance',
            'Remaining budget ÷ days after today',
            'The allowance is rounded down to the nearest paise. On the last day, it is the remaining amount for today. Historical months do not show daily guidance.',
          ],
          [
            'Refunds and balance',
            'Income + refunds − expenses',
            'Refunds return cash and reduce spending in the month and category recorded. Budget spending is floored at zero; excess refunds still affect your cash balance.',
          ],
        ].map(([title, formula, explanation]) => (
          <article className="panel guide-card" key={title}>
            <h3>{title}</h3>
            <code>{formula}</code>
            <p className="muted">{explanation}</p>
          </article>
        ))}
      </div>
      <section className="panel">
        <h3>{isDemo ? 'About your demo ledger' : 'About your private ledger'}</h3>
        <p className="muted">
          {isDemo
            ? 'This is a local demo with sample transactions. Edits are saved in this browser only, and are not uploaded. Anyone with access to this browser may see these demo records. Cloud login uses a separate ledger.'
            : 'Your records are scoped to your signed-in account. They are entered by you; SpendSmart does not connect to your bank.'}
        </p>
        <p className="muted">
          Amounts use INR. Dates use your local calendar. The month picker determines which month
          your dashboard and budget show. Future transaction dates are not accepted.
        </p>
      </section>
    </section>
  );
}

function Workspace() {
  const store = useSpendSmart();
  const [page, setPage] = useState<Page>('dashboard');
  const [asOf, setAsOf] = useState(todayISO());
  const [monthKey, setMonthKey] = useState(todayISO().slice(0, 7));
  const [editing, setEditing] = useState<Transaction | null | undefined>(undefined);
  const [draftType, setDraftType] = useState<TransactionType>('expense');
  const [setupDismissed, setSetupDismissed] = useState(false);
  const [toast, setToast] = useState('');
  const selectStoreMonth = store.setSelectedMonth;
  useEffect(() => {
    selectStoreMonth(monthKey);
  }, [monthKey, selectStoreMonth]);
  useEffect(() => {
    const timer = setInterval(() => setAsOf(todayISO()), 60000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 5000);
    return () => clearTimeout(timer);
  }, [toast]);
  const budget = store.budgets.find((item) => item.monthKey === monthKey);
  const activePage = pages.find((item) => item.id === page)!;
  const isDemo = store.mode === 'demo';
  const studentPlan = store.planning.find((item) => item.monthKey === monthKey);
  const financialContext = useMemo<FinancialContext>(
    () => ({
      planning: studentPlan,
      plannedExpenses: store.plannedExpenses,
      goals: store.goals,
      balanceOverridePaise: isDemo ? undefined : store.ledgerBalancePaise,
    }),
    [studentPlan, store.plannedExpenses, store.goals, isDemo, store.ledgerBalancePaise],
  );
  const monthlyTransactions = store.transactions.filter((item) => item.date.startsWith(monthKey));
  const showSetup =
    !setupDismissed && !isDemo && (!budget?.limitPaise || monthlyTransactions.length === 0);
  const userName = store.user?.displayName?.split(' ')[0] || 'there';
  const heading =
    page === 'dashboard'
      ? `A clearer picture, ${userName}.`
      : page === 'transactions'
        ? 'Your everyday money story.'
        : page === 'budgets'
          ? 'Plan a little. Breathe easier.'
          : page === 'reports'
            ? 'Find the patterns that matter.'
            : page === 'planning'
              ? 'Make room for what is next.'
              : 'Clear numbers. Clear reasons.';
  return (
    <div className="app-layout">
      <aside className="sidebar">
        <Brand />
        <div className="sidebar-label">YOUR MONEY SPACE</div>
        <nav aria-label="Main navigation">
          {pages.map((item) => (
            <button
              key={item.id}
              onClick={() => setPage(item.id)}
              aria-current={page === item.id ? 'page' : undefined}
              className={page === item.id ? 'nav-item selected' : 'nav-item'}
            >
              <item.icon size={20} aria-hidden="true" />
              <span>{item.label}</span>
              {page === item.id && <span className="nav-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-tip">
          <span className="tip-leaf">
            <Leaf size={20} aria-hidden="true" />
          </span>
          <strong>
            Little habits.
            <br />
            More possibilities.
          </strong>
          <p>Your next good money decision starts with knowing where you stand.</p>
        </div>
        <div className="sidebar-profile">
          <span className="avatar">{userName.charAt(0).toUpperCase()}</span>
          <div>
            <strong>{store.user?.displayName || 'Student'}</strong>
            <span>{isDemo ? 'Local demo ledger' : store.user?.email}</span>
          </div>
          <button
            className="icon-button"
            aria-label="Log out"
            onClick={() => void store.signOut().catch(() => {})}
          >
            <LogOut size={18} aria-hidden="true" />
          </button>
        </div>
      </aside>
      <div className="main-workspace">
        <header className="topbar">
          <div className="mobile-brand">
            <Brand />
          </div>
          <span className="breadcrumb">
            Your money space <ChevronRight size={14} aria-hidden="true" />{' '}
            <strong>{activePage.label}</strong>
          </span>
          <div className="topbar-right">
            <span className={`mode-badge ${isDemo ? 'demo' : ''}`}>
              <span />
              {isDemo
                ? store.syncStatus === 'session-only'
                  ? 'Demo · session only'
                  : 'Demo · saved on this device'
                : store.syncStatus === 'synced'
                  ? 'Private cloud ledger · synced'
                  : `Cloud · ${store.syncStatus}`}
            </span>
            <button
              className="icon-button mobile-logout"
              aria-label="Log out"
              onClick={() => void store.signOut().catch(() => {})}
            >
              <LogOut size={18} aria-hidden="true" />
            </button>
          </div>
        </header>
        <main className="main-content">
          <div className="page-heading">
            <div>
              <span className="eyebrow">
                {isDemo ? 'SAMPLE LEDGER · MAKE IT YOUR OWN' : 'A LITTLE CLARITY GOES A LONG WAY'}
              </span>
              <h1>{heading}</h1>
              <p className="muted">
                {page === 'dashboard'
                  ? 'Your spending, your pace, and a plan for what comes next.'
                  : `${activePage.label} for your student spending journey.`}
              </p>
            </div>
            <div className="page-tools">
              <label className="month-picker">
                <span className="sr-only">Selected month</span>
                <input
                  type="month"
                  value={monthKey}
                  max="2100-12"
                  min="2000-01"
                  onChange={(event) => {
                    if (
                      /^\d{4}-(0[1-9]|1[0-2])$/.test(event.target.value) &&
                      event.target.value >= '2000-01' &&
                      event.target.value <= '2100-12'
                    )
                      setMonthKey(event.target.value);
                  }}
                />
              </label>
              <button
                className="button button-primary"
                onClick={() => setEditing(null)}
                disabled={!store.ready}
              >
                <Plus size={18} aria-hidden="true" />
                <span>Add transaction</span>
              </button>
            </div>
          </div>
          {!store.ready && (
            <section className="panel">
              <p className="muted" role="status">
                Loading your selected month…
              </p>
            </section>
          )}
          {store.error && (
            <div className="error-banner" role="alert">
              <span>{store.error}</span>
              <button className="icon-button" aria-label="Dismiss error" onClick={store.clearError}>
                <X size={18} aria-hidden="true" />
              </button>
            </div>
          )}
          {!isDemo && store.syncStatus !== 'synced' && (
            <div className="sync-notice" role="status">
              <span>
                {store.syncStatus === 'offline'
                  ? 'You are offline. Cached records may be visible; exact cloud totals need a connection.'
                  : store.syncStatus === 'pending'
                    ? 'Waiting for cloud confirmation. Keep this page open; retrying uses the same transaction ID.'
                    : 'Some cloud data could not be confirmed. Amounts that are unavailable stay marked as unknown.'}
              </span>
              <button
                className="button button-secondary"
                onClick={() => void store.refreshCloud().catch(() => {})}
              >
                Retry sync
              </button>
            </div>
          )}
          {showSetup && store.ready && page === 'dashboard' && (
            <section className="panel onboarding">
              <div>
                <span className="eyebrow">YOUR FIRST USEFUL INSIGHT</span>
                <h2>Three small steps to a clearer month.</h2>
                <p className="muted">
                  A budget is a spending cap. Record money you actually have, then your first
                  expense.
                </p>
              </div>
              <div className="onboarding-steps">
                <button className="button button-secondary" onClick={() => setPage('budgets')}>
                  {budget?.limitPaise ? <Check size={16} aria-hidden="true" /> : '1.'} Set a budget
                </button>
                <button
                  className="button button-secondary"
                  onClick={() => {
                    setDraftType('income');
                    setEditing(null);
                  }}
                >
                  {monthlyTransactions.some((item) => item.type === 'income') ? (
                    <Check size={16} aria-hidden="true" />
                  ) : (
                    '2.'
                  )}{' '}
                  Record income
                </button>
                <button
                  className="button button-secondary"
                  onClick={() => {
                    setDraftType('expense');
                    setEditing(null);
                  }}
                >
                  {monthlyTransactions.some((item) => item.type === 'expense') ? (
                    <Check size={16} aria-hidden="true" />
                  ) : (
                    '3.'
                  )}{' '}
                  Add an expense
                </button>
                <button className="text-button" onClick={() => setSetupDismissed(true)}>
                  Skip setup for now
                </button>
              </div>
            </section>
          )}
          {store.ready && (page === 'dashboard' || page === 'reports') && (
            <InsightsBoundary
              key={`${page}-${monthKey}`}
              resetSignal={store.transactions}
              onOpenLedger={() => setPage('transactions')}
            >
              <Suspense
                fallback={
                  <section className="panel">
                    <p className="muted" role="status">
                      Preparing your spending insights…
                    </p>
                  </section>
                }
              >
                {page === 'dashboard' ? (
                  <Dashboard
                    transactions={store.transactions}
                    budget={budget}
                    monthKey={monthKey}
                    asOf={asOf}
                    context={financialContext}
                    monthTrend={isDemo ? undefined : store.monthTrend}
                    onAddTransaction={() => setEditing(null)}
                    onOpenBudgets={() => setPage('budgets')}
                  />
                ) : (
                  <Reports
                    transactions={store.transactions}
                    budget={budget}
                    monthKey={monthKey}
                    asOf={asOf}
                    context={financialContext}
                    monthTrend={isDemo ? undefined : store.monthTrend}
                  />
                )}
              </Suspense>
            </InsightsBoundary>
          )}
          {store.ready && page === 'transactions' && (
            <Transactions
              key={monthKey}
              monthKey={monthKey}
              asOf={asOf}
              onEdit={setEditing}
              onAdded={() => setEditing(null)}
              notify={setToast}
            />
          )}
          {store.ready && page === 'budgets' && (
            <>
              <BudgetEditor
                key={`${monthKey}-${JSON.stringify(budget)}`}
                monthKey={monthKey}
                budget={budget}
                notify={setToast}
              />
              <section className="panel budget-history">
                <h2>Budget history</h2>
                <p className="muted">
                  Each period has its own cap. Category limits are part of that plan, not extra
                  money.
                </p>
                <div className="budget-history-list">
                  {store.budgets
                    .slice()
                    .sort((a, b) => b.monthKey.localeCompare(a.monthKey))
                    .map((item) => (
                      <button
                        key={item.monthKey}
                        className={`button button-secondary ${item.monthKey === monthKey ? 'selected' : ''}`}
                        onClick={() => setMonthKey(item.monthKey)}
                      >
                        {monthLabel(item.monthKey)}
                        <strong>
                          {item.limitPaise ? formatMoney(item.limitPaise) : 'Not set'}
                        </strong>
                      </button>
                    ))}
                </div>
              </section>
            </>
          )}
          {store.ready && page === 'planning' && (
            <InsightsBoundary
              key={monthKey}
              resetSignal={financialContext}
              onOpenLedger={() => setPage('transactions')}
            >
              <Planning
                monthKey={monthKey}
                asOf={asOf}
                budget={budget}
                context={financialContext}
                notify={setToast}
              />
            </InsightsBoundary>
          )}
          {store.ready && page === 'guide' && (
            <>
              <Guide isDemo={isDemo} />
              <section className="panel judge-demo">
                <span className="eyebrow">A REPEATABLE 90-SECOND DEMO</span>
                <h2>From a transaction to a better decision.</h2>
                <ol>
                  <li>Reset the demo below. In Budgets, set this month’s overall limit to ₹12,000.</li>
                  <li>Open Overview. Compare recorded cash, budget remaining and today’s allowance.</li>
                  <li>
                    Add a ₹250 Food expense. Watch today’s affordable amount and the forecast
                    update.
                  </li>
                  <li>Lower the overall budget to ₹8,000. Open the risk alert to inspect its figures and formula.</li>
                  <li>
                    Open Reports and try a ₹500 category reduction. The real ledger stays unchanged.
                  </li>
                </ol>
                <div className="judge-demo-actions">
                  <button className="button button-primary" onClick={() => setPage('dashboard')}>
                    Open overview
                    <ChevronRight size={16} aria-hidden="true" />
                  </button>
                  <button className="button button-secondary" onClick={() => setPage('reports')}>
                    Try a simulation
                  </button>
                  {isDemo && (
                    <button
                      className="button button-secondary"
                      onClick={async () => {
                        if (
                          window.confirm(
                            'Reset this local demo to its sample transactions, budgets and plans? Your changes to the demo will be replaced.',
                          )
                        ) {
                          try {
                            await store.resetDemo();
                            setMonthKey(todayISO().slice(0, 7));
                            setToast('Local demo reset to the repeatable sample scenario.');
                          } catch {
                            /* Store shows the error. */
                          }
                        }
                      }}
                    >
                      <RotateCcw size={16} aria-hidden="true" />
                      Reset demo scenario
                    </button>
                  )}
                </div>
                <p className="field-help">
                  {isDemo
                    ? 'All sample figures are computed from the local demo records. Reset affects only this demo in this browser.'
                    : 'For a safe demonstration, log out and choose the local demo. Your private cloud ledger is separate.'}
                </p>
              </section>
            </>
          )}
          <footer className="workspace-footer">
            <Leaf size={14} aria-hidden="true" />
            <span>SpendSmart · Explainable budget intelligence for students.</span>
            <span>Amounts in INR</span>
          </footer>
        </main>
      </div>
      {editing !== undefined && (
        <TransactionDialog
          transaction={editing ?? undefined}
          initialType={draftType}
          onClose={() => {
            setEditing(undefined);
            setDraftType('expense');
          }}
          onSaved={setToast}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={18} aria-hidden="true" />
          {toast}
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setToast('')}
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const store = useSpendSmart();
  if (!store.ready && !store.user)
    return (
      <main className="loading-page">
        <Brand />
        <p role="status">Opening your money space…</p>
      </main>
    );
  return store.user ? <Workspace key={`${store.mode}-${store.user.uid}`} /> : <AuthScreen />;
}
