export interface StudentPlan {
  monthKey: string;
  currency: 'INR';
  expectedIncome: Record<string, number>;
  essentialCategories: string[];
}

export interface PlannedExpense {
  id: string;
  title: string;
  amountPaise: number;
  category: string;
  dueDate: string;
  status: 'planned' | 'paid';
  transactionId?: string;
  createdAt: number;
}

export interface SavingsGoal {
  id: string;
  title: string;
  targetPaise: number;
  reservedPaise: number;
  targetDate: string;
  createdAt: number;
}

export interface FinancialContext {
  planning?: StudentPlan;
  plannedExpenses?: PlannedExpense[];
  goals?: SavingsGoal[];
  /** Undefined derives balance from a complete local ledger; null means unavailable. */
  balanceOverridePaise?: number | null;
  selectedCategory?: string;
}

export interface MonthlySummary {
  monthKey: string;
  label: string;
  incomePaise: number;
  expensePaise: number;
}
