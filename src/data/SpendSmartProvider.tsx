import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { SpendSmartStore, type SpendSmartState } from './store';

type StoreActions = Pick<SpendSmartStore, 'signIn' | 'signUp' | 'resetPassword' | 'signOut' | 'startDemo' | 'addTransaction' | 'updateTransaction'
  | 'deleteTransaction' | 'saveBudget' | 'clearError' | 'savePlan' | 'savePlannedExpense' | 'deletePlannedExpense' | 'recordPlannedExpense'
  | 'saveGoal' | 'deleteGoal' | 'resetDemo' | 'setSelectedMonth' | 'refreshCloud' | 'importTransactions' | 'rollbackImport'
  | 'saveCategoryRule' | 'deleteCategoryRule'>;

export type SpendSmartContextValue = SpendSmartState & StoreActions;
const SpendSmartContext = createContext<SpendSmartContextValue | null>(null);

export function SpendSmartProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new SpendSmartStore());
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => { store.connect(); return store.disconnect; }, [store]);
  const value: SpendSmartContextValue = { ...state,
    signIn: store.signIn, signUp: store.signUp, resetPassword: store.resetPassword, signOut: store.signOut, startDemo: store.startDemo,
    addTransaction: store.addTransaction, updateTransaction: store.updateTransaction, deleteTransaction: store.deleteTransaction, saveBudget: store.saveBudget,
    clearError: store.clearError, savePlan: store.savePlan, savePlannedExpense: store.savePlannedExpense, deletePlannedExpense: store.deletePlannedExpense,
    recordPlannedExpense: store.recordPlannedExpense, saveGoal: store.saveGoal, deleteGoal: store.deleteGoal, resetDemo: store.resetDemo,
    setSelectedMonth: store.setSelectedMonth, refreshCloud: store.refreshCloud, importTransactions: store.importTransactions,
    rollbackImport: store.rollbackImport, saveCategoryRule: store.saveCategoryRule, deleteCategoryRule: store.deleteCategoryRule };
  return <SpendSmartContext.Provider value={value}>{children}</SpendSmartContext.Provider>;
}

export function useSpendSmart(): SpendSmartContextValue {
  const context = useContext(SpendSmartContext);
  if (!context) throw new Error('useSpendSmart must be used inside SpendSmartProvider.');
  return context;
}
