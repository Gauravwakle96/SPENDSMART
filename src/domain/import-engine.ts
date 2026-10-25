import { validateCalendarDate, validateTransaction } from './engine';
import type {
  CategoryRule,
  ImportCandidate,
  ImportRecord,
  ParsedStatementFile,
  PreparedImportTransaction,
  StatementColumnMapping,
} from './import-types';
import {
  EXPENSE_CATEGORIES,
  INCOME_CATEGORIES,
  type Transaction,
  type TransactionClassification,
  type TransactionInput,
  type TransactionType,
} from './types';

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9,
  sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const classificationDefaults: Record<TransactionClassification, {
  type: TransactionType;
  excludedFromAnalysis: boolean;
}> = {
  expense: { type: 'expense', excludedFromAnalysis: false },
  income: { type: 'income', excludedFromAnalysis: false },
  refund: { type: 'refund', excludedFromAnalysis: false },
  internal_transfer: { type: 'expense', excludedFromAnalysis: true },
  credit_card_payment: { type: 'expense', excludedFromAnalysis: true },
  loan_disbursement: { type: 'income', excludedFromAnalysis: true },
  loan_repayment: { type: 'expense', excludedFromAnalysis: true },
  investment: { type: 'expense', excludedFromAnalysis: true },
  cash_withdrawal: { type: 'expense', excludedFromAnalysis: true },
  fee: { type: 'expense', excludedFromAnalysis: false },
  unknown: { type: 'expense', excludedFromAnalysis: true },
};

export function classificationSettings(classification: TransactionClassification, direction?: 'debit' | 'credit') {
  const defaults = classificationDefaults[classification];
  if (classification === 'internal_transfer' || classification === 'unknown') {
    return { ...defaults, type: direction === 'credit' ? 'income' as const : 'expense' as const };
  }
  return defaults;
}

export function stableHash(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 0x01000193);
    second ^= code + index;
    second = Math.imul(second, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

export function normalizeDescription(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function maskAccountLabel(value: string): string {
  const clean = value.replace(/\s+/g, ' ').trim().slice(0, 80);
  const digits = clean.replace(/\D/g, '');
  if (digits.length < 6) return clean;
  const lastFour = digits.slice(-4);
  let seen = 0;
  const withoutLongDigits = clean.replace(/\d/g, (digit) => {
    seen += 1;
    return seen <= digits.length - 4 ? '•' : digit;
  });
  return withoutLongDigits.includes(lastFour) ? withoutLongDigits : `Account ••••${lastFour}`;
}

export function accountKey(label: string): string {
  return `acct_${stableHash(normalizeDescription(label) || 'unlabelled')}`;
}

function isoDate(year: number, month: number, day: number): string {
  const date = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  validateCalendarDate(date);
  return date;
}

export function parseStatementDate(raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error('Transaction date is missing.');
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    validateCalendarDate(value);
    return value;
  }
  if (/^\d{5}(?:\.0+)?$/.test(value)) {
    const serial = Number(value);
    if (serial >= 20_000 && serial <= 80_000) {
      const date = new Date(Date.UTC(1899, 11, 30 + Math.trunc(serial)));
      return isoDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
    }
  }
  const numeric = value.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/);
  if (numeric) {
    const year = Number(numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3]);
    return isoDate(year, Number(numeric[2]), Number(numeric[1]));
  }
  const named = value.toLowerCase().replace(/,/g, '').match(/^(\d{1,2})\s+([a-z]+)\s+(\d{2}|\d{4})$/);
  if (named && MONTHS[named[2]]) {
    const year = Number(named[3].length === 2 ? `20${named[3]}` : named[3]);
    return isoDate(year, MONTHS[named[2]], Number(named[1]));
  }
  throw new Error('Use a recognizable statement date such as DD/MM/YYYY or YYYY-MM-DD.');
}

interface MoneyValue { amountPaise: number; sign: -1 | 1 }

function parseMoney(raw: string): MoneyValue | null {
  let value = raw.trim();
  if (!value || value === '-' || /^n\/?a$/i.test(value)) return null;
  const debitSuffix = /\b(?:dr|debit)\.?$/i.test(value);
  const creditSuffix = /\b(?:cr|credit)\.?$/i.test(value);
  const parenthesized = /^\(.*\)$/.test(value);
  value = value
    .replace(/^\((.*)\)$/, '$1')
    .replace(/\b(?:inr|rs\.?|rupees?)\b/gi, '')
    .replace(/[₹,\s]/g, '')
    .replace(/(?:dr|debit|cr|credit)\.?$/i, '');
  const match = value.match(/^([+-]?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) throw new Error('A statement amount is not a valid monetary value.');
  const paise = BigInt(match[2]) * 100n + BigInt((match[3] ?? '').padEnd(2, '0'));
  if (paise <= 0n || paise > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('The amount must be positive and accurately representable in paise.');
  const negative = match[1] === '-' || parenthesized || debitSuffix;
  const positive = match[1] === '+' || creditSuffix;
  if (negative && positive) throw new Error('The amount has conflicting debit and credit markers.');
  return { amountPaise: Number(paise), sign: negative ? -1 : 1 };
}

function amountFromRow(row: string[], mapping: StatementColumnMapping): {
  amountPaise: number;
  direction: 'debit' | 'credit';
} {
  const debit = mapping.debit === null ? null : parseMoney(row[mapping.debit] ?? '');
  const credit = mapping.credit === null ? null : parseMoney(row[mapping.credit] ?? '');
  if (debit && credit) throw new Error('Both debit and credit amounts are present.');
  if (debit) return { amountPaise: debit.amountPaise, direction: 'debit' };
  if (credit) return { amountPaise: credit.amountPaise, direction: 'credit' };
  if (mapping.amount === null) throw new Error('No amount column is mapped.');
  const signed = parseMoney(row[mapping.amount] ?? '');
  if (!signed) throw new Error('Transaction amount is missing.');
  return { amountPaise: signed.amountPaise, direction: signed.sign < 0 ? 'debit' : 'credit' };
}

function containsAny(description: string, values: string[]): boolean {
  return values.some((value) => description.includes(value));
}

function merchantFromDescription(raw: string): string {
  const normalized = normalizeDescription(raw)
    .replace(/\b(?:upi|imps|neft|rtgs|ach|ecs|pos|atm|txn|transaction|ref|reference|payment|purchase)\b/g, ' ')
    .replace(/\b[a-z]*\d[a-z0-9]{7,}\b/g, ' ')
    .replace(/\b\d{6,}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (normalized || normalizeDescription(raw)).slice(0, 100);
}

function keywordCategory(description: string): { category: string; confidence: 'high' | 'medium' } | null {
  const groups: [string, string[]][] = [
    ['Food', ['swiggy', 'zomato', 'blinkit', 'zepto', 'bigbasket', 'grocery', 'supermarket', 'restaurant', 'cafe', 'cafeteria', 'mess food', 'dmart']],
    ['Travel', ['uber', 'ola cab', 'rapido', 'metro', 'irctc', 'railway', 'bus pass', 'petrol', 'diesel', 'fuel', 'airline', 'flight', 'hotel', 'makemytrip']],
    ['Shopping', ['amazon', 'flipkart', 'myntra', 'ajio', 'shopping', 'department store', 'retail store']],
    ['Bills', ['rent', 'electricity', 'water bill', 'gas bill', 'broadband', 'internet', 'mobile recharge', 'utility', 'insurance premium']],
    ['Education', ['school', 'college', 'university', 'tuition', 'course', 'udemy', 'coursera', 'book store', 'books', 'exam fee', 'education fee']],
    ['Health', ['hospital', 'pharmacy', 'medical', 'doctor', 'clinic', 'medicine', 'apollo', 'netmeds', '1mg', 'diagnostic', 'salon', 'personal care']],
    ['Entertainment', ['netflix', 'spotify', 'hotstar', 'prime video', 'pvr', 'inox', 'movie', 'cinema', 'gaming', 'subscription']],
  ];
  for (const [category, keywords] of groups) if (containsAny(description, keywords)) return { category, confidence: 'high' };
  if (containsAny(description, ['food', 'meal', 'snack'])) return { category: 'Food', confidence: 'medium' };
  if (containsAny(description, ['travel', 'transport', 'cab'])) return { category: 'Travel', confidence: 'medium' };
  return null;
}

export function suggestTransaction(
  rawDescription: string,
  direction: 'debit' | 'credit',
  rules: CategoryRule[] = [],
): {
  type: TransactionType;
  category: string;
  classification: TransactionClassification;
  excludedFromAnalysis: boolean;
  confidence: 'high' | 'medium' | 'low';
  merchant: string;
} {
  const description = normalizeDescription(rawDescription);
  const userRule = [...rules]
    .sort((first, second) => second.matchText.length - first.matchText.length)
    .find((rule) => (rule.direction === 'any' || rule.direction === direction) && description.includes(rule.matchText));
  if (userRule) {
    const settings = classificationSettings(userRule.classification, direction);
    return { type: settings.type, category: userRule.category, classification: userRule.classification,
      excludedFromAnalysis: userRule.excludedFromAnalysis, confidence: 'high', merchant: merchantFromDescription(rawDescription) };
  }
  const merchant = merchantFromDescription(rawDescription);
  if (direction === 'credit' && containsAny(description, ['refund', 'reversal', 'reversed', 'cashback', 'returned'])) {
    return { type: 'refund', category: keywordCategory(description)?.category ?? 'Other', classification: 'refund', excludedFromAnalysis: false, confidence: 'high', merchant };
  }
  if (containsAny(description, ['self transfer', 'transfer to own', 'transfer from own', 'own account transfer'])) {
    const settings = classificationSettings('internal_transfer', direction);
    return { ...settings, category: direction === 'credit' ? 'Other' : 'Other', classification: 'internal_transfer', confidence: 'high', merchant };
  }
  if (direction === 'debit' && containsAny(description, ['credit card payment', 'card bill payment', 'cc payment', 'creditcard bill'])) {
    return { type: 'expense', category: 'Bills', classification: 'credit_card_payment', excludedFromAnalysis: true, confidence: 'high', merchant };
  }
  if (direction === 'credit' && containsAny(description, ['loan disbursement', 'loan disbursal'])) {
    return { type: 'income', category: 'Other', classification: 'loan_disbursement', excludedFromAnalysis: true, confidence: 'high', merchant };
  }
  if (direction === 'debit' && containsAny(description, ['loan repayment', 'loan emi', 'emi payment'])) {
    return { type: 'expense', category: 'Bills', classification: 'loan_repayment', excludedFromAnalysis: true, confidence: 'high', merchant };
  }
  if (direction === 'debit' && containsAny(description, ['mutual fund', 'systematic investment', 'sip debit', 'zerodha', 'groww', 'demat', 'fixed deposit booking'])) {
    return { type: 'expense', category: 'Other', classification: 'investment', excludedFromAnalysis: true, confidence: 'high', merchant };
  }
  if (direction === 'debit' && containsAny(description, ['cash withdrawal', 'atm withdrawal', 'atm cash'])) {
    return { type: 'expense', category: 'Other', classification: 'cash_withdrawal', excludedFromAnalysis: true, confidence: 'high', merchant };
  }
  if (direction === 'debit' && containsAny(description, ['bank charge', 'service charge', 'sms charge', 'annual fee', 'penalty charge', 'late fee'])) {
    return { type: 'expense', category: 'Bills', classification: 'fee', excludedFromAnalysis: false, confidence: 'high', merchant };
  }
  if (direction === 'credit' && containsAny(description, ['salary', 'payroll', 'stipend'])) {
    return { type: 'income', category: 'Salary', classification: 'income', excludedFromAnalysis: false, confidence: 'high', merchant };
  }
  if (direction === 'credit' && containsAny(description, ['scholarship'])) {
    return { type: 'income', category: 'Scholarship', classification: 'income', excludedFromAnalysis: false, confidence: 'high', merchant };
  }
  if (direction === 'credit' && containsAny(description, ['allowance'])) {
    return { type: 'income', category: 'Allowance', classification: 'income', excludedFromAnalysis: false, confidence: 'high', merchant };
  }
  const category = keywordCategory(description);
  if (direction === 'debit' && category) {
    return { type: 'expense', category: category.category, classification: 'expense', excludedFromAnalysis: false, confidence: category.confidence, merchant };
  }
  const settings = classificationSettings('unknown', direction);
  return { ...settings, category: 'Other', classification: 'unknown', confidence: 'low', merchant };
}

export function transactionFingerprint(values: {
  date: string;
  description: string;
  amountPaise: number;
  direction: 'debit' | 'credit';
  accountKey: string;
}): string {
  return stableHash([values.date, normalizeDescription(values.description), values.amountPaise, values.direction, values.accountKey].join('|'));
}

export function transactionCoreHash(input: TransactionInput): string {
  return stableHash([
    input.type, input.amountPaise, input.category, input.date, input.note.trim(), input.classification ?? '',
    input.excludedFromAnalysis ? '1' : '0', input.accountKey ?? '', input.accountLabel ?? '', input.merchant ?? '',
  ].join('|'));
}

function mapped(row: string[], index: number | null): string {
  return index === null ? '' : (row[index] ?? '').trim();
}

function validateMapping(file: ParsedStatementFile): void {
  const { mapping } = file;
  if (mapping.date === null || mapping.description === null) throw new Error(`${file.fileName}: map date and description before previewing.`);
  if (mapping.amount === null && mapping.debit === null && mapping.credit === null) {
    throw new Error(`${file.fileName}: map a signed amount or debit/credit columns before previewing.`);
  }
}

export function normalizeStatements(options: {
  files: ParsedStatementFile[];
  accountLabels: Record<string, string>;
  existingTransactions: Transaction[];
  categoryRules?: CategoryRule[];
  asOf: string;
}): ImportCandidate[] {
  const { files, accountLabels, existingTransactions, categoryRules = [], asOf } = options;
  files.forEach(validateMapping);
  const existingSourceIds = new Map<string, Transaction>();
  const existingFileRows = new Map<string, Transaction>();
  const existingFingerprints = new Map<string, Transaction[]>();
  for (const transaction of existingTransactions) {
    const key = transaction.accountKey ?? accountKey(transaction.accountLabel ?? 'Unlabelled account');
    if (transaction.sourceTransactionId) existingSourceIds.set(`${key}|${normalizeDescription(transaction.sourceTransactionId)}`, transaction);
    if (transaction.sourceFileHash && transaction.sourceRowNumber) existingFileRows.set(`${transaction.sourceFileHash}|${transaction.sourceRowNumber}`, transaction);
    const fingerprint = transaction.sourceFingerprint ?? transactionFingerprint({
      date: transaction.date,
      description: transaction.note,
      amountPaise: transaction.amountPaise,
      direction: transaction.type === 'expense' ? 'debit' : 'credit',
      accountKey: key,
    });
    const matches = existingFingerprints.get(fingerprint) ?? [];
    matches.push(transaction);
    existingFingerprints.set(fingerprint, matches);
  }
  const sessionSourceIds = new Set<string>();
  const sessionFingerprints = new Map<string, number>();
  const candidates: ImportCandidate[] = [];
  for (const file of files) {
    file.rows.forEach((row, index) => {
      const sourceRowNumber = file.headerRowNumber + index + 1;
      const key = `${file.fileHash}-${sourceRowNumber}`;
      const issues: string[] = [];
      const rawDescription = mapped(row, file.mapping.description).slice(0, 500);
      let date = '';
      let amountPaise = 0;
      let direction: 'debit' | 'credit' = 'debit';
      try { date = parseStatementDate(mapped(row, file.mapping.date)); }
      catch (error) { issues.push(error instanceof Error ? error.message : 'Invalid transaction date.'); }
      try {
        const amount = amountFromRow(row, file.mapping);
        amountPaise = amount.amountPaise;
        direction = amount.direction;
      } catch (error) { issues.push(error instanceof Error ? error.message : 'Invalid transaction amount.'); }
      if (!rawDescription) issues.push('Transaction description is missing.');
      if (date && date > asOf) issues.push('Future transactions cannot be imported yet.');
      const rowAccount = mapped(row, file.mapping.accountLabel);
      const chosenAccount = maskAccountLabel(accountLabels[file.fileHash]?.trim() || rowAccount || 'Unlabelled account');
      const chosenAccountKey = accountKey(chosenAccount);
      const sourceTransactionId = mapped(row, file.mapping.reference).slice(0, 128) || undefined;
      const suggestion = suggestTransaction(rawDescription, direction, categoryRules);
      const fingerprint = transactionFingerprint({ date, description: rawDescription, amountPaise, direction, accountKey: chosenAccountKey });
      let duplicate: ImportCandidate['duplicate'] = 'none';
      let duplicateReason: string | undefined;
      const sourceKey = sourceTransactionId ? `${chosenAccountKey}|${normalizeDescription(sourceTransactionId)}` : '';
      if (sourceKey && (existingSourceIds.has(sourceKey) || sessionSourceIds.has(sourceKey))) {
        duplicate = 'exact';
        duplicateReason = 'The same bank reference already exists for this account.';
      } else if (existingFileRows.has(`${file.fileHash}|${sourceRowNumber}`)) {
        duplicate = 'exact';
        duplicateReason = 'This row from the same statement file was already imported.';
      } else if (existingFingerprints.has(fingerprint) || sessionFingerprints.has(fingerprint)) {
        duplicate = 'probable';
        duplicateReason = 'Date, amount, direction, description, and account match another record. Identical legitimate transactions are still allowed.';
      }
      if (sourceKey) sessionSourceIds.add(sourceKey);
      sessionFingerprints.set(fingerprint, (sessionFingerprints.get(fingerprint) ?? 0) + 1);
      const status: ImportCandidate['status'] = issues.length ? 'invalid'
        : suggestion.confidence === 'low' || duplicate !== 'none' ? 'review' : 'valid';
      candidates.push({ key, fileName: file.fileName, fileHash: file.fileHash, sourceRowNumber,
        rawDescription, date, amountPaise, direction, type: suggestion.type, category: suggestion.category,
        classification: suggestion.classification, excludedFromAnalysis: suggestion.excludedFromAnalysis,
        merchant: suggestion.merchant, confidence: suggestion.confidence, accountLabel: chosenAccount,
        accountKey: chosenAccountKey, sourceTransactionId, sourceFingerprint: fingerprint, duplicate,
        duplicateReason, status, issues });
    });
  }
  return candidates;
}

export function prepareImportTransactions(importId: string, candidates: ImportCandidate[]): PreparedImportTransaction[] {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(importId)) throw new Error('The import operation ID is invalid.');
  return candidates.map((candidate) => {
    if (candidate.status === 'invalid') throw new Error('Invalid rows must be corrected or excluded before importing.');
    if (!(candidate.type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES as readonly string[]).includes(candidate.category)) {
      throw new Error('An imported row has a category that is incompatible with its transaction type.');
    }
    const base: TransactionInput = {
      currency: 'INR',
      type: candidate.type,
      amountPaise: candidate.amountPaise,
      category: candidate.category,
      date: candidate.date,
      note: candidate.rawDescription.trim().slice(0, 500),
      classification: candidate.classification,
      excludedFromAnalysis: candidate.excludedFromAnalysis,
      importId,
      accountLabel: candidate.accountLabel,
      accountKey: candidate.accountKey,
      ...(candidate.sourceTransactionId ? { sourceTransactionId: candidate.sourceTransactionId } : {}),
      sourceFileHash: candidate.fileHash,
      sourceRowNumber: candidate.sourceRowNumber,
      sourceFingerprint: candidate.sourceFingerprint,
      merchant: candidate.merchant,
    };
    const input = { ...base, importOriginalHash: transactionCoreHash(base) };
    validateTransaction(input);
    return { id: `imp_${stableHash(`${importId}|${candidate.key}`)}`, input };
  });
}

export function buildImportRecord(options: {
  id: string;
  files: ParsedStatementFile[];
  candidates: ImportCandidate[];
  selected: ImportCandidate[];
}): ImportRecord {
  const validDates = options.candidates.map((candidate) => candidate.date).filter(Boolean).sort();
  return {
    id: options.id,
    createdAt: Date.now(),
    filenames: options.files.map((file) => file.fileName),
    fileHashes: options.files.map((file) => file.fileHash),
    accountLabels: [...new Set(options.candidates.map((candidate) => candidate.accountLabel))],
    processedCount: options.candidates.length,
    importedCount: options.selected.length,
    skippedCount: options.candidates.length - options.selected.length,
    flaggedCount: options.candidates.filter((candidate) => candidate.status === 'review').length,
    invalidCount: options.candidates.filter((candidate) => candidate.status === 'invalid').length,
    status: 'processing',
    ...(validDates.length ? { startDate: validDates[0], endDate: validDates[validDates.length - 1] } : {}),
  };
}

export function createCategoryRule(candidate: ImportCandidate): CategoryRule {
  const matchText = candidate.merchant || normalizeDescription(candidate.rawDescription);
  if (matchText.length < 3) throw new Error('This description is too short to create a reusable categorization rule.');
  return {
    id: `rule_${stableHash(`${candidate.direction}|${matchText}`)}`,
    matchText,
    direction: candidate.direction,
    category: candidate.category,
    classification: candidate.classification,
    excludedFromAnalysis: candidate.excludedFromAnalysis,
    createdAt: Date.now(),
  };
}
