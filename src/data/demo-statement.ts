import { indianFinancialYearFor } from '../domain/financial-analysis';

function csvCell(value: string | number): string {
  return `"${String(value).replaceAll('"', '""')}"`;
}

export function createFictionalStatementCSV(asOf: string): string {
  const current = indianFinancialYearFor(asOf);
  const startYear = Number(current.start.slice(0, 4)) - 1;
  const rows: (string | number)[][] = [[
    'Transaction Date', 'Narration', 'Debit Amount', 'Credit Amount', 'Running Balance', 'Transaction ID', 'Account Label',
  ]];
  let balance = 50_000;
  let reference = 1;
  for (let offset = 0; offset < 12; offset += 1) {
    const absoluteMonth = startYear * 12 + 3 + offset;
    const year = Math.floor(absoluteMonth / 12);
    const month = absoluteMonth % 12 + 1;
    const append = (day: number, description: string, debit: number | '', credit: number | '') => {
      if (typeof debit === 'number') balance -= debit;
      if (typeof credit === 'number') balance += credit;
      rows.push([`${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`, description,
        debit === '' ? '' : debit.toFixed(2), credit === '' ? '' : credit.toFixed(2), balance.toFixed(2),
        `FICTIONAL-${String(reference++).padStart(4, '0')}`, 'Fictional Student Account']);
    };
    append(1, 'Salary ACME Learning Stipend', '', 18_000);
    append(3, 'UPI Grocery Dmart', 2_200 + offset * 35, '');
    append(5, 'Hostel rent payment', 5_500, '');
    append(8, 'Metro travel card', 650, '');
    append(12, 'Netflix subscription', 499, '');
    append(17, offset === 7 ? 'Amazon festival shopping' : 'Amazon essentials', offset === 7 ? 8_500 : 1_100 + offset * 20, '');
    append(22, 'Self transfer to own savings account', 1_000, '');
    if (offset % 4 === 0) append(25, 'Amazon order refund', '', 300);
  }
  return '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function createFictionalStatementFile(asOf: string): File {
  return new File([createFictionalStatementCSV(asOf)], 'spendsmart-fictional-financial-year.csv', { type: 'text/csv' });
}
