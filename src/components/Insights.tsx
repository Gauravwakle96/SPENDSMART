import { useMemo, useState, type FormEvent } from 'react';
import { ArrowDownLeft, ArrowRight, ArrowUpRight, CalendarDays, Download, Info, Plus, ReceiptText, ShieldCheck, SlidersHorizontal, TrendingUp, Wallet, type LucideIcon } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatMoney, getMonthlyTrend, monthLabel, parseAmount, transactionsToCSV } from '../domain/engine';
import { getFinancialIntelligence, simulateExpenseReduction, type FinancialIntelligence } from '../domain/intelligence';
import type { FinancialContext, MonthlySummary } from '../domain/planning-types';
import { EXPENSE_CATEGORIES, type Budget, type BudgetAlert, type BudgetInsights, type Transaction } from '../domain/types';
import './insights.css';

interface InsightProps {
  transactions: Transaction[];
  budget: Budget | undefined;
  monthKey: string;
  asOf: string;
  context?: FinancialContext;
  /** Undefined derives a complete local history; null explicitly means unavailable. */
  monthTrend?: MonthlySummary[] | null;
}

interface DashboardProps extends InsightProps {
  onAddTransaction: () => void;
  onOpenBudgets: () => void;
}

const CATEGORY_COLORS = ['#172339', '#dba84b', '#26715b', '#7c91a8', '#b78c62', '#718a79', '#a7b5bd', '#c8d0d2'];
const CHART_TOOLTIP_STYLE = { border: '1px solid #dce1e4', borderRadius: 10, fontSize: 12, color: '#18263a', boxShadow: '0 8px 24px #17233912' };
const FORECAST_LABELS = { unavailable: 'Unavailable', early: 'Early estimate', 'run-rate': 'Run-rate estimate', historical: 'Actual month' } as const;

function moneyOrUnknown(value: number | null | undefined): string {
  return value === null || value === undefined ? 'Unavailable' : formatMoney(value);
}

function varianceLabel(value: number | null): string {
  if (value === null) return 'Unavailable';
  return value === 0 ? 'On budget' : `${formatMoney(Math.abs(value))} ${value < 0 ? 'over' : 'under'}`;
}

function axisMoney(paise: number): string {
  return `₹${new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 }).format(paise / 100)}`;
}

function percent(value: number | null): string {
  return value === null ? '—' : `${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 }).format(value)}%`;
}

function dateLabel(date: string): string {
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' }).format(new Date(`${date}T12:00:00`));
}

function Stat({ label, value, note, icon: Icon }: { label: string; value: string; note: string; icon: LucideIcon }) {
  return (
    <div className="panel insights-stat">
      <div className="insights-stat-heading"><span>{label}</span><Icon size={18} aria-hidden="true" /></div>
      <div className="insights-stat-value">{value}</div>
      <p className="insights-stat-note">{note}</p>
    </div>
  );
}

function AlertCard({ alert }: { alert: BudgetAlert }) {
  return (
    <article className={`insights-alert insights-alert-${alert.severity}`} data-reason-code={alert.code}>
      <Info size={19} aria-hidden="true" />
      <div>
        <div className="insights-alert-title"><h3>{alert.title}</h3><span className="insights-reason-code">{alert.code.replaceAll('_', ' ').toLowerCase()}</span></div>
        <p>{alert.message}</p>
        {alert.formula && <details className="insights-explanation"><summary>Show the calculation</summary><p>{alert.formula}</p></details>}
      </div>
    </article>
  );
}

function PaceChart({ insights, currentMonth, forecastReady }: { insights: BudgetInsights; currentMonth: boolean; forecastReady: boolean }) {
  const points = new Map(insights.chartData.map((point) => [point.day, point]));
  let lastActual = 0;
  const chartData = Array.from({ length: insights.daysInMonth }, (_, index) => {
    const day = index + 1;
    const point = points.get(day);
    if (point) lastActual = point.cumulativePaise;
    return {
      day,
      actual: day <= insights.elapsedDays ? lastActual : null,
      ideal: insights.limitPaise === null ? null : Math.round(insights.limitPaise * day / insights.daysInMonth),
      projection: currentMonth && forecastReady && insights.elapsedDays > 0 && day >= insights.elapsedDays
        ? Math.round(insights.forecastPaise * day / insights.daysInMonth) : null,
    };
  });
  const hasActual = insights.totalExpensePaise > 0 || insights.totalRefundPaise > 0;
  return (
    <section className="panel insights-chart-panel">
      <div className="insights-panel-heading"><div><h2>Spending pace</h2><p>Recorded spend, budget pace, and the month-end run-rate.</p></div><TrendingUp size={18} aria-hidden="true" /></div>
      {!hasActual && insights.netSpendPaise === 0 && <p className="insights-inline-empty">Your spending line will take shape as you add expenses.</p>}
      <div className="insights-chart" role="img" aria-label={`Spending pace: ${formatMoney(insights.netSpendPaise)} spent${insights.limitPaise !== null ? ` against a ${formatMoney(insights.limitPaise)} monthly budget` : ''}${currentMonth && forecastReady ? `; month-end run-rate ${formatMoney(insights.forecastPaise)}` : ''}.`}>
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <LineChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }} accessibilityLayer>
            <CartesianGrid vertical={false} stroke="#e6eaed" strokeDasharray="3 3" />
            <XAxis dataKey="day" tickLine={false} axisLine={false} minTickGap={28} tick={{ fill: '#5d6c7b', fontSize: 11 }} tickFormatter={(day: number) => `${day}`} />
            <YAxis tickLine={false} axisLine={false} width={58} tick={{ fill: '#5d6c7b', fontSize: 11 }} tickFormatter={axisMoney} />
            <Tooltip contentStyle={CHART_TOOLTIP_STYLE} labelFormatter={(day) => `Day ${day}`} formatter={(value, name) => [formatMoney(Number(value)), name]} />
            <Line name="Budget pace" type="linear" dataKey="ideal" stroke="#99a7b1" strokeWidth={2} strokeDasharray="5 5" dot={false} isAnimationActive={false} />
            <Line name="Month-end run-rate" type="linear" dataKey="projection" stroke="#dba84b" strokeWidth={2} strokeDasharray="4 4" dot={false} isAnimationActive={false} />
            <Line name="Actual budget spending" type="linear" dataKey="actual" stroke="#172339" strokeWidth={3} dot={false} activeDot={{ r: 5 }} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="insights-chart-legend"><span><i className="insights-key insights-key-actual" />Actual</span><span><i className="insights-key insights-key-budget" />Budget pace</span>{currentMonth && forecastReady && <span><i className="insights-key insights-key-projection" />Run-rate</span>}</div>
      <p className="insights-chart-footnote">Actual values stop at the last elapsed day. Run-rate assumes the current spending pace continues.</p>
    </section>
  );
}

function RefundReconciliation({ intelligence }: { intelligence: FinancialIntelligence }) {
  const { base } = intelligence;
  if (base.totalRefundPaise === 0) return null;
  return <div className="insights-refund-reconciliation"><p><strong>{formatMoney(base.totalExpensePaise)}</strong> gross − <strong>{formatMoney(base.totalRefundPaise)}</strong> refunds = <strong>{formatMoney(base.netExpensePaise)}</strong> signed net.</p><p>Budget guidance uses <strong>{formatMoney(base.netSpendPaise)}</strong>, with spending floored at ₹0.{base.refundAdjustmentPaise > 0 ? ` ${formatMoney(base.refundAdjustmentPaise)} of excess category refunds is reconciled in the signed net total.` : ''}</p></div>;
}

function CategoryChart({ intelligence }: { intelligence: FinancialIntelligence }) {
  const { base } = intelligence;
  const categories = base.signedCategorySpend.filter((category) => category.grossExpensePaise > 0).sort((a, b) => b.grossExpensePaise - a.grossExpensePaise);
  return <section className="panel insights-category-panel"><div className="insights-panel-heading"><div><h2>Spending by category</h2><p>Gross expenses; refunds are reconciled below.</p></div></div>{categories.length === 0 ? <div className="insights-empty"><ReceiptText size={28} aria-hidden="true" /><h3>No expense records yet</h3><p>Your category mix appears after an expense is recorded.</p></div> : <><div className="insights-donut" aria-hidden="true"><ResponsiveContainer width="100%" height="100%" minWidth={0}><PieChart accessibilityLayer={false}><Pie rootTabIndex={-1} data={categories} dataKey="grossExpensePaise" nameKey="category" innerRadius="66%" outerRadius="86%" paddingAngle={3} stroke="none" isAnimationActive={false}>{categories.map((category, index) => <Cell key={category.category} fill={CATEGORY_COLORS[index % CATEGORY_COLORS.length]} />)}</Pie><Tooltip contentStyle={CHART_TOOLTIP_STYLE} formatter={(value) => formatMoney(Number(value))} /></PieChart></ResponsiveContainer><div className="insights-donut-center"><strong>{formatMoney(base.totalExpensePaise)}</strong><span>gross expenses</span></div></div><ul className="insights-category-legend" aria-label="Gross category expense amounts">{categories.map((category, index) => <li key={category.category}><span><i style={{ background: CATEGORY_COLORS[index % CATEGORY_COLORS.length] }} />{category.category}</span><strong>{formatMoney(category.grossExpensePaise)}</strong></li>)}</ul></>}<RefundReconciliation intelligence={intelligence} /></section>;
}

function BudgetGuidance({ insights }: { insights: BudgetInsights }) {
  const primary = insights.alerts.filter((alert) => !alert.category).slice(0, 2);
  const categoryAlerts = insights.alerts.filter((alert) => alert.category);
  if (primary.length === 0 && categoryAlerts.length === 0) return null;
  return <section className="insights-guidance" aria-label="Budget guidance"><div className="insights-alerts">{primary.map((alert) => <AlertCard key={alert.code} alert={alert} />)}</div>{categoryAlerts.length > 0 && <details className="panel insights-category-alerts"><summary>{categoryAlerts.length} category {categoryAlerts.length === 1 ? 'alert' : 'alerts'} <span>Review limits by category</span></summary><div className="insights-alerts">{categoryAlerts.map((alert) => <AlertCard key={`${alert.code}-${alert.category}`} alert={alert} />)}</div></details>}</section>;
}

function DailyExplanation({ intelligence, actualBalance }: { intelligence: FinancialIntelligence; actualBalance: number | null }) {
  const { base } = intelligence;
  return <details className="insights-daily-explanation"><summary>How today’s guidance is calculated</summary><div className="insights-daily-inputs"><dl><div><dt>Actual ledger balance</dt><dd>{moneyOrUnknown(actualBalance)}</dd></div><div><dt>Cash-backed savings reservations</dt><dd>{formatMoney(intelligence.reservedGoalsPaise)}</dd></div><div><dt>Unpaid commitments this month</dt><dd>{formatMoney(intelligence.upcomingPaise)}</dd></div><div><dt>Days including today</dt><dd>{intelligence.daysIncludingToday}</dd></div></dl><p>Today’s amount uses the smallest available cash, overall budget, and selected category headroom after commitments, divided by days including today. Expected income is a plan and does not increase today’s cash.</p><p><strong>Inclusive budget allowance:</strong> {moneyOrUnknown(intelligence.budgetDailyPaise)} per day. <strong>Original PDF after-today allowance:</strong> {moneyOrUnknown(base.safeDailyPaise)}{base.daysRemaining > 0 ? ` across ${base.daysRemaining} days after today` : ' for the last day'}.</p><p>The PDF allowance is a budget calculation. The highlighted safe amount also requires recorded cash and respects commitments and savings reservations.</p></div></details>;
}

export function Dashboard({ transactions, budget, monthKey, asOf, context, onAddTransaction, onOpenBudgets }: DashboardProps) {
  const [selectedCategory, setSelectedCategory] = useState(context?.selectedCategory ?? '');
  const selectedContext = useMemo(() => ({ ...context, selectedCategory: selectedCategory || undefined }), [context, selectedCategory]);
  const intelligence = useMemo(() => getFinancialIntelligence(transactions, budget, asOf, monthKey, selectedContext), [transactions, budget, asOf, monthKey, selectedContext]);
  const { base: insights } = intelligence;
  const currentMonth = monthKey === asOf.slice(0, 7);
  const futureMonth = monthKey > asOf.slice(0, 7);
  const actualBalance = intelligence.actualBalancePaise;
  const forecastReady = intelligence.forecastStatus === 'early' || intelligence.forecastStatus === 'run-rate';
  const usageWidth = Math.max(0, Math.min(100, insights.usagePercent ?? 0));
  if (insights.arithmeticLimited) return <section className="panel insights-chart-panel"><div className="insights-panel-heading"><div><h2>Exact calculations are unavailable</h2><p>{insights.calculationWarning}</p></div><Info size={18} aria-hidden="true" /></div><p className="insights-chart-footnote">Review oversized records in Transactions before relying on a cash balance, forecast, or spending allowance.</p><button type="button" className="button button-secondary" onClick={onOpenBudgets}>Review monthly budget</button></section>;
  return <div className="insights-view">
    <section className="insights-hero">
      <div className="insights-hero-copy"><div className="insights-hero-topline"><p className="insights-hero-eyebrow">YOUR NEXT SPENDING DECISION</p><span className={`insights-health insights-health-${intelligence.status.tone}`}><ShieldCheck size={13} aria-hidden="true" />{intelligence.status.label}</span></div><h2>{currentMonth ? 'Safe to spend today' : futureMonth ? 'Plan the month ahead' : `${monthLabel(monthKey)} snapshot`}</h2><div className="insights-hero-money">{currentMonth ? moneyOrUnknown(intelligence.safeTodayPaise) : formatMoney(insights.netExpensePaise)}<span>{currentMonth ? 'cash-backed daily guide' : 'signed net expenses'}</span></div><p className="insights-hero-description">{intelligence.status.reason}</p><div className="insights-hero-actions"><button type="button" className="button insights-hero-button" onClick={onAddTransaction}><Plus size={16} aria-hidden="true" />Add transaction</button><button type="button" className="insights-hero-link" onClick={onOpenBudgets}>{insights.limitPaise === null ? 'Set budget' : 'Edit budget'}<ArrowRight size={15} aria-hidden="true" /></button></div>{currentMonth && <DailyExplanation intelligence={intelligence} actualBalance={actualBalance} />}</div>
      <div className="insights-budget-snapshot"><div className="insights-snapshot-top"><p className="insights-snapshot-label">{monthLabel(monthKey)} limit</p><span>{insights.limitPaise === null ? 'Not set' : formatMoney(insights.limitPaise)}</span></div><div className="insights-budget-progress" role="progressbar" aria-label="Monthly budget used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={usageWidth} aria-valuetext={insights.usagePercent === null ? 'Budget not set' : `${percent(insights.usagePercent)} used`}><span style={{ width: `${usageWidth}%` }} /></div><div className="insights-snapshot-detail"><span>{insights.usagePercent === null ? 'No usage percentage' : `${percent(insights.usagePercent)} used`}</span><span>{insights.remainingPaise === null ? 'Set a limit' : insights.remainingPaise < 0 ? `${formatMoney(-insights.remainingPaise)} over` : `${formatMoney(insights.remainingPaise)} budget left`}</span></div><label className="insights-category-select"><span>Check a category before spending</span><select value={selectedCategory} onChange={(event) => setSelectedCategory(event.target.value)}><option value="">All categories</option>{EXPENSE_CATEGORIES.map((category) => <option key={category} value={category}>{category}</option>)}</select></label><p className="insights-snapshot-note">{intelligence.categoryConstraint ?? 'Category limits tighten the overall allowance; they do not add extra budget.'}</p></div>
    </section>
    <div className="insights-stat-grid"><Stat label="Actual ledger balance" value={moneyOrUnknown(actualBalance)} note={actualBalance === null ? 'Cash aggregate is not available yet' : 'Recorded cash; expected income excluded'} icon={Wallet} /><Stat label="Monthly income" value={formatMoney(insights.totalIncomePaise)} note="Income actually recorded this month" icon={ArrowDownLeft} /><Stat label="Net expenses" value={formatMoney(insights.netExpensePaise)} note="Gross expenses less recorded refunds" icon={ArrowUpRight} /><Stat label="Budget remaining" value={moneyOrUnknown(insights.remainingPaise)} note="Spending headroom; separate from cash" icon={CalendarDays} /></div>
    <section className="panel insights-forecast-band" aria-label="Forecast and budget outlook"><div><span>Month-end spending</span><strong>{forecastReady ? formatMoney(insights.forecastPaise) : intelligence.forecastStatus === 'historical' ? formatMoney(insights.netExpensePaise) : 'Unavailable'}</strong><small>{FORECAST_LABELS[intelligence.forecastStatus]}</small></div><div><span>Projected budget variance</span><strong className={intelligence.projectedBudgetVariancePaise !== null && intelligence.projectedBudgetVariancePaise < 0 ? 'insights-negative' : ''}>{varianceLabel(intelligence.projectedBudgetVariancePaise)}</strong><small>Includes unpaid monthly commitments</small></div><div><span>Projected month-end cash</span><strong className={intelligence.projectedCashBalancePaise !== null && intelligence.projectedCashBalancePaise < 0 ? 'insights-negative' : ''}>{moneyOrUnknown(intelligence.projectedCashBalancePaise)}</strong><small>Expected remaining income: {formatMoney(intelligence.expectedRemainingIncomePaise)}</small></div><p className={`insights-forecast-readiness insights-readiness-${intelligence.forecastStatus}`}><Info size={15} aria-hidden="true" /><span>{intelligence.forecastReason}</span></p></section>
    <div className="insights-main-grid"><PaceChart insights={insights} currentMonth={currentMonth} forecastReady={forecastReady} /><CategoryChart intelligence={intelligence} /></div>
    <BudgetGuidance insights={insights} />
    <div className="insights-planning-strip"><section className="panel insights-mix-panel"><div className="insights-panel-heading"><div><h2>Essential or discretionary?</h2><p>Uses your essential categories, or student defaults.</p></div></div><div className="insights-mix-values"><div><span>Essential</span><strong>{formatMoney(intelligence.essentialPaise)}</strong></div><div><span>Discretionary</span><strong>{formatMoney(intelligence.discretionaryPaise)}</strong></div></div><p className="insights-chart-footnote">Signed totals include refunds. Classification helps you review where a reduction could be practical.</p></section><section className="panel insights-commitments-panel"><div className="insights-panel-heading"><div><h2>Cash already spoken for</h2><p>Keep plans separate from actual spending.</p></div></div><dl><div><dt>Upcoming unpaid commitments</dt><dd>{formatMoney(intelligence.upcomingPaise)}</dd></div><div><dt>Cash-backed savings reservations</dt><dd>{formatMoney(intelligence.reservedGoalsPaise)}</dd></div><div><dt>Cash available for guidance</dt><dd>{moneyOrUnknown(intelligence.cashAvailablePaise)}</dd></div></dl></section></div>
    <section className="panel insights-recent-panel"><div className="insights-panel-heading"><div><h2>Recent transactions</h2><p>The latest entries in your selected month.</p></div><button type="button" className="button button-secondary insights-small-button" onClick={onAddTransaction}><Plus size={15} aria-hidden="true" />Add new</button></div>{insights.recentTransactions.length === 0 ? <div className="insights-empty insights-empty-short"><ReceiptText size={27} aria-hidden="true" /><h3>A fresh page for your money</h3><p>Add income or an expense to get started.</p></div> : <ul className="insights-recent-list">{insights.recentTransactions.slice(0, 5).map((transaction) => <li key={transaction.id}><span className={`insights-transaction-icon insights-transaction-${transaction.type}`}>{transaction.type === 'expense' ? <ArrowUpRight size={18} aria-hidden="true" /> : <ArrowDownLeft size={18} aria-hidden="true" />}</span><div className="insights-transaction-copy"><strong>{transaction.note || transaction.category}</strong><span>{transaction.category} · {transaction.type} · {dateLabel(transaction.date)}</span></div><strong className={`insights-transaction-amount insights-amount-${transaction.type}`}>{transaction.type === 'expense' ? '−' : '+'}{formatMoney(transaction.amountPaise)}</strong></li>)}</ul>}</section>
  </div>;
}

function ScenarioSimulator({ transactions, budget, monthKey, asOf, context }: InsightProps) {
  const base = useMemo(() => getFinancialIntelligence(transactions, budget, asOf, monthKey, context), [transactions, budget, asOf, monthKey, context]);
  const candidates = base.base.signedCategorySpend.filter((category) => category.netExpensePaise > 0);
  const [category, setCategory] = useState('');
  const [amount, setAmount] = useState('100');
  const [submitted, setSubmitted] = useState<{ category: string; reductionPaise: number } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const selectedCategory = candidates.some((candidate) => candidate.category === category) ? category : candidates[0]?.category ?? '';
  const scenario = useMemo(() => {
    if (!submitted) return { result: null, error: null };
    try { return { result: simulateExpenseReduction(transactions, budget, asOf, monthKey, context ?? {}, submitted.category, submitted.reductionPaise), error: null }; }
    catch (error) { return { result: null, error: error instanceof Error ? error.message : 'This reduction cannot be calculated.' }; }
  }, [submitted, transactions, budget, asOf, monthKey, context]);
  const compare = (event: FormEvent) => {
    event.preventDefault(); setFormError(null);
    try { const reductionPaise = parseAmount(amount); if (!selectedCategory) throw new Error('Record an expense before comparing a reduction.'); setSubmitted({ category: selectedCategory, reductionPaise }); }
    catch (error) { setSubmitted(null); setFormError(error instanceof Error ? error.message : 'Enter a valid reduction.'); }
  };
  return <section className="panel insights-simulator"><div className="insights-panel-heading"><div><p className="eyebrow">WHAT IF?</p><h2>Try a spending reduction</h2><p>Compare a hypothetical change using copies of your records. Your ledger stays unchanged.</p></div><SlidersHorizontal size={19} aria-hidden="true" /></div>{candidates.length === 0 ? <div className="insights-scenario-empty"><p>A reduction needs positive net category spending in {monthLabel(monthKey)}.</p></div> : <><form className="insights-scenario-form" onSubmit={compare}><label><span>Expense category</span><select value={selectedCategory} onChange={(event) => setCategory(event.target.value)}>{candidates.map((candidate) => <option key={candidate.category} value={candidate.category}>{candidate.category} · {formatMoney(candidate.netExpensePaise)} net</option>)}</select></label><label><span>Reduce recorded spending by (₹)</span><input type="text" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} required aria-describedby="insights-scenario-help" /></label><button className="button button-primary" type="submit">Compare scenario<ArrowRight size={15} aria-hidden="true" /></button></form><p id="insights-scenario-help" className="insights-chart-footnote">Reduction is capped at actual net category spending, preserving refunds. Results are hypothetical and never save a transaction.</p></>}{(formError || scenario.error) && <p className="insights-scenario-error" role="alert">{formError || scenario.error}</p>}{scenario.result && <div className="insights-scenario-result" aria-live="polite"><p><strong>Hypothetical reduction: {formatMoney(scenario.result.reductionPaise)}</strong> in {submitted?.category}. {scenario.result.reason}</p><div className="insights-comparison-grid"><div><span>Safe to spend today</span><strong>{moneyOrUnknown(scenario.result.before.safeTodayPaise)}<ArrowRight size={14} aria-hidden="true" />{moneyOrUnknown(scenario.result.after.safeTodayPaise)}</strong></div><div><span>Month-end spending run-rate</span><strong>{scenario.result.before.forecastStatus === 'unavailable' ? 'Unavailable' : formatMoney(scenario.result.before.base.forecastPaise)}<ArrowRight size={14} aria-hidden="true" />{scenario.result.after.forecastStatus === 'unavailable' ? 'Unavailable' : formatMoney(scenario.result.after.base.forecastPaise)}</strong></div><div><span>Projected month-end cash</span><strong>{moneyOrUnknown(scenario.result.before.projectedCashBalancePaise)}<ArrowRight size={14} aria-hidden="true" />{moneyOrUnknown(scenario.result.after.projectedCashBalancePaise)}</strong></div></div></div>}</section>;
}

export function Reports({ transactions, budget, monthKey, asOf, context, monthTrend }: InsightProps) {
  const intelligence = useMemo(() => getFinancialIntelligence(transactions, budget, asOf, monthKey, context), [transactions, budget, asOf, monthKey, context]);
  const { base: insights } = intelligence;
  const trend = useMemo(() => monthTrend === undefined ? getMonthlyTrend(transactions, asOf) : monthTrend, [transactions, asOf, monthTrend]);
  const historyLimited = trend?.some((month) => 'arithmeticLimited' in month && month.arithmeticLimited === true) ?? false;
  const selectedTransactions = transactions.filter((transaction) => transaction.date.startsWith(`${monthKey}-`) && transaction.date <= asOf).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
  const exportCSV = () => {
    const url = URL.createObjectURL(new Blob([transactionsToCSV(selectedTransactions)], { type: 'text/csv;charset=utf-8;' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `spendsmart-${monthKey}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  if (insights.arithmeticLimited) return <section className="panel insights-chart-panel"><div className="insights-panel-heading"><div><h2>Exact report totals are unavailable</h2><p>{insights.calculationWarning}</p></div><Info size={18} aria-hidden="true" /></div><p className="insights-chart-footnote">Individual transaction records can still be reviewed. Correct oversized aggregates before comparing totals or scenarios.</p><button type="button" className="button button-secondary" onClick={exportCSV} disabled={selectedTransactions.length === 0}><Download size={16} aria-hidden="true" />Export individual records</button></section>;
  return (
    <div className="insights-view">
      <div className="insights-report-heading"><div><p className="eyebrow">UNDERSTAND THE PATTERN</p><h2>Your money, over time.</h2><p className="muted">Actual records, transparent adjustments, and scenarios you can compare.</p></div><button type="button" className="button button-primary" disabled={selectedTransactions.length === 0} onClick={exportCSV}><Download size={16} aria-hidden="true" />Export {monthLabel(monthKey)} CSV</button></div>
      <div className="insights-stat-grid insights-report-stats">
        <Stat label="Selected-month income" value={formatMoney(insights.totalIncomePaise)} note={monthLabel(monthKey)} icon={ArrowDownLeft} />
        <Stat label="Signed net expenses" value={formatMoney(insights.netExpensePaise)} note="Expenses less refunds; can be negative" icon={ArrowUpRight} />
        <Stat label="Refunds received" value={formatMoney(insights.totalRefundPaise)} note="Cash returned, counted separately from income" icon={Wallet} />
        <Stat label="Transactions" value={String(selectedTransactions.length)} note="Included in this month’s CSV export" icon={ReceiptText} />
      </div>
      <ScenarioSimulator transactions={transactions} budget={budget} monthKey={monthKey} asOf={asOf} context={context} />
      <section className="panel insights-trend-panel">
        <div className="insights-panel-heading"><div><h2>Six-month overview</h2><p>Income and budget spending through {monthLabel(asOf.slice(0, 7))}.</p></div><TrendingUp size={18} aria-hidden="true" /></div>
        {trend === null || trend.length === 0 || historyLimited ? <div className="insights-empty"><CalendarDays size={28} aria-hidden="true" /><h3>Monthly history is unavailable</h3><p>{historyLimited ? 'A historical aggregate exceeds the exact integer range. Review oversized records before comparing monthly amounts.' : 'The selected month’s records do not represent your complete history. Historical aggregates will appear when available.'}</p></div> : <>
        <div className="insights-chart insights-trend-chart" role="img" aria-label="Bar chart of income and budget spending in the last six months. Exact amounts are listed in the table below.">
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <BarChart data={trend} margin={{ top: 8, right: 10, left: 0, bottom: 0 }} barGap={5} accessibilityLayer>
              <CartesianGrid stroke="#e6eaed" vertical={false} strokeDasharray="3 3" />
              <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: '#5d6c7b', fontSize: 11 }} />
              <YAxis axisLine={false} tickLine={false} width={58} tickFormatter={axisMoney} tick={{ fill: '#5d6c7b', fontSize: 11 }} />
              <Tooltip contentStyle={CHART_TOOLTIP_STYLE} formatter={(value, name) => [formatMoney(Number(value)), name]} cursor={{ fill: '#eef1f3' }} />
              <Bar name="Recorded income" dataKey="incomePaise" fill="#dba84b" radius={[4, 4, 0, 0]} maxBarSize={32} isAnimationActive={false} />
              <Bar name="Budget spending" dataKey="expensePaise" fill="#172339" radius={[4, 4, 0, 0]} maxBarSize={32} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="insights-chart-legend"><span><i className="insights-key insights-key-income" />Income</span><span><i className="insights-key insights-key-actual" />Budget spending</span></div>
        <details className="insights-data-details"><summary>View exact monthly amounts</summary><div className="insights-table-wrap"><table className="insights-table"><caption>Income and spending for the last six months</caption><thead><tr><th scope="col">Month</th><th scope="col">Income</th><th scope="col">Budget spending</th></tr></thead><tbody>{trend.map((month) => <tr key={month.monthKey}><th scope="row">{monthLabel(month.monthKey)}</th><td>{formatMoney(month.incomePaise)}</td><td>{formatMoney(month.expensePaise)}</td></tr>)}</tbody></table></div></details>
        <p className="insights-chart-footnote">Budget spending is expenses minus refunds, floored at ₹0. The selected-month reconciliation preserves signed adjustments.</p></>}
      </section>
      <div className="insights-main-grid insights-reports-grid">
        <section className="panel insights-category-table-panel">
          <div className="insights-panel-heading"><div><h2>{monthLabel(monthKey)} by category</h2><p>Signed refunds reconcile with your actual expense total.</p></div></div>
          <div className="insights-table-wrap"><table className="insights-table"><caption>Selected month gross expenses, refunds, signed net, and category limits</caption><thead><tr><th scope="col">Category</th><th scope="col">Gross</th><th scope="col">Refunds</th><th scope="col">Signed net</th><th scope="col">Limit</th><th scope="col">Used</th></tr></thead><tbody>{insights.signedCategorySpend.map((category) => { const capped = insights.categorySpend.find((item) => item.category === category.category); return <tr key={category.category}><th scope="row">{category.category}</th><td>{formatMoney(category.grossExpensePaise)}</td><td>{formatMoney(category.refundPaise)}</td><td>{formatMoney(category.netExpensePaise)}</td><td>{capped?.limitPaise === null || capped?.limitPaise === undefined ? '—' : formatMoney(capped.limitPaise)}</td><td><span className={capped?.usagePercent !== null && capped?.usagePercent !== undefined && capped.usagePercent >= 80 ? 'insights-table-warning' : ''}>{percent(capped?.usagePercent ?? null)}</span></td></tr>; })}</tbody><tfoot><tr><th scope="row">Total</th><td>{formatMoney(insights.totalExpensePaise)}</td><td>{formatMoney(insights.totalRefundPaise)}</td><td>{formatMoney(insights.netExpensePaise)}</td><td colSpan={2}>Signed expense total</td></tr></tfoot></table></div>
          <RefundReconciliation intelligence={intelligence} />
        </section>
        <section className="panel insights-method-panel"><span className="insights-method-icon"><ShieldCheck size={23} aria-hidden="true" /></span><p className="eyebrow">EVERY NUMBER HAS A REASON</p><h2>Trace the decision.</h2><dl className="insights-method-list"><div><dt>Actual cash</dt><dd>Recorded income + refunds − expenses</dd></div><div><dt>Budget usage</dt><dd>Nonnegative budget spending ÷ limit × 100</dd></div><div><dt>Month-end run-rate</dt><dd>Budget spending ÷ elapsed days × month length</dd></div><div><dt>Safe today</dt><dd>Smallest cash and budget headroom, after commitments and reservations, ÷ days including today</dd></div><div><dt>Expected income</dt><dd>Included in cash projections; excluded from recorded cash and safe today</dd></div></dl><p className="insights-chart-footnote">Run-rate is unavailable without expense history and is labeled early when there are fewer than three records or fewer than seven elapsed days. The original PDF allowance divides budget headroom by days after today; both formulas are visible on the dashboard.</p></section>
      </div>
    </div>
  );
}
