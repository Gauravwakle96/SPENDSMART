export type TransactionType = 'expense' | 'income' | 'refund';

export interface Transaction {
  /** Missing on legacy records; the single supported currency is INR. */
  currency?: 'INR';
  id: string;
  type: TransactionType;
  amountPaise: number;
  category: string;
  date: string;
  note: string;
  createdAt: number;
}

export type TransactionInput = Omit<Transaction, 'id' | 'createdAt'>;

export interface Budget {
  /** Missing on legacy records; the single supported currency is INR. */
  currency?: 'INR';
  monthKey: string;
  limitPaise: number;
  categoryLimits: Record<string, number>;
}

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
}

export type AlertCode = 'BUDGET_UNSET' | 'NEAR_LIMIT' | 'BUDGET_EXCEEDED' | 'PACE_RISK' | 'CATEGORY_NEAR_LIMIT' | 'CATEGORY_EXCEEDED';

export interface BudgetAlert {
  code: AlertCode;
  severity: 'info' | 'warning' | 'danger';
  title: string;
  message: string;
  formula?: string;
  category?: string;
}

export interface CategorySpend {
  category: string;
  spentPaise: number;
  limitPaise: number | null;
  usagePercent: number | null;
}

export interface DailyPoint {
  day: number;
  spentPaise: number;
  cumulativePaise: number;
  budgetPacePaise: number | null;
}

export interface BudgetInsights {
  monthKey: string;
  totalIncomePaise: number;
  totalExpensePaise: number;
  totalRefundPaise: number;
  netSpendPaise: number;
  balancePaise: number;
  limitPaise: number | null;
  remainingPaise: number | null;
  usagePercent: number | null;
  forecastPaise: number;
  safeDailyPaise: number | null;
  elapsedDays: number;
  daysInMonth: number;
  daysRemaining: number;
  categorySpend: CategorySpend[];
  alerts: BudgetAlert[];
  chartData: DailyPoint[];
  recentTransactions: Transaction[];
}

export const EXPENSE_CATEGORIES = ['Food', 'Travel', 'Shopping', 'Bills', 'Education', 'Health', 'Entertainment', 'Other'] as const;
export const INCOME_CATEGORIES = ['Allowance', 'Scholarship', 'Salary', 'Other'] as const;
