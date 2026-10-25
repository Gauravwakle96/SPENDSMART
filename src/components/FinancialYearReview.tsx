import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  CalendarRange,
  Check,
  Download,
  FileText,
  Repeat2,
  Sparkles,
  Target,
  X,
} from 'lucide-react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useSpendSmart } from '../data/SpendSmartProvider';
import { downloadFinancialPDF, downloadImportReconciliationCSV, downloadPeriodCSV } from '../data/report-export';
import {
  analyzePeriod,
  calendarMonth,
  calendarYear,
  customPeriod,
  detectRecurringPayments,
  detectSpendingAnomalies,
  deterministicFinancialSummary,
  indianFinancialYear,
  indianFinancialYearFor,
  recommendBudgets,
  type AnalysisPeriod,
  type RecurringInsight,
} from '../domain/financial-analysis';
import { formatMoney, monthLabel, parseAmount } from '../domain/engine';
import type { ImportRecord } from '../domain/import-types';
import type { Transaction } from '../domain/types';
import './financial-intelligence.css';

interface Props {
  transactions: Transaction[];
  imports: ImportRecord[];
  asOf: string;
  analysisLimited?: boolean;
}

type PeriodMode = AnalysisPeriod['kind'];

function axisMoney(value: number): string {
  return `₹${new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 }).format(value / 100)}`;
}

function percent(value: number | null): string {
  if (value === null) return 'Unavailable';
  return `${value >= 0 ? '+' : ''}${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 }).format(value)}%`;
}

function rupeeInput(paise: number): string {
  const value = BigInt(paise);
  return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
}

export function FinancialYearReview({ transactions, imports, asOf, analysisLimited = false }: Props) {
  const store = useSpendSmart();
  const currentFY = indianFinancialYearFor(asOf);
  const [mode, setMode] = useState<PeriodMode>('indian-financial-year');
  const [year, setYear] = useState(Number(currentFY.start.slice(0, 4)));
  const [month, setMonth] = useState(asOf.slice(0, 7));
  const [customStart, setCustomStart] = useState(currentFY.start);
  const [customEnd, setCustomEnd] = useState(asOf);
  const [dismissedAnomalies, setDismissedAnomalies] = useState<Set<string>>(() => new Set());
  const [recurringStates, setRecurringStates] = useState<Record<string, 'confirmed' | 'dismissed'>>({});
  const [frequencyOverrides, setFrequencyOverrides] = useState<Record<string, RecurringInsight['frequency']>>({});
  const [dismissedBudgets, setDismissedBudgets] = useState<Set<string>>(() => new Set());
  const [budgetEdits, setBudgetEdits] = useState<Record<string, string>>({});
  const [savingBudget, setSavingBudget] = useState<string | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [message, setMessage] = useState('');

  const period = useMemo(() => {
    try {
      if (mode === 'indian-financial-year') return indianFinancialYear(year);
      if (mode === 'calendar-year') return calendarYear(year);
      if (mode === 'month') return calendarMonth(month);
      return customPeriod(customStart, customEnd);
    } catch {
      return currentFY;
    }
  }, [mode, year, month, customStart, customEnd, currentFY]);
  const analysis = useMemo(() => analyzePeriod(transactions, period), [transactions, period]);
  const recurring = useMemo(() => detectRecurringPayments(transactions, period), [transactions, period]);
  const anomalies = useMemo(() => detectSpendingAnomalies(transactions, period), [transactions, period]);
  const recommendations = useMemo(() => recommendBudgets(transactions, period), [transactions, period]);
  const summary = useMemo(() => deterministicFinancialSummary(analysis, recurring, anomalies), [analysis, recurring, anomalies]);
  const visibleAnomalies = anomalies.filter((item) => !dismissedAnomalies.has(item.id));
  const visibleRecommendations = recommendations.filter((item) => !dismissedBudgets.has(item.category));
  const targetMonth = asOf.slice(0, 7);
  const targetBudget = store.budgets.find((budget) => budget.monthKey === targetMonth);

  async function acceptBudget(category: string, suggestedPaise: number) {
    setSavingBudget(category);
    setMessage('');
    try {
      const edited = budgetEdits[category]?.trim();
      const amountPaise = edited ? parseAmount(edited) : suggestedPaise;
      await store.saveBudget({ currency: 'INR', monthKey: targetMonth, limitPaise: targetBudget?.limitPaise ?? 0,
        categoryLimits: { ...(targetBudget?.categoryLimits ?? {}), [category]: amountPaise } });
      setMessage(`${category} recommendation saved as a ${monthLabel(targetMonth)} category limit.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The budget recommendation could not be saved.');
    } finally { setSavingBudget(null); }
  }

  async function exportPDF() {
    setPdfBusy(true);
    setMessage('');
    try { await downloadFinancialPDF(analysis, recurring, visibleAnomalies); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'The PDF report could not be generated.'); }
    finally { setPdfBusy(false); }
  }

  return (
    <section className="financial-review" aria-labelledby="financial-review-title">
      <div className="panel financial-review-heading">
        <div>
          <span className="eyebrow">FINANCIAL YEAR REVIEW</span>
          <h2 id="financial-review-title">See the whole period, with coverage made explicit.</h2>
          <p className="muted">Transfers and uncertain movements excluded during import stay outside income, expense, and budget totals.</p>
        </div>
        <CalendarRange size={26} aria-hidden="true" />
      </div>

      <section className="panel period-controls" aria-label="Analysis period">
        <label>Period type
          <select value={mode} onChange={(event) => setMode(event.target.value as PeriodMode)}>
            <option value="indian-financial-year">Indian financial year</option>
            <option value="calendar-year">Calendar year</option>
            <option value="month">Individual month</option>
            <option value="custom">Custom date range</option>
          </select>
        </label>
        {(mode === 'indian-financial-year' || mode === 'calendar-year') && <label>{mode === 'indian-financial-year' ? 'Starting year' : 'Year'}
          <input type="number" min="2000" max="2100" value={year} onChange={(event) => setYear(Number(event.target.value))} />
        </label>}
        {mode === 'month' && <label>Month<input type="month" value={month} min="2000-01" max="2100-12" onChange={(event) => setMonth(event.target.value)} /></label>}
        {mode === 'custom' && <><label>From<input type="date" value={customStart} onChange={(event) => setCustomStart(event.target.value)} /></label>
          <label>To<input type="date" value={customEnd} max={asOf} onChange={(event) => setCustomEnd(event.target.value)} /></label></>}
        <div className="period-export-actions">
          <button className="button button-secondary" onClick={() => downloadPeriodCSV(analysis)} disabled={!analysis.transactionCount}><Download size={15} aria-hidden="true" />CSV report</button>
          <button className="button button-secondary" onClick={() => void exportPDF()} disabled={!analysis.transactionCount || pdfBusy}><FileText size={15} aria-hidden="true" />{pdfBusy ? 'Building PDF…' : 'PDF summary'}</button>
          <button className="button button-secondary" onClick={() => downloadImportReconciliationCSV(imports)} disabled={!imports.length}><Download size={15} aria-hidden="true" />Import reconciliation</button>
        </div>
      </section>

      {(analysisLimited || analysis.warnings.length > 0) && <div className="coverage-warning" role="status"><AlertTriangle size={18} aria-hidden="true" /><div>
        {analysisLimited && <p>Cloud analysis is limited to the latest 5,000 transactions. Older records may be omitted.</p>}
        {analysis.warnings.map((warning) => <p key={warning}>{warning}</p>)}
      </div></div>}

      <div className="analysis-stat-grid">
        <article className="panel"><span>Recorded income</span><strong>{formatMoney(analysis.totalIncomePaise)}</strong><small>Credits confirmed as income</small></article>
        <article className="panel"><span>Signed net expenses</span><strong>{formatMoney(analysis.netExpensePaise)}</strong><small>Expenses less refunds</small></article>
        <article className="panel"><span>Net cash flow</span><strong>{formatMoney(analysis.netCashFlowPaise)}</strong><small>Not an account balance or savings figure</small></article>
        <article className="panel"><span>Average observed month</span><strong>{formatMoney(analysis.averageMonthlyExpensePaise)}</strong><small>{analysis.coverage.observedMonths} month{analysis.coverage.observedMonths === 1 ? '' : 's'} with data</small></article>
      </div>

      <div className="financial-chart-grid">
        <section className="panel financial-trend-panel">
          <div className="section-heading"><div><h3>Income and spending by month</h3><p className="muted">Signed net expenses can fall below zero when refunds exceed expenses.</p></div><BarChart3 size={20} aria-hidden="true" /></div>
          {analysis.transactionCount ? <div className="financial-bar-chart"><ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <BarChart data={analysis.months} margin={{ left: 4, right: 8, top: 8, bottom: 0 }} accessibilityLayer>
              <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="#e3e8ea" />
              <XAxis dataKey="monthKey" tickFormatter={(value) => monthLabel(String(value)).slice(0, 3)} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={axisMoney} tick={{ fontSize: 10 }} width={58} axisLine={false} tickLine={false} />
              <Tooltip formatter={(value, name) => [formatMoney(Number(value)), name]} labelFormatter={(value) => monthLabel(String(value))} />
              <Bar name="Recorded income" dataKey="incomePaise" fill="#dba84b" radius={[4, 4, 0, 0]} isAnimationActive={false} />
              <Bar name="Signed net expenses" dataKey="netExpensePaise" fill="#172339" radius={[4, 4, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer></div> : <p className="empty-inline">No included transactions in this period.</p>}
        </section>
        <section className="panel coverage-panel">
          <h3>Data coverage</h3>
          <dl><div><dt>Observed months</dt><dd>{analysis.coverage.observedMonths} / {analysis.coverage.expectedMonths}</dd></div>
            <div><dt>First included record</dt><dd>{analysis.coverage.firstDate ?? 'Unavailable'}</dd></div>
            <div><dt>Last included record</dt><dd>{analysis.coverage.lastDate ?? 'Unavailable'}</dd></div>
            <div><dt>Coverage status</dt><dd>{analysis.coverage.complete ? 'No month gaps detected' : 'Incomplete or uncertain'}</dd></div></dl>
          {analysis.comparison && <div className="period-comparison"><h4>Previous-period comparison</h4>
            <p>Income {percent(analysis.comparison.incomeChangePercent)} · Net expenses {percent(analysis.comparison.expenseChangePercent)}</p>
            <small>Compared with {analysis.comparison.label}; only recorded included transactions are used.</small></div>}
        </section>
      </div>

      <section className="panel financial-table-panel">
        <div className="section-heading"><div><h3>Category and merchant breakdown</h3><p className="muted">Actual aggregates from accessible records.</p></div></div>
        <div className="analysis-tables"><div className="ledger-table-wrap"><table className="ledger-table"><caption>Expenses by category</caption><thead><tr><th>Category</th><th>Gross</th><th>Refunds</th><th>Signed net</th></tr></thead><tbody>
          {analysis.categories.map((category) => <tr key={category.category}><th scope="row">{category.category}</th><td>{formatMoney(category.grossExpensePaise)}</td><td>{formatMoney(category.refundPaise)}</td><td>{formatMoney(category.netExpensePaise)}</td></tr>)}
        </tbody></table></div><div className="ledger-table-wrap"><table className="ledger-table"><caption>Top merchants or descriptions</caption><thead><tr><th>Merchant / description</th><th>Transactions</th><th>Expenses</th></tr></thead><tbody>
          {analysis.merchants.slice(0, 10).map((merchant) => <tr key={merchant.merchant}><th scope="row">{merchant.merchant}</th><td>{merchant.count}</td><td>{formatMoney(merchant.amountPaise)}</td></tr>)}
        </tbody></table></div></div>
      </section>

      <section className="panel deterministic-summary"><div className="section-heading"><div><span className="eyebrow">PRIVATE BY DEFAULT</span><h3>Financial summary</h3><p className="muted">Generated deterministically from aggregate statistics. No external AI service is required or contacted.</p></div><Sparkles size={21} aria-hidden="true" /></div>
        <ul>{summary.map((line) => <li key={line}>{line}</li>)}</ul>
      </section>

      <div className="analysis-insight-grid">
        <section className="panel review-list"><div className="section-heading"><div><h3>Observed recurring activity</h3><p className="muted">Patterns are not treated as verified subscriptions.</p></div><Repeat2 size={20} aria-hidden="true" /></div>
          {recurring.filter((item) => recurringStates[item.id] !== 'dismissed').length ? recurring.filter((item) => recurringStates[item.id] !== 'dismissed').map((item) => <article key={item.id} className="review-card">
            <div><strong>{item.merchant}</strong><span>{item.observedCount} observed · {formatMoney(item.typicalAmountPaise)} typical · {item.confidence} confidence</span><p>{item.reason}</p></div>
            <label>Frequency<select value={frequencyOverrides[item.id] ?? item.frequency} onChange={(event) => setFrequencyOverrides((current) => ({ ...current, [item.id]: event.target.value as RecurringInsight['frequency'] }))}><option>weekly</option><option>fortnightly</option><option>monthly</option><option>quarterly</option><option>annual</option></select></label>
            <div className="review-actions"><button className="button button-secondary" onClick={() => setRecurringStates((current) => ({ ...current, [item.id]: 'confirmed' }))}><Check size={14} aria-hidden="true" />{recurringStates[item.id] === 'confirmed' ? 'Confirmed for review' : 'Confirm pattern'}</button><button className="icon-button" aria-label={`Dismiss ${item.merchant} recurring suggestion`} onClick={() => setRecurringStates((current) => ({ ...current, [item.id]: 'dismissed' }))}><X size={16} aria-hidden="true" /></button></div>
            <small>Estimated monthly {formatMoney(item.estimatedMonthlyPaise)} · annual {formatMoney(item.estimatedAnnualPaise)}. No future payment is guaranteed or added to planned expenses.</small>
          </article>) : <p className="empty-inline">No recurring pattern met the minimum occurrence and timing rules.</p>}
        </section>

        <section className="panel review-list"><div className="section-heading"><div><h3>Unusual spending indicators</h3><p className="muted">Explainable review prompts, not fraud claims.</p></div><AlertTriangle size={20} aria-hidden="true" /></div>
          {visibleAnomalies.length ? visibleAnomalies.map((item) => <article key={item.id} className="review-card"><div><strong>{item.title}</strong><p>{item.reason}</p></div><button className="icon-button" aria-label={`Dismiss ${item.title}`} onClick={() => setDismissedAnomalies((current) => new Set(current).add(item.id))}><X size={16} aria-hidden="true" /></button></article>)
            : <p className="empty-inline">No anomaly met the minimum history and threshold rules.</p>}
        </section>
      </div>

      <section className="panel budget-recommendations"><div className="section-heading"><div><h3>Explainable budget recommendations</h3><p className="muted">Nothing changes until you accept an editable category limit for {monthLabel(targetMonth)}.</p></div><Target size={20} aria-hidden="true" /></div>
        {!visibleRecommendations.length ? <p className="empty-inline">At least two observed months are needed for historical recommendations.</p> : <div className="recommendation-grid">{visibleRecommendations.map((item) => <article key={item.category} className="recommendation-card"><div><strong>{item.category}</strong><span>{item.confidence} confidence · {item.monthsUsed} months</span></div>
          <label>Suggested monthly limit (₹)<input inputMode="decimal" value={budgetEdits[item.category] ?? rupeeInput(item.suggestedPaise)} onChange={(event) => setBudgetEdits((current) => ({ ...current, [item.category]: event.target.value }))} /></label>
          <dl><div><dt>Median</dt><dd>{formatMoney(item.medianPaise)}</dd></div><div><dt>Average</dt><dd>{formatMoney(item.averagePaise)}</dd></div><div><dt>Recent average</dt><dd>{formatMoney(item.recentAveragePaise)}</dd></div><div><dt>Variability</dt><dd>{item.variabilityPercent.toFixed(0)}%</dd></div></dl>
          <p>{item.rationale}</p><div className="review-actions"><button className="button button-primary" disabled={savingBudget !== null} onClick={() => void acceptBudget(item.category, item.suggestedPaise)}>{savingBudget === item.category ? 'Saving…' : 'Accept limit'}</button><button className="button button-secondary" onClick={() => setDismissedBudgets((current) => new Set(current).add(item.category))}>Reject</button></div>
        </article>)}</div>}
        {message && <p className="field-help" role="status">{message}</p>}
      </section>

      {analysis.accounts.length > 0 && <section className="panel financial-table-panel"><div className="section-heading"><div><h3>Account-level summary</h3><p className="muted">Matching labels group statements; SpendSmart never assumes two accounts share ownership.</p></div></div><div className="ledger-table-wrap"><table className="ledger-table"><caption>Account-level included activity</caption><thead><tr><th>Account</th><th>Income</th><th>Expenses</th><th>Refunds</th><th>Net cash flow</th><th>Records</th></tr></thead><tbody>{analysis.accounts.map((account) => <tr key={account.account}><th scope="row">{account.account}</th><td>{formatMoney(account.incomePaise)}</td><td>{formatMoney(account.expensePaise)}</td><td>{formatMoney(account.refundPaise)}</td><td>{formatMoney(account.netCashFlowPaise)}</td><td>{account.count}</td></tr>)}</tbody></table></div></section>}
    </section>
  );
}
