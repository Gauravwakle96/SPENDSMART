import { describe, expect, it } from 'vitest';
import {
  accountKey,
  classificationSettings,
  createCategoryRule,
  maskAccountLabel,
  normalizeStatements,
  parseStatementDate,
  prepareImportTransactions,
  suggestTransaction,
  transactionCoreHash,
} from './import-engine';
import type { CategoryRule, ParsedStatementFile } from './import-types';
import type { Transaction } from './types';

const file = (rows: string[][], mapping: Partial<ParsedStatementFile['mapping']> = {}): ParsedStatementFile => ({
  fileName: 'statement.csv',
  fileHash: 'a'.repeat(64),
  format: 'csv',
  headers: ['Date', 'Description', 'Debit', 'Credit', 'Amount', 'Reference'],
  rows,
  headerRowNumber: 1,
  mapping: { date: 0, description: 1, debit: 2, credit: 3, amount: null, balance: null, reference: 5, accountLabel: null, ...mapping },
  mappingWarnings: [],
});

const normalize = (statement: ParsedStatementFile, existingTransactions: Transaction[] = [], rules: CategoryRule[] = []) => normalizeStatements({
  files: [statement], accountLabels: { [statement.fileHash]: 'Salary account' }, existingTransactions,
  categoryRules: rules, asOf: '2026-10-25',
});

describe('statement normalization and categorization', () => {
  it('normalizes separate debit and credit columns into positive integer paise', () => {
    const candidates = normalize(file([
      ['20/04/2026', 'Dmart grocery', '1,234.56', '', '', 'DEBIT-1'],
      ['21/04/2026', 'Salary payroll', '', '18000.29', '', 'CREDIT-1'],
    ]));
    expect(candidates.map((candidate) => [candidate.amountPaise, candidate.direction, candidate.type, candidate.category])).toEqual([
      [123456, 'debit', 'expense', 'Food'],
      [1800029, 'credit', 'income', 'Salary'],
    ]);
  });

  it('supports signed amount columns and exact decimal precision', () => {
    const statement = file([['20/04/2026', 'Metro travel', '', '', '-0.29', 'SIGNED-1']], { debit: null, credit: null, amount: 4 });
    const [candidate] = normalize(statement);
    expect(candidate.amountPaise).toBe(29);
    expect(candidate.direction).toBe('debit');
    expect(candidate.category).toBe('Travel');
  });

  it('marks invalid dates, malformed amounts, and future rows without discarding them', () => {
    const candidates = normalize(file([
      ['31/02/2026', 'Food', '100', '', '', 'BAD-DATE'],
      ['20/04/2026', 'Food', '1.001', '', '', 'BAD-AMOUNT'],
      ['26/10/2026', 'Food', '100', '', '', 'FUTURE'],
    ]));
    expect(candidates).toHaveLength(3);
    expect(candidates.every((candidate) => candidate.status === 'invalid')).toBe(true);
    expect(candidates.flatMap((candidate) => candidate.issues).join(' ')).toMatch(/date|amount|Future/i);
  });

  it('distinguishes exact bank-reference duplicates from probable fingerprint matches', () => {
    const account = accountKey('Salary account');
    const existing: Transaction[] = [{ id: 'existing', type: 'expense', amountPaise: 50000, category: 'Other', date: '2026-04-20',
      note: 'Local merchant', createdAt: 1, accountLabel: 'Salary account', accountKey: account, sourceTransactionId: 'BANK-1' }];
    const candidates = normalize(file([
      ['20/04/2026', 'Different text', '500', '', '', 'BANK-1'],
      ['20/04/2026', 'Local merchant', '500', '', '', 'BANK-2'],
    ]), existing);
    expect(candidates[0].duplicate).toBe('exact');
    expect(candidates[1].duplicate).toBe('probable');
    expect(candidates[1].duplicateReason).toContain('legitimate');
  });

  it('keeps identical legitimate rows as probable review candidates instead of exact auto-skips', () => {
    const candidates = normalize(file([
      ['20/04/2026', 'Cafeteria', '100', '', '', ''],
      ['20/04/2026', 'Cafeteria', '100', '', '', ''],
    ]));
    expect(candidates.map((candidate) => candidate.duplicate)).toEqual(['none', 'probable']);
    expect(candidates[1].status).toBe('review');
  });

  it('classifies transfers and card payments as excluded rather than ordinary expenses', () => {
    expect(suggestTransaction('Self transfer to own account', 'debit')).toMatchObject({ classification: 'internal_transfer', excludedFromAnalysis: true });
    expect(suggestTransaction('Credit card payment', 'debit')).toMatchObject({ classification: 'credit_card_payment', excludedFromAnalysis: true });
    expect(suggestTransaction('Unclear incoming credit', 'credit')).toMatchObject({ classification: 'unknown', type: 'income', excludedFromAnalysis: true, confidence: 'low' });
    expect(classificationSettings('refund', 'credit')).toEqual({ type: 'refund', excludedFromAnalysis: false });
  });

  it('applies a user-approved rule before keywords and can create a reusable rule', () => {
    const rules: CategoryRule[] = [{ id: 'rule-local', matchText: 'campus cooperative', direction: 'debit', category: 'Education',
      classification: 'expense', excludedFromAnalysis: false, createdAt: 1 }];
    const [candidate] = normalize(file([['20/04/2026', 'UPI Campus Cooperative', '500', '', '', 'RULE-1']]), [], rules);
    expect(candidate.category).toBe('Education');
    expect(candidate.confidence).toBe('high');
    expect(createCategoryRule(candidate)).toMatchObject({ direction: 'debit', category: 'Education' });
  });

  it('prepares deterministic retry-safe IDs and detects later edits through the original hash', () => {
    const [candidate] = normalize(file([['20/04/2026', 'Dmart grocery', '100', '', '', 'PREP-1']]));
    const first = prepareImportTransactions('import-one', [candidate]);
    const retry = prepareImportTransactions('import-one', [candidate]);
    expect(retry).toEqual(first);
    expect(transactionCoreHash(first[0].input)).toBe(first[0].input.importOriginalHash);
    expect(transactionCoreHash({ ...first[0].input, amountPaise: 20000 })).not.toBe(first[0].input.importOriginalHash);
  });

  it('supports common dates and masks account numbers in labels', () => {
    expect(parseStatementDate('29/02/2024')).toBe('2024-02-29');
    expect(parseStatementDate('20 Apr 2026')).toBe('2026-04-20');
    expect(() => parseStatementDate('29/02/2026')).toThrow();
    expect(maskAccountLabel('Savings account 123456789012')).toContain('••••••••9012');
  });
});
