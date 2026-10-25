import { useRef, useState, type DragEvent } from 'react';
import {
  AlertTriangle,
  Check,
  FileSpreadsheet,
  History,
  RotateCcw,
  Search,
  ShieldCheck,
  Trash2,
  UploadCloud,
} from 'lucide-react';
import { useSpendSmart } from '../data/SpendSmartProvider';
import { createFictionalStatementFile } from '../data/demo-statement';
import { parseStatementFiles, statementMappingWarnings, MAX_IMPORT_FILE_BYTES, MAX_IMPORT_FILES, MAX_IMPORT_ROWS } from '../data/statement-files';
import { formatMoney } from '../domain/engine';
import {
  buildImportRecord,
  classificationSettings,
  createCategoryRule,
  normalizeStatements,
  prepareImportTransactions,
} from '../domain/import-engine';
import type { ImportCandidate, ParsedStatementFile, StatementColumnMapping } from '../domain/import-types';
import {
  EXPENSE_CATEGORIES,
  INCOME_CATEGORIES,
  TRANSACTION_CLASSIFICATIONS,
  type TransactionClassification,
  type TransactionType,
} from '../domain/types';
import { FinancialYearReview } from './FinancialYearReview';
import './import-analyze.css';

interface Props { asOf: string }

const mappingLabels: Record<keyof StatementColumnMapping, string> = {
  date: 'Transaction date',
  description: 'Description / narration',
  debit: 'Debit amount',
  credit: 'Credit amount',
  amount: 'Signed amount',
  balance: 'Running balance',
  reference: 'Bank reference / transaction ID',
  accountLabel: 'Account label',
};

function classificationLabel(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function amountSummary(candidates: ImportCandidate[], direction: 'debit' | 'credit'): string {
  const value = candidates.filter((candidate) => candidate.status !== 'invalid' && candidate.direction === direction)
    .reduce((total, candidate) => total + BigInt(candidate.amountPaise), 0n);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return 'Above exact display range';
  return formatMoney(Number(value));
}

function categoriesFor(type: TransactionType): readonly string[] {
  return type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
}

export function ImportAnalyze({ asOf }: Props) {
  const store = useSpendSmart();
  const input = useRef<HTMLInputElement>(null);
  const [parsedFiles, setParsedFiles] = useState<ParsedStatementFile[]>([]);
  const [accountLabels, setAccountLabels] = useState<Record<string, string>>({});
  const [candidates, setCandidates] = useState<ImportCandidate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [rememberRules, setRememberRules] = useState<Set<string>>(() => new Set());
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [importId, setImportId] = useState(() => crypto.randomUUID());
  const [submitted, setSubmitted] = useState(false);
  const [rollingBack, setRollingBack] = useState<string | null>(null);

  async function readFiles(files: File[]) {
    setBusy(true); setError(''); setMessage(''); setSubmitted(false);
    try {
      const parsed = await parseStatementFiles(files);
      setParsedFiles(parsed); setCandidates([]); setSelected(new Set()); setRememberRules(new Set());
      setAccountLabels(Object.fromEntries(parsed.map((file) => [file.fileHash, ''])));
      setImportId(crypto.randomUUID());
      setMessage(`${parsed.length} statement file${parsed.length === 1 ? '' : 's'} parsed locally. Review account labels and column mapping before previewing.`);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'The statement files could not be parsed.'); }
    finally { setBusy(false); if (input.current) input.current.value = ''; }
  }

  async function loadSample() {
    await readFiles([createFictionalStatementFile(asOf)]);
    setMessage('Fictional sample loaded through the same CSV parser used for real statements. No sample data has been imported yet.');
  }

  function drop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault(); setDragging(false);
    void readFiles([...event.dataTransfer.files]);
  }

  function updateMapping(fileHash: string, field: keyof StatementColumnMapping, value: string) {
    setParsedFiles((current) => current.map((file) => {
      if (file.fileHash !== fileHash) return file;
      const mapping = { ...file.mapping, [field]: value === '' ? null : Number(value) };
      return { ...file, mapping, mappingWarnings: statementMappingWarnings(mapping) };
    }));
    setCandidates([]); setSubmitted(false);
  }

  function preview() {
    setError(''); setMessage(''); setSubmitted(false);
    try {
      const normalized = normalizeStatements({ files: parsedFiles, accountLabels,
        existingTransactions: store.analysisTransactions, categoryRules: store.categoryRules, asOf });
      setCandidates(normalized);
      setSelected(new Set(normalized.filter((candidate) => candidate.status !== 'invalid' && candidate.duplicate === 'none').map((candidate) => candidate.key)));
      setRememberRules(new Set());
      setMessage('Preview generated. Exact duplicates and uncertain matches are not selected automatically.');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'The preview could not be generated.'); }
  }

  function updateCandidate(key: string, change: (candidate: ImportCandidate) => ImportCandidate) {
    setCandidates((current) => current.map((candidate) => candidate.key === key ? change(candidate) : candidate));
    setSubmitted(false);
  }

  function setType(candidate: ImportCandidate, type: TransactionType) {
    const allowed = categoriesFor(type);
    const classification: TransactionClassification = type === 'income' ? 'income' : type === 'refund' ? 'refund' : 'expense';
    updateCandidate(candidate.key, (current) => ({ ...current, type, classification, excludedFromAnalysis: false,
      category: allowed.includes(current.category) ? current.category : allowed[allowed.length - 1], confidence: 'medium',
      status: current.issues.length ? 'invalid' : current.duplicate === 'none' ? 'valid' : 'review' }));
  }

  function setClassification(candidate: ImportCandidate, classification: TransactionClassification) {
    const settings = classificationSettings(classification, candidate.direction);
    const allowed = categoriesFor(settings.type);
    updateCandidate(candidate.key, (current) => ({ ...current, classification, type: settings.type,
      excludedFromAnalysis: settings.excludedFromAnalysis, category: allowed.includes(current.category) ? current.category : allowed[allowed.length - 1],
      confidence: 'medium', status: current.issues.length ? 'invalid' : current.duplicate === 'none' ? 'valid' : 'review' }));
  }

  async function confirmImport() {
    const chosen = candidates.filter((candidate) => selected.has(candidate.key));
    if (!chosen.length) { setError('Select at least one valid, reviewed transaction to import.'); return; }
    setBusy(true); setError(''); setMessage('');
    try {
      const prepared = prepareImportTransactions(importId, chosen);
      const record = buildImportRecord({ id: importId, files: parsedFiles, candidates, selected: chosen });
      await store.importTransactions(record, prepared);
      let ruleFailures = 0;
      for (const candidate of chosen.filter((item) => rememberRules.has(item.key))) {
        try { await store.saveCategoryRule(createCategoryRule(candidate)); } catch { ruleFailures += 1; }
      }
      setSubmitted(true);
      setMessage(`${prepared.length} transaction${prepared.length === 1 ? '' : 's'} imported and confirmed.${ruleFailures ? ` ${ruleFailures} reusable categorization rule${ruleFailures === 1 ? '' : 's'} could not be saved.` : ''}`);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'The import was not confirmed. Retry uses the same operation ID.'); }
    finally { setBusy(false); }
  }

  async function rollback(id: string) {
    if (!window.confirm('Roll back unchanged transactions created by this import? Edited or linked records will be kept and reported as conflicts.')) return;
    setRollingBack(id); setError(''); setMessage('');
    try {
      const result = await store.rollbackImport(id);
      setMessage(`${result.deletedCount} imported transaction${result.deletedCount === 1 ? '' : 's'} removed.${result.conflictCount ? ` ${result.conflictCount} edited or linked record${result.conflictCount === 1 ? ' was' : 's were'} kept.` : ''}`);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'The import could not be rolled back safely.'); }
    finally { setRollingBack(null); }
  }

  const filtered = candidates.filter((candidate) => {
    const matchesStatus = statusFilter === 'all' || candidate.status === statusFilter || candidate.duplicate === statusFilter;
    const query = search.toLowerCase();
    return matchesStatus && `${candidate.rawDescription} ${candidate.category} ${candidate.accountLabel} ${candidate.date}`.toLowerCase().includes(query);
  });
  const invalidCount = candidates.filter((candidate) => candidate.status === 'invalid').length;
  const reviewCount = candidates.filter((candidate) => candidate.status === 'review').length;
  const duplicateCount = candidates.filter((candidate) => candidate.duplicate !== 'none').length;

  return <div className="import-analyze-view">
    <section className="panel import-hero"><div><span className="eyebrow">LOCAL-FIRST STATEMENT IMPORT</span><h2>Import once. Understand the full financial year.</h2><p className="muted">CSV and XLSX files are parsed in this browser. Original statement files are not uploaded or stored.</p></div><span className="import-hero-icon"><ShieldCheck size={30} aria-hidden="true" /></span></section>

    <section className="panel upload-panel">
      <div className="section-heading"><div><h2>1. Choose statement files</h2><p className="muted">Up to {MAX_IMPORT_FILES} files, {MAX_IMPORT_FILE_BYTES / 1024 / 1024} MB each, and {MAX_IMPORT_ROWS.toLocaleString('en-IN')} rows per session.</p></div><FileSpreadsheet size={22} aria-hidden="true" /></div>
      <div className={`statement-dropzone ${dragging ? 'dragging' : ''}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={drop}>
        <UploadCloud size={31} aria-hidden="true" /><strong>Drop CSV or XLSX statements here</strong><span>PDF import is intentionally unavailable until extraction can be made reliable.</span>
        <div><button className="button button-primary" disabled={busy} onClick={() => input.current?.click()}>{busy ? 'Reading files…' : 'Choose files'}</button><button className="button button-secondary" disabled={busy} onClick={() => void loadSample()}>Load fictional sample</button></div>
        <input ref={input} className="sr-only" type="file" multiple aria-label="Choose CSV or XLSX statement files" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => void readFiles([...(event.target.files ?? [])])} />
      </div>
      <p className="privacy-note">Do not use sensitive statements on a shared device. Demo mode uses localStorage, which is not encrypted. SpendSmart never asks for bank login credentials.</p>
    </section>

    {parsedFiles.length > 0 && <section className="panel mapping-panel"><div className="section-heading"><div><h2>2. Label accounts and verify columns</h2><p className="muted">Use the same label to group files from the same account. No account ownership or cross-account transfer is inferred automatically.</p></div></div>
      <div className="mapping-files">{parsedFiles.map((file) => <article key={file.fileHash} className="mapping-card"><div><strong>{file.fileName}</strong><span>{file.rows.length} rows · header row {file.headerRowNumber} · {file.format.toUpperCase()}</span></div>
        <label>Account label<input maxLength={80} placeholder="e.g. Salary account" value={accountLabels[file.fileHash] ?? ''} onChange={(event) => { setAccountLabels((current) => ({ ...current, [file.fileHash]: event.target.value })); setCandidates([]); }} /></label>
        <div className="column-mapping-grid">{(Object.keys(mappingLabels) as (keyof StatementColumnMapping)[]).map((field) => <label key={field}>{mappingLabels[field]}<select value={file.mapping[field] ?? ''} onChange={(event) => updateMapping(file.fileHash, field, event.target.value)}><option value="">Not mapped</option>{file.headers.map((header, index) => <option key={`${header}-${index}`} value={index}>{header}</option>)}</select></label>)}</div>
        {file.mappingWarnings.length > 0 && <ul className="mapping-warnings">{file.mappingWarnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
      </article>)}</div>
      <button className="button button-primary" onClick={preview}>Build transaction preview</button>
    </section>}

    {candidates.length > 0 && <section className="panel preview-panel"><div className="section-heading"><div><h2>3. Review, correct, and select</h2><p className="muted">Uncertain credits/debits are excluded from analysis until you classify them. Probable duplicates require an explicit selection.</p></div></div>
      <div className="import-summary-grid"><div><span>Total rows</span><strong>{candidates.length}</strong></div><div><span>Valid</span><strong>{candidates.length - invalidCount - reviewCount}</strong></div><div><span>Needs review</span><strong>{reviewCount}</strong></div><div><span>Invalid</span><strong>{invalidCount}</strong></div><div><span>Duplicate flags</span><strong>{duplicateCount}</strong></div><div><span>Estimated debits</span><strong>{amountSummary(candidates, 'debit')}</strong></div><div><span>Estimated credits</span><strong>{amountSummary(candidates, 'credit')}</strong></div></div>
      <div className="preview-filters"><label className="search-input"><Search size={17} aria-hidden="true" /><span className="sr-only">Search preview</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search descriptions, accounts, dates" /></label><select aria-label="Filter preview status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">All rows</option><option value="valid">Valid</option><option value="review">Needs review</option><option value="invalid">Invalid</option><option value="exact">Exact duplicates</option><option value="probable">Probable duplicates</option></select><span>{selected.size} selected</span></div>
      <div className="import-preview-wrap"><table className="import-preview-table"><caption>Bank statement transaction preview</caption><thead><tr><th>Import</th><th>Date and description</th><th>Amount</th><th>Type</th><th>Category</th><th>Classification</th><th>Status</th><th>Rule</th></tr></thead><tbody>{filtered.slice(0, 150).map((candidate) => <tr key={candidate.key} className={`candidate-${candidate.status}`}><td><input type="checkbox" aria-label={`Import ${candidate.rawDescription || `row ${candidate.sourceRowNumber}`}`} checked={selected.has(candidate.key)} disabled={candidate.status === 'invalid' || candidate.duplicate === 'exact' || submitted} onChange={(event) => setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(candidate.key); else next.delete(candidate.key); return next; })} /></td>
        <td><strong>{candidate.rawDescription || 'Missing description'}</strong><span>{candidate.date || 'Invalid date'} · {candidate.accountLabel} · row {candidate.sourceRowNumber}</span></td><td className={candidate.direction === 'debit' ? 'preview-debit' : 'preview-credit'}>{candidate.direction === 'debit' ? '−' : '+'}{candidate.amountPaise ? formatMoney(candidate.amountPaise) : 'Invalid'}</td>
        <td><select aria-label={`Transaction type for ${candidate.rawDescription || `row ${candidate.sourceRowNumber}`}`} value={candidate.type} disabled={submitted || candidate.status === 'invalid'} onChange={(event) => setType(candidate, event.target.value as TransactionType)}><option value="expense">Expense</option><option value="income">Income</option><option value="refund">Refund</option></select></td>
        <td><select aria-label={`Category for ${candidate.rawDescription || `row ${candidate.sourceRowNumber}`}`} value={candidate.category} disabled={submitted || candidate.status === 'invalid'} onChange={(event) => updateCandidate(candidate.key, (current) => ({ ...current, category: event.target.value, confidence: 'medium', status: current.duplicate === 'none' ? 'valid' : 'review' }))}>{categoriesFor(candidate.type).map((category) => <option key={category}>{category}</option>)}</select></td>
        <td><select aria-label={`Classification for ${candidate.rawDescription || `row ${candidate.sourceRowNumber}`}`} value={candidate.classification} disabled={submitted || candidate.status === 'invalid'} onChange={(event) => setClassification(candidate, event.target.value as TransactionClassification)}>{TRANSACTION_CLASSIFICATIONS.map((value) => <option key={value} value={value}>{classificationLabel(value)}</option>)}</select><label className="analysis-toggle"><input type="checkbox" checked={!candidate.excludedFromAnalysis} disabled={submitted || candidate.status === 'invalid'} onChange={(event) => updateCandidate(candidate.key, (current) => ({ ...current, excludedFromAnalysis: !event.target.checked, confidence: 'medium' }))} />Count in totals</label></td>
        <td><span className={`status-pill status-${candidate.status}`}>{candidate.status}</span><small>{candidate.confidence} confidence</small>{candidate.duplicateReason && <small>{candidate.duplicateReason}</small>}{candidate.issues.map((issue) => <small key={issue}>{issue}</small>)}</td>
        <td><label className="remember-rule"><input type="checkbox" checked={rememberRules.has(candidate.key)} disabled={submitted || !selected.has(candidate.key) || candidate.status === 'invalid'} onChange={(event) => setRememberRules((current) => { const next = new Set(current); if (event.target.checked) next.add(candidate.key); else next.delete(candidate.key); return next; })} />Remember</label></td></tr>)}</tbody></table></div>
      {filtered.length > 150 && <p className="field-help">Showing the first 150 matching rows. Search or filter to inspect the rest; all selected rows are included on confirmation.</p>}
      <div className="confirm-import"><div><strong>Ready to import {selected.size} transactions?</strong><p>Only selected, validated rows are saved. Retry-safe IDs prevent the same confirmation from creating another copy.</p></div><button className="button button-primary" disabled={busy || submitted || selected.size === 0} onClick={() => void confirmImport()}><Check size={17} aria-hidden="true" />{busy ? 'Confirming save…' : submitted ? 'Import confirmed' : 'Confirm import'}</button></div>
    </section>}

    {(error || message) && <div className={error ? 'error-banner' : 'import-message'} role={error ? 'alert' : 'status'}>{error ? <AlertTriangle size={17} aria-hidden="true" /> : <Check size={17} aria-hidden="true" />}<span>{error || message}</span></div>}

    <section className="panel import-history"><div className="section-heading"><div><h2>Import history</h2><p className="muted">Rollback targets only transactions carrying that import ID.</p></div><History size={21} aria-hidden="true" /></div>
      {store.imports.length ? <div className="ledger-table-wrap"><table className="ledger-table"><caption>Statement import history</caption><thead><tr><th>Imported</th><th>Source</th><th>Processed</th><th>Imported</th><th>Skipped / flagged</th><th>Status</th><th>Action</th></tr></thead><tbody>{store.imports.map((record) => <tr key={record.id}><td>{new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(record.createdAt))}</td><td><strong>{record.filenames.join(', ')}</strong><small>{record.accountLabels.join(', ') || 'Unlabelled account'}</small></td><td>{record.processedCount}</td><td>{record.importedCount}</td><td>{record.skippedCount} / {record.flaggedCount}</td><td><span className={`status-pill status-${record.status}`}>{record.status.replaceAll('_', ' ')}</span></td><td><button className="button button-secondary" disabled={rollingBack !== null || record.status === 'rolled_back'} onClick={() => void rollback(record.id)}>{rollingBack === record.id ? <RotateCcw size={15} className="spin" aria-hidden="true" /> : <Trash2 size={15} aria-hidden="true" />}Rollback</button></td></tr>)}</tbody></table></div> : <p className="empty-inline">No statement import has been confirmed yet.</p>}
    </section>

    <FinancialYearReview transactions={store.analysisTransactions} imports={store.imports} asOf={asOf} analysisLimited={store.analysisLimited} />
  </div>;
}
