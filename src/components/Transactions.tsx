import { useMemo, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Download,
  Pencil,
  Plus,
  ReceiptText,
  Search,
  Trash2,
} from 'lucide-react';
import { useSpendSmart } from '../data/SpendSmartProvider';
import { formatMoney, monthLabel, transactionsToCSV } from '../domain/engine';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES, type Transaction } from '../domain/types';

interface Props {
  monthKey: string;
  asOf: string;
  onEdit: (transaction: Transaction) => void;
  onAdded: () => void;
  notify: (message: string) => void;
}

export function Transactions({ monthKey, asOf, onEdit, onAdded, notify }: Props) {
  const store = useSpendSmart();
  const [search, setSearch] = useState('');
  const [type, setType] = useState('all');
  const [category, setCategory] = useState('all');
  const [from, setFrom] = useState(`${monthKey}-01`);
  const [to, setTo] = useState(
    monthKey === asOf.slice(0, 7)
      ? asOf
      : `${monthKey}-${new Date(Number(monthKey.slice(0, 4)), Number(monthKey.slice(5)), 0).getDate()}`,
  );
  const [sort, setSort] = useState('date-desc');
  const [page, setPage] = useState(1);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const pageSize = 20;
  const invalidRange = Boolean(from && to && from > to);
  const rows = useMemo(
    () =>
      store.transactions
        .filter(
          (item) =>
            !invalidRange &&
            item.date.startsWith(`${monthKey}-`) &&
            item.date <= asOf &&
            (!from || item.date >= from) &&
            (!to || item.date <= to) &&
            (type === 'all' || item.type === type) &&
            (category === 'all' || item.category === category) &&
            `${item.note} ${item.category} ${item.date} ${formatMoney(item.amountPaise)}`
              .toLowerCase()
              .includes(search.toLowerCase()),
        )
        .sort((a, b) => {
          const order = sort.startsWith('amount')
            ? a.amountPaise - b.amountPaise
            : a.date.localeCompare(b.date) || a.createdAt - b.createdAt;
          return (sort.endsWith('desc') ? -order : order) || a.id.localeCompare(b.id);
        }),
    [store.transactions, monthKey, asOf, from, to, type, category, search, sort, invalidRange],
  );
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const displayed = rows.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const allCategories = [...new Set<string>([...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES])];
  const change = (setter: (value: string) => void, value: string) => {
    setter(value);
    setPage(1);
  };

  async function remove(item: Transaction) {
    if (
      pendingDelete ||
      !window.confirm(
        `Delete ${item.note || item.category} (${formatMoney(item.amountPaise)})? Its budget and report totals will be recalculated.`,
      )
    )
      return;
    setPendingDelete(item.id);
    try {
      await store.deleteTransaction(item.id);
      notify('Transaction deleted. Totals recalculated.');
    } catch {
      /* The provider preserves the record and displays the error. */
    } finally {
      setPendingDelete(null);
    }
  }

  function exportRows() {
    const url = URL.createObjectURL(
      new Blob([transactionsToCSV(rows)], { type: 'text/csv;charset=utf-8;' }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `spendsmart-${monthKey}-filtered.csv`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <section className="panel ledger-panel">
      <div className="section-heading">
        <div>
          <h2>Your transactions</h2>
          <p className="muted">Actual money in and out. Plans stay separate.</p>
        </div>
        <button className="button button-secondary" onClick={exportRows} disabled={!rows.length}>
          <Download size={16} aria-hidden="true" />
          Export filtered CSV
        </button>
      </div>
      <div className="ledger-filters">
        <label className="search-input">
          <Search size={18} aria-hidden="true" />
          <span className="sr-only">Search transactions</span>
          <input
            value={search}
            onChange={(event) => change(setSearch, event.target.value)}
            placeholder="Search notes, categories, amounts"
          />
        </label>
        <label>
          <span className="sr-only">Filter transaction type</span>
          <select value={type} onChange={(event) => change(setType, event.target.value)}>
            <option value="all">All activity</option>
            <option value="expense">Expenses</option>
            <option value="income">Income</option>
            <option value="refund">Refunds</option>
          </select>
        </label>
        <label>
          <span className="sr-only">Filter category</span>
          <select value={category} onChange={(event) => change(setCategory, event.target.value)}>
            <option value="all">All categories</option>
            {allCategories.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="ledger-date-filters">
        <label>
          From date
          <input
            type="date"
            min={`${monthKey}-01`}
            max={asOf}
            value={from}
            onChange={(event) => change(setFrom, event.target.value)}
          />
        </label>
        <label>
          To date
          <input
            type="date"
            min={`${monthKey}-01`}
            max={asOf}
            value={to}
            onChange={(event) => change(setTo, event.target.value)}
          />
        </label>
        <label>
          Sort transactions
          <select value={sort} onChange={(event) => change(setSort, event.target.value)}>
            <option value="date-desc">Newest first</option>
            <option value="date-asc">Oldest first</option>
            <option value="amount-desc">Highest amount</option>
            <option value="amount-asc">Lowest amount</option>
          </select>
        </label>
      </div>
      {invalidRange && (
        <p className="form-error" role="alert">
          The start date must be on or before the end date.
        </p>
      )}
      <p className="ledger-count" role="status">
        {rows.length} matching transaction{rows.length === 1 ? '' : 's'} · {monthLabel(monthKey)}
        {rows.length > pageSize &&
          ` · Showing ${(currentPage - 1) * pageSize + 1}–${Math.min(currentPage * pageSize, rows.length)}`}
      </p>
      {rows.length ? (
        <>
          <div className="ledger-table-wrap">
            <table className="ledger-table">
              <caption className="sr-only">
                Filtered transactions for {monthLabel(monthKey)}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Transaction</th>
                  <th scope="col">Category</th>
                  <th scope="col">Date</th>
                  <th scope="col" className="amount-column">
                    Amount
                  </th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {displayed.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <div className="transaction-description">
                        <span className={`transaction-symbol ${item.type}`}>
                          {item.type === 'expense' ? (
                            <ArrowUpRight size={18} aria-hidden="true" />
                          ) : (
                            <ArrowDownLeft size={18} aria-hidden="true" />
                          )}
                        </span>
                        <div>
                          <strong title={item.note || item.category}>
                            {item.note || item.category}
                          </strong>
                          <small>
                            {item.type}
                            <span className="mobile-transaction-detail">
                              {' '}
                              · {item.category} · {item.date.slice(8)}
                            </span>
                          </small>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className="category-tag">{item.category}</span>
                    </td>
                    <td>
                      {new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' }).format(
                        new Date(`${item.date}T12:00:00`),
                      )}
                    </td>
                    <td className={`amount-column amount-${item.type}`}>
                      {item.type === 'expense' ? '−' : '+'}
                      {formatMoney(item.amountPaise)}
                    </td>
                    <td>
                      <div className="row-actions">
                        <button
                          className="icon-button"
                          aria-label={`Edit ${item.note || item.category}`}
                          onClick={() => onEdit(item)}
                          disabled={pendingDelete !== null}
                        >
                          <Pencil size={16} aria-hidden="true" />
                        </button>
                        <button
                          className="icon-button danger-icon"
                          aria-label={`Delete ${item.note || item.category}`}
                          onClick={() => void remove(item)}
                          disabled={pendingDelete !== null}
                        >
                          <Trash2 size={16} aria-hidden="true" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pagination">
            <span>
              Page {currentPage} of {pageCount}
            </span>
            <div>
              <button
                className="button button-secondary"
                disabled={currentPage === 1}
                onClick={() => setPage(currentPage - 1)}
                aria-label="Previous transaction page"
              >
                <ChevronLeft size={16} aria-hidden="true" />
                Previous
              </button>
              <button
                className="button button-secondary"
                disabled={currentPage === pageCount}
                onClick={() => setPage(currentPage + 1)}
                aria-label="Next transaction page"
              >
                Next
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            </div>
          </div>
        </>
      ) : (
        <div className="empty-state">
          <ReceiptText size={32} aria-hidden="true" />
          <h3>No transactions in this view.</h3>
          <p>Adjust your filters or add your first transaction.</p>
          <button className="button button-primary" onClick={onAdded}>
            <Plus size={16} aria-hidden="true" />
            Add transaction
          </button>
        </div>
      )}
    </section>
  );
}
