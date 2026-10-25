import readXlsxFile, { type CellValue } from 'read-excel-file/browser';
import type {
  ParsedStatementFile,
  StatementColumnMapping,
  StatementFormat,
} from '../domain/import-types';

export const MAX_IMPORT_FILES = 12;
export const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 5000;

const CSV_TYPES = new Set(['text/csv', 'application/csv', 'text/plain', 'application/vnd.ms-excel']);
const XLSX_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream',
]);

const aliases: Record<keyof StatementColumnMapping, string[]> = {
  date: ['date', 'transaction date', 'txn date', 'posting date', 'posted date', 'value date'],
  description: [
    'description',
    'narration',
    'particulars',
    'remarks',
    'transaction details',
    'details',
    'merchant',
    'memo',
  ],
  debit: ['debit', 'debit amount', 'withdrawal', 'withdrawals', 'withdrawal amount', 'dr', 'dr amount'],
  credit: ['credit', 'credit amount', 'deposit', 'deposits', 'deposit amount', 'cr', 'cr amount'],
  amount: ['amount', 'transaction amount', 'signed amount', 'txn amount'],
  balance: ['balance', 'running balance', 'closing balance', 'available balance'],
  reference: [
    'reference',
    'reference number',
    'reference no',
    'ref no',
    'transaction id',
    'txn id',
    'utr',
    'utr number',
    'cheque number',
    'chq no',
  ],
  accountLabel: ['account', 'account label', 'account name', 'account number', 'account no'],
};

function normalizedHeader(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[_./()-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function headerScore(header: string, candidates: string[]): number {
  const normalized = normalizedHeader(header);
  let score = 0;
  for (const candidate of candidates) {
    if (normalized === candidate) score = Math.max(score, 100 + candidate.length);
    else if (normalized.includes(candidate) || candidate.includes(normalized)) score = Math.max(score, 40 + Math.min(normalized.length, candidate.length));
  }
  return score;
}

export function detectStatementMapping(headers: string[]): {
  mapping: StatementColumnMapping;
  warnings: string[];
  score: number;
} {
  const warnings: string[] = [];
  const mapping = {} as StatementColumnMapping;
  let total = 0;
  for (const field of Object.keys(aliases) as (keyof StatementColumnMapping)[]) {
    const matches = headers
      .map((header, index) => ({ index, score: headerScore(header, aliases[field]) }))
      .filter((match) => match.score > 0)
      .sort((first, second) => second.score - first.score || first.index - second.index);
    mapping[field] = matches[0]?.index ?? null;
    if (matches[0]) total += matches[0].score;
    if (matches.length > 1 && matches[0].score === matches[1].score) {
      mapping[field] = null;
      warnings.push(`Choose the ${field === 'accountLabel' ? 'account label' : field} column; more than one header matched.`);
    }
  }
  warnings.push(...statementMappingWarnings(mapping));
  return { mapping, warnings, score: total };
}

export function statementMappingWarnings(mapping: StatementColumnMapping): string[] {
  const warnings: string[] = [];
  if (mapping.date === null) warnings.push('Choose the transaction date column.');
  if (mapping.description === null) warnings.push('Choose the description or narration column.');
  const separate = mapping.debit !== null || mapping.credit !== null;
  if (!separate && mapping.amount === null) warnings.push('Choose either a signed amount column or debit/credit columns.');
  if (mapping.amount !== null && separate) warnings.push('Both signed amount and debit/credit columns are mapped. Debit/credit columns will be used.');
  return warnings;
}

function uniqueHeaders(values: string[]): string[] {
  const counts = new Map<string, number>();
  return values.map((value, index) => {
    const base = value.trim() || `Column ${index + 1}`;
    const count = (counts.get(base) ?? 0) + 1;
    counts.set(base, count);
    return count === 1 ? base : `${base} (${count})`;
  });
}

function chooseHeader(grid: string[][]): {
  headers: string[];
  rows: string[][];
  headerRowNumber: number;
  mapping: StatementColumnMapping;
  mappingWarnings: string[];
  score: number;
} {
  const candidates = grid.slice(0, 20).map((row, index) => {
    const headers = uniqueHeaders(row);
    const detected = detectStatementMapping(headers);
    const requiredBonus = detected.mapping.date !== null
      && detected.mapping.description !== null
      && (detected.mapping.amount !== null || detected.mapping.debit !== null || detected.mapping.credit !== null)
      ? 1000
      : 0;
    return { index, headers, detected, score: detected.score + requiredBonus };
  });
  const best = candidates.sort((first, second) => second.score - first.score || first.index - second.index)[0];
  if (!best || best.score === 0) throw new Error('No usable header row was found. Add column headings for date, description, and amount.');
  const width = best.headers.length;
  const rows = grid
    .slice(best.index + 1)
    .map((row) => Array.from({ length: width }, (_, index) => row[index]?.trim() ?? ''))
    .filter((row) => row.some(Boolean));
  return {
    headers: best.headers,
    rows,
    headerRowNumber: best.index + 1,
    mapping: best.detected.mapping,
    mappingWarnings: best.detected.warnings,
    score: best.score,
  };
}

function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === delimiter) {
      row.push(cell.trim());
      cell = '';
    } else if (char === '\n') {
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') cell += char;
  }
  if (quoted) throw new Error('The CSV contains an unclosed quoted value.');
  if (cell.length || row.length) {
    row.push(cell.trim());
    rows.push(row);
  }
  return rows.filter((entry) => entry.some(Boolean));
}

function delimiterScore(text: string, delimiter: string): number {
  try {
    const rows = parseDelimited(text.slice(0, 100_000), delimiter).slice(0, 15);
    if (rows.length < 2) return 0;
    const widths = rows.map((row) => row.length).filter((width) => width > 1);
    if (!widths.length) return 0;
    const common = Math.max(...widths.map((width) => widths.filter((candidate) => candidate === width).length));
    return common * 100 + Math.max(...widths);
  } catch {
    return 0;
  }
}

function parseCSV(text: string): string[][] {
  if (text.includes('\0')) throw new Error('The CSV contains binary data and cannot be read safely.');
  const clean = text.replace(/^\uFEFF/, '');
  const delimiter = [',', '\t', ';', '|']
    .map((value) => ({ value, score: delimiterScore(clean, value) }))
    .sort((first, second) => second.score - first.score)[0];
  if (!delimiter || delimiter.score === 0) {
    const fallback = [',', '\t', ';', '|'].find((value) => clean.includes(value));
    if (fallback) return parseDelimited(clean, fallback);
    throw new Error('The CSV delimiter could not be detected.');
  }
  return parseDelimited(clean, delimiter.value);
}

function cellText(value: CellValue | null): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  return String(value).trim();
}

async function sha256(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function formatOf(file: File): StatementFormat {
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (extension !== 'csv' && extension !== 'xlsx') throw new Error(`${file.name}: only CSV and XLSX statements are supported.`);
  if (file.type) {
    const allowed = extension === 'csv' ? CSV_TYPES : XLSX_TYPES;
    if (!allowed.has(file.type)) throw new Error(`${file.name}: the file type does not match its ${extension.toUpperCase()} extension.`);
  }
  return extension;
}

async function parseOne(file: File): Promise<ParsedStatementFile> {
  if (!file.size) throw new Error(`${file.name}: the file is empty.`);
  if (file.size > MAX_IMPORT_FILE_BYTES) throw new Error(`${file.name}: files must be 10 MB or smaller.`);
  const format = formatOf(file);
  const buffer = await file.arrayBuffer();
  const fileHash = await sha256(buffer);
  if (format === 'csv') {
    const grid = parseCSV(new TextDecoder('utf-8', { fatal: false }).decode(buffer));
    const selected = chooseHeader(grid);
    return { fileName: file.name, fileHash, format, ...selected };
  }
  const sheets = await readXlsxFile(file);
  const choices = sheets
    .filter((sheet) => sheet.data.some((row) => row.some((cell) => cell !== null && String(cell).trim())))
    .map((sheet) => {
      const grid = sheet.data.map((row) => row.map(cellText));
      try { return { sheet: sheet.sheet, selected: chooseHeader(grid) }; }
      catch { return null; }
    })
    .filter((choice): choice is NonNullable<typeof choice> => choice !== null)
    .sort((first, second) => second.selected.score - first.selected.score);
  if (!choices.length) throw new Error(`${file.name}: no worksheet contains a usable statement table.`);
  const chosen = choices[0];
  const warnings = [...chosen.selected.mappingWarnings];
  if (choices.length > 1) warnings.push(`Worksheet “${chosen.sheet}” was selected automatically; other worksheets were not imported.`);
  return { fileName: file.name, fileHash, format, ...chosen.selected, mappingWarnings: warnings };
}

export async function parseStatementFiles(files: File[]): Promise<ParsedStatementFile[]> {
  if (!files.length) throw new Error('Choose at least one CSV or XLSX statement.');
  if (files.length > MAX_IMPORT_FILES) throw new Error(`Import at most ${MAX_IMPORT_FILES} files in one session.`);
  const parsed = await Promise.all(files.map(parseOne));
  if (new Set(parsed.map((file) => file.fileHash)).size !== parsed.length) throw new Error('The same statement file was selected more than once.');
  const rows = parsed.reduce((total, file) => total + file.rows.length, 0);
  if (!rows) throw new Error('No transaction rows were found.');
  if (rows > MAX_IMPORT_ROWS) throw new Error(`This session contains ${rows} rows. Import at most ${MAX_IMPORT_ROWS} rows at a time.`);
  return parsed;
}
