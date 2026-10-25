import type {
  TransactionClassification,
  TransactionInput,
  TransactionType,
} from './types';

export type StatementFormat = 'csv' | 'xlsx';

export interface StatementColumnMapping {
  date: number | null;
  description: number | null;
  debit: number | null;
  credit: number | null;
  amount: number | null;
  balance: number | null;
  reference: number | null;
  accountLabel: number | null;
}

export interface ParsedStatementFile {
  fileName: string;
  fileHash: string;
  format: StatementFormat;
  headers: string[];
  rows: string[][];
  headerRowNumber: number;
  mapping: StatementColumnMapping;
  mappingWarnings: string[];
}

export type ImportConfidence = 'high' | 'medium' | 'low';
export type DuplicateKind = 'none' | 'exact' | 'probable';
export type CandidateStatus = 'valid' | 'review' | 'invalid';

export interface ImportCandidate {
  key: string;
  fileName: string;
  fileHash: string;
  sourceRowNumber: number;
  rawDescription: string;
  date: string;
  amountPaise: number;
  direction: 'debit' | 'credit';
  type: TransactionType;
  category: string;
  classification: TransactionClassification;
  excludedFromAnalysis: boolean;
  merchant: string;
  confidence: ImportConfidence;
  accountLabel: string;
  accountKey: string;
  sourceTransactionId?: string;
  sourceFingerprint: string;
  duplicate: DuplicateKind;
  duplicateReason?: string;
  status: CandidateStatus;
  issues: string[];
}

export interface PreparedImportTransaction {
  id: string;
  input: TransactionInput;
}

export type ImportStatus =
  | 'processing'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'rolled_back'
  | 'partial_rollback';

export interface ImportRecord {
  id: string;
  createdAt: number;
  updatedAt?: number;
  filenames: string[];
  fileHashes: string[];
  accountLabels: string[];
  processedCount: number;
  importedCount: number;
  skippedCount: number;
  flaggedCount: number;
  invalidCount: number;
  status: ImportStatus;
  startDate?: string;
  endDate?: string;
}

export interface CategoryRule {
  id: string;
  matchText: string;
  direction: 'debit' | 'credit' | 'any';
  category: string;
  classification: TransactionClassification;
  excludedFromAnalysis: boolean;
  createdAt: number;
}

export interface ImportCommitResult {
  importedCount: number;
  skippedCount: number;
}

export interface ImportRollbackResult {
  deletedCount: number;
  conflictCount: number;
}
