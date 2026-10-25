import type { ImportRecord } from '../domain/import-types';
import type { PeriodAnalysis, RecurringInsight, SpendingAnomaly } from '../domain/financial-analysis';
import { formatMoney, monthLabel } from '../domain/engine';

function csvCell(value: string | number): string {
  const text = String(value);
  const safe = /^[\s]*[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

function csv(rows: (string | number)[][]): string {
  return '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function download(content: BlobPart, type: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function rupees(paise: number): string {
  const amount = BigInt(paise);
  const sign = amount < 0n ? '-' : '';
  const absolute = amount < 0n ? -amount : amount;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

export function downloadPeriodCSV(analysis: PeriodAnalysis): void {
  const rows: (string | number)[][] = [
    ['SpendSmart period report', analysis.period.label],
    ['Period start', analysis.period.start],
    ['Period end', analysis.period.end],
    ['Recorded income (INR)', rupees(analysis.totalIncomePaise)],
    ['Gross expenses (INR)', rupees(analysis.totalExpensePaise)],
    ['Refunds (INR)', rupees(analysis.totalRefundPaise)],
    ['Signed net expenses (INR)', rupees(analysis.netExpensePaise)],
    ['Net cash flow (INR)', rupees(analysis.netCashFlowPaise)],
    ['Observed months', analysis.coverage.observedMonths],
    ['Expected months', analysis.coverage.expectedMonths],
    [],
    ['Month', 'Income (INR)', 'Gross expenses (INR)', 'Refunds (INR)', 'Signed net expenses (INR)'],
    ...analysis.months.map((month) => [month.label, rupees(month.incomePaise), rupees(month.expensePaise), rupees(month.refundPaise), rupees(month.netExpensePaise)]),
    [],
    ['Category', 'Gross expenses (INR)', 'Refunds (INR)', 'Signed net expenses (INR)'],
    ...analysis.categories.map((category) => [category.category, rupees(category.grossExpensePaise), rupees(category.refundPaise), rupees(category.netExpensePaise)]),
    [],
    ['Account', 'Income (INR)', 'Expenses (INR)', 'Refunds (INR)', 'Net cash flow (INR)', 'Transactions'],
    ...analysis.accounts.map((account) => [account.account, rupees(account.incomePaise), rupees(account.expensePaise), rupees(account.refundPaise), rupees(account.netCashFlowPaise), account.count]),
  ];
  download(csv(rows), 'text/csv;charset=utf-8', `spendsmart-${analysis.period.start}-${analysis.period.end}.csv`);
}

export function downloadImportReconciliationCSV(imports: ImportRecord[]): void {
  const rows: (string | number)[][] = [
    ['Import ID', 'Imported at', 'Files', 'Accounts', 'Processed', 'Imported', 'Skipped', 'Flagged', 'Invalid', 'Status', 'Coverage start', 'Coverage end'],
    ...imports.map((record) => [record.id, new Date(record.createdAt).toISOString(), record.filenames.join('; '), record.accountLabels.join('; '),
      record.processedCount, record.importedCount, record.skippedCount, record.flaggedCount, record.invalidCount, record.status,
      record.startDate ?? '', record.endDate ?? '']),
  ];
  download(csv(rows), 'text/csv;charset=utf-8', 'spendsmart-import-reconciliation.csv');
}

export async function downloadFinancialPDF(
  analysis: PeriodAnalysis,
  recurring: RecurringInsight[],
  anomalies: SpendingAnomaly[],
): Promise<void> {
  const [{ jsPDF }, autoTableModule] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const autoTable = autoTableModule.default;
  const document = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageWidth = document.internal.pageSize.getWidth();
  const margin = 42;
  document.setTextColor('#172339');
  document.setFont('helvetica', 'bold');
  document.setFontSize(20);
  document.text('SpendSmart Financial Review', margin, 52);
  document.setFont('helvetica', 'normal');
  document.setFontSize(10);
  document.setTextColor('#5d6c7b');
  document.text(`${analysis.period.label} · ${analysis.period.start} to ${analysis.period.end}`, margin, 70);
  const metrics = [
    ['Recorded income', formatMoney(analysis.totalIncomePaise)],
    ['Signed net expenses', formatMoney(analysis.netExpensePaise)],
    ['Refunds', formatMoney(analysis.totalRefundPaise)],
    ['Net cash flow', formatMoney(analysis.netCashFlowPaise)],
  ];
  metrics.forEach(([label, value], index) => {
    const x = margin + (index % 2) * 250;
    const y = 105 + Math.floor(index / 2) * 48;
    document.setFontSize(9);
    document.setTextColor('#5d6c7b');
    document.text(label, x, y);
    document.setFontSize(15);
    document.setFont('helvetica', 'bold');
    document.setTextColor('#172339');
    document.text(value, x, y + 18);
    document.setFont('helvetica', 'normal');
  });
  document.setFontSize(11);
  document.setTextColor('#172339');
  document.text('Category spending', margin, 215);
  const topCategories = analysis.categories.filter((category) => category.netExpensePaise > 0).slice(0, 6);
  const maximum = Math.max(1, ...topCategories.map((category) => category.netExpensePaise));
  topCategories.forEach((category, index) => {
    const y = 238 + index * 27;
    document.setFontSize(9);
    document.text(category.category, margin, y + 9);
    document.setFillColor(index === 0 ? '#dba84b' : '#26715b');
    document.roundedRect(margin + 85, y, (pageWidth - margin * 2 - 180) * category.netExpensePaise / maximum, 11, 2, 2, 'F');
    document.text(formatMoney(category.netExpensePaise), pageWidth - margin - 82, y + 9);
  });
  autoTable(document, {
    startY: 420,
    head: [['Month', 'Income', 'Gross expenses', 'Refunds', 'Net expenses']],
    body: analysis.months.map((month) => [monthLabel(month.monthKey), formatMoney(month.incomePaise), formatMoney(month.expensePaise), formatMoney(month.refundPaise), formatMoney(month.netExpensePaise)]),
    margin: { left: margin, right: margin },
    styles: { fontSize: 8, cellPadding: 4 },
    headStyles: { fillColor: '#172339' },
  });
  autoTable(document, {
    head: [['Largest transaction', 'Date', 'Type', 'Amount']],
    body: analysis.largestTransactions.map((transaction) => [transaction.note || transaction.category, transaction.date, transaction.type, formatMoney(transaction.amountPaise)]),
    margin: { left: margin, right: margin },
    styles: { fontSize: 8, cellPadding: 4 },
    headStyles: { fillColor: '#26715b' },
  });
  if (recurring.length) autoTable(document, {
    head: [['Observed recurring activity', 'Frequency', 'Typical amount', 'Estimated annual', 'Confidence']],
    body: recurring.slice(0, 12).map((item) => [item.merchant, item.frequency, formatMoney(item.typicalAmountPaise), formatMoney(item.estimatedAnnualPaise), item.confidence]),
    margin: { left: margin, right: margin }, styles: { fontSize: 8, cellPadding: 4 }, headStyles: { fillColor: '#dba84b', textColor: '#172339' },
  });
  if (anomalies.length) autoTable(document, {
    head: [['Review indicator', 'Explanation']],
    body: anomalies.slice(0, 15).map((item) => [item.title, item.reason]),
    margin: { left: margin, right: margin }, styles: { fontSize: 8, cellPadding: 4 }, headStyles: { fillColor: '#7c91a8' },
  });
  const pageCount = document.getNumberOfPages();
  for (let page = 1; page <= pageCount; page += 1) {
    document.setPage(page);
    document.setFontSize(7);
    document.setTextColor('#5d6c7b');
    document.text(`Page ${page} of ${pageCount} · Generated locally by SpendSmart · Not financial advice`, margin, document.internal.pageSize.getHeight() - 20);
  }
  document.save(`spendsmart-${analysis.period.start}-${analysis.period.end}.pdf`);
}
