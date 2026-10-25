import { onIdTokenChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, sendPasswordResetEmail, signOut, updateProfile } from 'firebase/auth';
import { collection, limit, onSnapshot, orderBy, query, where, type QuerySnapshot, type Unsubscribe } from 'firebase/firestore';
import { getMonthlyTrend, monthLabel, todayISO, validateBudget, validateTransaction } from '../domain/engine';
import type { Budget, Transaction, TransactionInput, UserProfile } from '../domain/types';
import type { MonthlySummary, PlannedExpense, SavingsGoal, StudentPlan } from '../domain/planning-types';
import type { CategoryRule, ImportRecord, ImportRollbackResult, PreparedImportTransaction } from '../domain/import-types';
import { transactionCoreHash } from '../domain/import-engine';
import { auth, database } from './firebase';
import { CloudWriter, loadCloudSummaries, monthRange } from './cloud';
import { createDemoData, DEMO_DATA_KEY, DEMO_SESSION_KEY, readBudget, readCategoryRule, readImportRecord, readPlannedExpense, readSavingsGoal, readStudentPlan, readTransaction,
  recoverDemoData, serializeDemoData, type DemoData } from './demo';
import { MAX_ANALYSIS_TRANSACTIONS, MAX_CATEGORY_RULES, MAX_GOALS, MAX_IMPORT_HISTORY, MAX_OPEN_PLANNED_EXPENSES,
  validateCategoryRule, validateImportRecord, validatePlannedExpense, validateSavingsGoal, validateStudentPlan, validRecordId } from './validation';

export type SyncStatus = 'synced' | 'offline' | 'pending' | 'error' | 'session-only';
type Mode = 'signed-out' | 'demo' | 'cloud';
export interface SpendSmartState {
  mode: Mode; user: UserProfile | null; ready: boolean; error: string | null;
  transactions: Transaction[]; budgets: Budget[]; planning: StudentPlan[]; plannedExpenses: PlannedExpense[]; goals: SavingsGoal[];
  analysisTransactions: Transaction[]; analysisLimited: boolean; imports: ImportRecord[]; categoryRules: CategoryRule[];
  syncStatus: SyncStatus; ledgerBalancePaise: number | null; monthTrend: MonthlySummary[] | null;
  summaryUpdatedAt: number | null; selectedMonth: string;
}

const emptyDemo = (): DemoData => ({ transactions: [], budgets: [], planning: [], plannedExpenses: [], goals: [], imports: [], categoryRules: [] });
const demoUser: UserProfile = { uid: 'local-demo', email: '', displayName: 'Demo student' };
const sortTransactions = (records: Transaction[]) => [...records].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt || a.id.localeCompare(b.id));

export function friendlyError(cause: unknown): string {
  const code = typeof cause === 'object' && cause !== null && 'code' in cause ? String(cause.code) : '';
  const messages: Record<string, string> = {
    'auth/invalid-credential': 'The email or password is incorrect. Please try again.',
    'auth/wrong-password': 'The email or password is incorrect. Please try again.',
    'auth/user-not-found': 'The email or password is incorrect. Please try again.',
    'auth/invalid-email': 'Enter a valid email address.',
    'auth/email-already-in-use': 'An account already uses this email. Try signing in.',
    'auth/weak-password': 'Use a password with at least 6 characters.',
    'auth/too-many-requests': 'Too many attempts. Wait a little before trying again.',
    'auth/network-request-failed': 'Could not reach Firebase. Check your internet connection.',
    'auth/operation-not-allowed': 'Enable Email/Password sign-in in your Firebase project.',
    'auth/unauthorized-domain': 'Add this website to Firebase Authentication authorized domains.',
    'auth/invalid-api-key': 'The Firebase API key is invalid. Check the project configuration.',
    'auth/user-token-expired': 'Your session expired. Please sign in again.',
    'auth/invalid-user-token': 'Your session is no longer valid. Please sign in again.',
    'auth/invalid-refresh-token': 'Your session is no longer valid. Please sign in again.',
    'auth/user-disabled': 'This account is disabled. Please contact the project owner.',
    'permission-denied': 'Cloud access was denied. Reconnect your session and check the deployed Firestore rules.',
    'unauthenticated': 'Your session expired. Please sign in again.',
    'unavailable': 'Cloud storage could not be reached. No save is confirmed yet.',
    'failed-precondition': 'This cloud query needs its Firestore index. Deploy firestore.indexes.json and try again.',
  };
  if (messages[code]) return messages[code];
  if (cause instanceof Error && !code) return cause.message;
  return 'The operation could not be completed. Please try again.';
}

export class SpendSmartStore {
  private state: SpendSmartState = { mode: 'signed-out', user: null, ready: !auth || !database, error: null,
    transactions: [], budgets: [], planning: [], plannedExpenses: [], goals: [], syncStatus: 'synced',
    analysisTransactions: [], analysisLimited: false, imports: [], categoryRules: [],
    ledgerBalancePaise: null, monthTrend: null, summaryUpdatedAt: null, selectedMonth: todayISO().slice(0, 7) };
  private subscribers = new Set<() => void>();
  private streams: Unsubscribe[] = [];
  private unsubscribeAuth: Unsubscribe | null = null;
  private identityGeneration = 0;
  private readGeneration = 0;
  private connected = false;
  private connectionGeneration = 0;
  private demoIntent = false;
  private demoSessionOnly = false;
  private demoData = emptyDemo();
  private pending = 0;
  private authenticationAttempt = 0;
  private localQueue: Promise<unknown> = Promise.resolve();
  private summaryTimer: ReturnType<typeof setTimeout> | null = null;
  private summaryRequest = 0;
  private dataFaults = new Set<string>();
  private failedStreams = new Set<string>();
  private pendingSnapshots = new Map<string, boolean>();

  getSnapshot = (): SpendSmartState => this.state;
  subscribe = (callback: () => void): (() => void) => { this.subscribers.add(callback); return () => this.subscribers.delete(callback); };
  private online() { return typeof navigator === 'undefined' || navigator.onLine; }
  private sync() {
    const syncStatus: SyncStatus = this.state.mode === 'demo' ? (this.demoSessionOnly ? 'session-only' : 'synced')
      : this.state.mode !== 'cloud' ? (this.state.error ? 'error' : 'synced')
      : !this.online() ? 'offline' : this.pending > 0 || [...this.pendingSnapshots.values()].some(Boolean) ? 'pending'
      : this.dataFaults.size > 0 ? 'error' : 'synced';
    if (syncStatus !== this.state.syncStatus) this.patch({ syncStatus });
  }
  private patch(values: Partial<SpendSmartState>) { this.state = { ...this.state, ...values }; this.subscribers.forEach((callback) => callback()); }
  private stopStreams() {
    this.readGeneration++; this.streams.forEach((unsubscribe) => unsubscribe()); this.streams = []; this.pendingSnapshots.clear(); this.failedStreams.clear();
    if (this.summaryTimer) clearTimeout(this.summaryTimer); this.summaryTimer = null; this.summaryRequest++;
  }
  private clearRecords() { this.patch({ transactions: [], budgets: [], planning: [], plannedExpenses: [], goals: [],
    analysisTransactions: [], analysisLimited: false, imports: [], categoryRules: [], ledgerBalancePaise: null, monthTrend: null, summaryUpdatedAt: null }); }
  private sessionActive() { try { return localStorage.getItem(DEMO_SESSION_KEY) === 'active'; } catch { return false; } }

  connect = () => {
    if (this.connected) return;
    this.connected = true;
    const connection = ++this.connectionGeneration;
    window.addEventListener('storage', this.onStorage); window.addEventListener('online', this.onNetwork);
    window.addEventListener('offline', this.onNetwork); window.addEventListener('focus', this.onFocus);
    if (!auth || !database) { if (this.sessionActive()) this.startDemo(); else this.patch({ ready: true }); return; }
    this.unsubscribeAuth = onIdTokenChanged(auth, (firebaseUser) => {
      if (!this.connected || connection !== this.connectionGeneration) return;
      if (firebaseUser && !this.demoIntent) {
        const user = { uid: firebaseUser.uid, email: firebaseUser.email ?? '', displayName: firebaseUser.displayName || firebaseUser.email?.split('@')[0] || 'Student' };
        if (this.state.mode === 'cloud' && this.state.user?.uid === user.uid) { this.patch({ user }); if (!this.streams.length || this.failedStreams.size) this.subscribeCloud(); else this.scheduleSummary(); return; }
        this.identityGeneration++; this.pending = 0; this.dataFaults.clear(); this.stopStreams(); this.clearRecords();
        this.patch({ mode: 'cloud', user, ready: false, error: null });
        try { localStorage.removeItem(DEMO_SESSION_KEY); } catch { /* Cloud identity does not rely on demo storage. */ }
        this.subscribeCloud();
      } else if (firebaseUser && this.demoIntent && auth) {
        void signOut(auth).catch((cause) => { if (this.state.mode === 'demo') this.patch({ error: friendlyError(cause) }); });
      } else if (!firebaseUser) {
        if (this.demoIntent || this.sessionActive()) this.activateDemo();
        else { this.identityGeneration++; this.pending = 0; this.dataFaults.clear(); this.stopStreams(); this.clearRecords();
          this.patch({ mode: 'signed-out', user: null, ready: true, error: null }); this.sync(); }
      }
    }, (cause) => {
      if (!this.connected || connection !== this.connectionGeneration) return;
      this.identityGeneration++; this.stopStreams(); this.clearRecords();
      this.patch({ mode: 'signed-out', user: null, ready: true, error: friendlyError(cause) }); this.sync();
    });
  };
  disconnect = () => {
    this.connected = false; this.connectionGeneration++; this.identityGeneration++; this.pending = 0; this.unsubscribeAuth?.(); this.unsubscribeAuth = null; this.stopStreams();
    window.removeEventListener('storage', this.onStorage); window.removeEventListener('online', this.onNetwork);
    window.removeEventListener('offline', this.onNetwork); window.removeEventListener('focus', this.onFocus);
  };
  private onNetwork = () => { if (this.state.mode !== 'cloud') return; if (!this.online()) this.patch({ ledgerBalancePaise: null, monthTrend: null }); else void this.refreshCloud(); this.sync(); };
  private onFocus = () => { if (this.state.mode === 'cloud' && this.online()) this.scheduleSummary(); };
  private onStorage = (event: StorageEvent) => {
    if (this.state.mode !== 'demo' || this.demoSessionOnly) return;
    if (event.key === DEMO_DATA_KEY && event.newValue !== null) { const recovered = recoverDemoData(event.newValue); this.presentDemo(recovered); this.patch({ error: recovered.warning }); }
    if (event.key === null || (event.key === DEMO_SESSION_KEY && event.newValue !== 'active')) {
      this.demoIntent = false; this.identityGeneration++; this.clearRecords(); this.patch({ mode: 'signed-out', user: null, ready: true, error: null }); this.sync();
    }
  };
  private presentDemo(data: DemoData) {
    this.demoData = data;
    this.patch({ transactions: sortTransactions(data.transactions), budgets: [...data.budgets].sort((a, b) => b.monthKey.localeCompare(a.monthKey)),
      planning: data.planning, plannedExpenses: [...data.plannedExpenses].sort((a, b) => a.dueDate.localeCompare(b.dueDate)), goals: data.goals,
      analysisTransactions: sortTransactions(data.transactions), analysisLimited: false,
      imports: [...data.imports].sort((a, b) => b.createdAt - a.createdAt), categoryRules: [...data.categoryRules].sort((a, b) => b.createdAt - a.createdAt),
      ledgerBalancePaise: null, monthTrend: getMonthlyTrend(data.transactions, todayISO()), summaryUpdatedAt: Date.now() }); this.sync();
  }
  private readLatestDemo(): DemoData {
    if (this.demoSessionOnly) return this.demoData;
    const raw = localStorage.getItem(DEMO_DATA_KEY); if (raw === null) return createDemoData();
    const recovered = recoverDemoData(raw);
    if (recovered.warning) { this.patch({ error: recovered.warning }); try { localStorage.setItem('spendsmart.demo.recovery-backup.v1', raw); } catch { /* Recovery can continue if backup storage is full. */ } }
    return recovered;
  }
  private activateDemo() {
    this.demoIntent = true; this.identityGeneration++; this.pending = 0; this.dataFaults.clear(); this.stopStreams(); this.clearRecords();
    this.patch({ mode: 'demo', user: demoUser, ready: true, error: null }); this.demoSessionOnly = false;
    let data: DemoData = createDemoData();
    try { data = this.readLatestDemo(); localStorage.setItem(DEMO_DATA_KEY, serializeDemoData(data)); localStorage.setItem(DEMO_SESSION_KEY, 'active'); }
    catch { this.demoSessionOnly = true; this.patch({ error: 'Browser storage is unavailable. Demo changes stay only in this tab until it closes or reloads.' }); }
    this.presentDemo(data);
  }
  startDemo = () => { this.activateDemo(); if (auth?.currentUser) void signOut(auth).catch((cause) => { if (this.state.mode === 'demo') this.patch({ error: friendlyError(cause) }); }); };
  private async mutateDemo(change: (data: DemoData) => DemoData) {
    const generation = this.identityGeneration;
    const action = async () => {
      if (generation !== this.identityGeneration || this.state.mode !== 'demo') throw new Error('The demo session changed. Try again.');
      let latest: DemoData; try { latest = this.readLatestDemo(); } catch { this.demoSessionOnly = true; latest = this.demoData; }
      const next = change(latest);
      if (!this.demoSessionOnly) { try { localStorage.setItem(DEMO_DATA_KEY, serializeDemoData(next)); }
        catch { this.demoSessionOnly = true; this.patch({ error: 'Browser storage is full or blocked. Changes stay only in this tab until it closes or reloads.' }); } }
      this.presentDemo(next);
    };
    if (!this.demoSessionOnly && navigator.locks) await navigator.locks.request('spendsmart-demo-data', action);
    else { if (!navigator.locks) this.demoSessionOnly = true; this.localQueue = this.localQueue.then(action, action); await this.localQueue; }
  }

  private subscribeCloud() {
    if (!database || this.state.mode !== 'cloud' || !this.state.user) return;
    this.stopStreams(); this.dataFaults.clear(); this.clearRecords(); this.patch({ ready: false, error: null });
    const db = database, uid = this.state.user.uid, generation = this.readGeneration;
    const range = monthRange(this.state.selectedMonth);
    const months = [...new Set([...getMonthlyTrend([], todayISO()).map((month) => month.monthKey), this.state.selectedMonth])];
    const loaded = new Set<string>(), upcoming = new Map<string, PlannedExpense[]>();
    const markReady = (key: string) => { loaded.add(key); if (loaded.size === 9) this.patch({ ready: true }); };
    const failure = (key: string, cause: unknown) => {
      if (generation !== this.readGeneration) return;
      this.dataFaults.add(key); this.patch({ ready: true, error: friendlyError(cause), ledgerBalancePaise: null, monthTrend: null }); this.sync();
    };
    const streamFailure = (key: string, cause: unknown) => { if (generation !== this.readGeneration) return; this.failedStreams.add(key); failure(key, cause); };
    const consume = <T,>(key: string, snapshot: QuerySnapshot, decode: (id: string, value: unknown) => T | null, display: (records: T[]) => void, cap?: number) => {
      if (generation !== this.readGeneration) return;
      this.pendingSnapshots.set(key, snapshot.metadata.hasPendingWrites);
      const overCap = cap !== undefined && snapshot.size > cap;
      if (overCap) failure(key, new Error(`This account exceeds the ${cap}-record ${key} limit. Remove older items before calculating guidance.`));
      const records = snapshot.docs.map((record) => decode(record.id, record.data({ serverTimestamps: 'estimate' })));
      if (records.some((record) => record === null)) failure(key, new Error(`Some ${key} records are invalid. Guidance is unavailable until the records are repaired.`)); else if (!overCap) this.dataFaults.delete(key);
      display(records.filter((record): record is T => record !== null)); markReady(key); this.sync();
    };
    const mergeUpcoming = (key: string, records: PlannedExpense[]) => {
      upcoming.set(key, records); const combined = new Map<string, PlannedExpense>();
      upcoming.forEach((list) => list.forEach((record) => combined.set(record.id, record)));
      if (combined.size > MAX_OPEN_PLANNED_EXPENSES) failure('planned expenses', new Error(`At most ${MAX_OPEN_PLANNED_EXPENSES} current planned expense records can be displayed. Remove older items.`));
      else this.dataFaults.delete('planned expenses');
      this.patch({ plannedExpenses: [...combined.values()].sort((a, b) => a.dueDate.localeCompare(b.dueDate)) });
    };
    this.streams = [
      onSnapshot(query(collection(db, 'users', uid, 'transactions'), where('date', '>=', range.start), where('date', '<=', range.end), orderBy('date', 'desc')), { includeMetadataChanges: true },
        (snapshot) => { if (generation !== this.readGeneration) return; this.patch({ ledgerBalancePaise: null, monthTrend: null }); consume('transactions', snapshot, readTransaction, (records) => this.patch({ transactions: sortTransactions(records) })); if (!snapshot.metadata.hasPendingWrites) this.scheduleSummary(); }, (cause) => streamFailure('transactions', cause)),
      onSnapshot(query(collection(db, 'users', uid, 'transactions'), orderBy('date', 'desc'), limit(MAX_ANALYSIS_TRANSACTIONS + 1)), { includeMetadataChanges: true },
        (snapshot) => {
          if (generation !== this.readGeneration) return;
          this.pendingSnapshots.set('analysis transactions', snapshot.metadata.hasPendingWrites);
          const decoded = snapshot.docs.slice(0, MAX_ANALYSIS_TRANSACTIONS).map((record) => readTransaction(record.id, record.data({ serverTimestamps: 'estimate' })));
          if (decoded.some((record) => record === null)) failure('analysis transactions', new Error('Some historical transactions are invalid. Annual analysis is unavailable until they are repaired.'));
          else this.dataFaults.delete('analysis transactions');
          this.patch({ analysisTransactions: sortTransactions(decoded.filter((record): record is Transaction => record !== null)),
            analysisLimited: snapshot.size > MAX_ANALYSIS_TRANSACTIONS });
          markReady('analysis transactions'); this.sync();
        }, (cause) => streamFailure('analysis transactions', cause)),
      onSnapshot(query(collection(db, 'users', uid, 'budgets'), where('monthKey', 'in', months)), { includeMetadataChanges: true },
        (snapshot) => consume('budgets', snapshot, readBudget, (records) => this.patch({ budgets: records })), (cause) => streamFailure('budgets', cause)),
      onSnapshot(query(collection(db, 'users', uid, 'planning'), where('monthKey', 'in', months)), { includeMetadataChanges: true },
        (snapshot) => consume('planning', snapshot, readStudentPlan, (records) => this.patch({ planning: records })), (cause) => streamFailure('planning', cause)),
      onSnapshot(query(collection(db, 'users', uid, 'plannedExpenses'), where('status', '==', 'planned'), orderBy('dueDate', 'asc'), limit(MAX_OPEN_PLANNED_EXPENSES + 1)), { includeMetadataChanges: true },
        (snapshot) => consume('open planned expenses', snapshot, readPlannedExpense, (records) => mergeUpcoming('open', records), MAX_OPEN_PLANNED_EXPENSES), (cause) => streamFailure('open planned expenses', cause)),
      onSnapshot(query(collection(db, 'users', uid, 'plannedExpenses'), where('dueDate', '>=', range.start), where('dueDate', '<=', range.end), orderBy('dueDate', 'asc'), limit(MAX_OPEN_PLANNED_EXPENSES + 1)), { includeMetadataChanges: true },
        (snapshot) => consume('month planned expenses', snapshot, readPlannedExpense, (records) => mergeUpcoming('month', records), MAX_OPEN_PLANNED_EXPENSES), (cause) => streamFailure('month planned expenses', cause)),
      onSnapshot(query(collection(db, 'users', uid, 'goals'), orderBy('createdAt', 'desc'), limit(MAX_GOALS + 1)), { includeMetadataChanges: true },
        (snapshot) => consume('goals', snapshot, readSavingsGoal, (records) => this.patch({ goals: records }), MAX_GOALS), (cause) => streamFailure('goals', cause)),
      onSnapshot(query(collection(db, 'users', uid, 'imports'), orderBy('createdAt', 'desc'), limit(MAX_IMPORT_HISTORY)), { includeMetadataChanges: true },
        (snapshot) => consume('imports', snapshot, readImportRecord, (records) => this.patch({ imports: records }), MAX_IMPORT_HISTORY), (cause) => streamFailure('imports', cause)),
      onSnapshot(query(collection(db, 'users', uid, 'categoryRules'), orderBy('createdAt', 'desc'), limit(MAX_CATEGORY_RULES + 1)), { includeMetadataChanges: true },
        (snapshot) => consume('category rules', snapshot, readCategoryRule, (records) => this.patch({ categoryRules: records }), MAX_CATEGORY_RULES), (cause) => streamFailure('category rules', cause)),
    ]; this.scheduleSummary();
  }
  private scheduleSummary() {
    if (this.state.mode !== 'cloud' || !this.state.user || !database || !this.online()) return;
    if (this.summaryTimer) clearTimeout(this.summaryTimer);
    this.summaryTimer = setTimeout(() => { this.summaryTimer = null; void this.refreshCloud(false); }, 350);
  }
  refreshCloud = async (restartFailed = true) => {
    if (!database || this.state.mode !== 'cloud' || !this.state.user) return;
    if (restartFailed && this.failedStreams.size) { this.subscribeCloud(); return; }
    const generation = this.identityGeneration, uid = this.state.user.uid, request = ++this.summaryRequest;
    try {
      await auth?.currentUser?.getIdToken();
      if (generation !== this.identityGeneration || this.state.user?.uid !== uid) return;
      const result = await loadCloudSummaries(database, uid);
      if (generation !== this.identityGeneration || request !== this.summaryRequest || this.state.mode !== 'cloud') return;
      this.dataFaults.delete('summaries');
      if (!this.pending) this.dataFaults.delete('write');
      if (!this.dataFaults.size && !this.pending && ![...this.pendingSnapshots.values()].some(Boolean)) this.patch({ ledgerBalancePaise: result.balance, monthTrend: result.trend, summaryUpdatedAt: Date.now() }); this.sync();
    } catch (cause) { if (generation !== this.identityGeneration || request !== this.summaryRequest) return;
      this.dataFaults.add('summaries'); this.patch({ ledgerBalancePaise: null, monthTrend: null, error: friendlyError(cause) }); this.sync();
      await this.handleSessionFailure(cause, generation); }
  };
  private async handleSessionFailure(cause: unknown, generation: number) {
    if (!auth || generation !== this.identityGeneration) return;
    const codeOf = (error: unknown) => typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
    const invalid = (code: string) => ['auth/user-token-expired', 'auth/invalid-user-token', 'auth/invalid-refresh-token', 'auth/user-disabled', 'auth/user-not-found', 'unauthenticated'].includes(code);
    let expired = invalid(codeOf(cause));
    if (codeOf(cause) === 'permission-denied' && auth.currentUser) {
      try { await auth.currentUser.getIdToken(true); }
      catch (refreshError) { expired = invalid(codeOf(refreshError)); }
    }
    // Network errors do not invalidate a login. A rejected refresh token does.
    if (expired && generation === this.identityGeneration) {
      const uid = this.state.user?.uid;
      await signOut(auth).catch(() => {});
      if (this.state.mode === 'signed-out' && !this.state.user && !auth.currentUser && uid) {
        this.patch({ error: 'Your session expired or is no longer valid. Please sign in again.' });
        this.sync();
      }
    }
  }
  setSelectedMonth = (monthKey: string) => { monthLabel(monthKey); if (monthKey === this.state.selectedMonth) return; this.patch({ selectedMonth: monthKey }); if (this.state.mode === 'cloud') this.subscribeCloud(); };
  clearError = () => { this.patch({ error: null }); this.sync(); };
  private requireAuth() { if (!auth || !database) throw new Error('Cloud sign-in needs your Firebase project configuration. The local demo is available now.'); return auth; }
  private async authentication(action: () => Promise<void>) {
    const generation = this.identityGeneration, attempt = ++this.authenticationAttempt;
    this.patch({ error: null });
    try { await action(); }
    catch (cause) {
      const message = friendlyError(cause);
      if (generation === this.identityGeneration && attempt === this.authenticationAttempt) { this.patch({ error: message }); this.sync(); }
      throw new Error(message, { cause });
    }
  }
  signIn = (email: string, password: string) => this.authentication(async () => { this.demoIntent = false; await signInWithEmailAndPassword(this.requireAuth(), email.trim(), password); });
  signUp = (name: string, email: string, password: string) => this.authentication(async () => {
    const displayName = name.trim(); if (!displayName || displayName.length > 80) throw new Error('Enter a name between 1 and 80 characters.'); this.demoIntent = false;
    const result = await createUserWithEmailAndPassword(this.requireAuth(), email.trim(), password); await updateProfile(result.user, { displayName });
    if (this.state.user?.uid === result.user.uid) this.patch({ user: { ...this.state.user, displayName } });
  });
  resetPassword = (email: string) => this.authentication(async () => { await sendPasswordResetEmail(this.requireAuth(), email.trim()); });
  signOut = () => this.authentication(async () => {
    this.demoIntent = false;
    if (this.state.mode === 'demo') { try { localStorage.removeItem(DEMO_SESSION_KEY); } catch { /* Always allow leaving a storage-blocked demo. */ }
      this.identityGeneration++; this.stopStreams(); this.clearRecords(); this.patch({ mode: 'signed-out', user: null, ready: true, error: null }); this.sync(); }
    else if (auth) await signOut(auth);
  });

  private async cloudWrite<T>(cloudAction: (writer: CloudWriter) => Promise<T>): Promise<T> {
    const generation = this.identityGeneration; this.patch({ error: null });
    if (!database || !auth || this.state.mode !== 'cloud' || !this.state.user || auth.currentUser?.uid !== this.state.user.uid) throw new Error('Please sign in before changing cloud records.');
    if (!this.online()) { const message = 'You are offline. Reconnect before saving; no cloud save was started.'; this.patch({ error: message }); this.sync(); throw new Error(message); }
    const writer = new CloudWriter(database, this.state.user.uid); this.pending++;
    this.patch({ ledgerBalancePaise: null, monthTrend: null }); this.sync();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const operation = auth.currentUser.getIdToken().then(() => {
      if (generation !== this.identityGeneration || this.state.mode !== 'cloud') throw new Error('Your session changed. Please sign in again.');
      return cloudAction(writer);
    }).then((result) => { if (generation === this.identityGeneration) { this.dataFaults.delete('write'); this.scheduleSummary(); } return result; })
      .catch(async (cause: unknown) => {
        if (generation === this.identityGeneration) { this.dataFaults.add('write'); this.patch({ error: friendlyError(cause) });
          await this.handleSessionFailure(cause, generation); }
        throw cause;
      }).finally(() => { if (generation === this.identityGeneration) { this.pending = Math.max(0, this.pending - 1); this.sync(); } });
    try { return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Cloud save is not confirmed yet. The operation may still finish. Reconnect and refresh before retrying; transaction retries keep the same operation ID.')), 12000);
    })]); }
    catch (cause) { if (generation === this.identityGeneration) { this.patch({ error: friendlyError(cause) }); this.sync(); } throw new Error(friendlyError(cause), { cause }); }
    finally { if (timer) clearTimeout(timer); }
  }
  private async change(demoAction: (data: DemoData) => DemoData, cloudAction: (writer: CloudWriter) => Promise<void>) {
    const generation = this.identityGeneration; this.patch({ error: null });
    if (this.state.mode === 'demo') { try { await this.mutateDemo(demoAction); }
      catch (cause) { if (generation === this.identityGeneration) this.patch({ error: friendlyError(cause) }); throw new Error(friendlyError(cause), { cause }); } return; }
    await this.cloudWrite(cloudAction);
  }
  addTransaction = (input: TransactionInput, operationId: string = crypto.randomUUID()) => {
    const normalized = { ...input, note: input.note.trim() }; validateTransaction(normalized);
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(operationId)) return Promise.reject(new Error('The operation ID is invalid.'));
    return this.change((data) => {
      const existing = data.transactions.find((record) => record.id === operationId);
      if (existing) { if (existing.type === normalized.type && existing.amountPaise === normalized.amountPaise && existing.category === normalized.category && existing.date === normalized.date && existing.note === normalized.note) return data; throw new Error('This operation ID already belongs to another transaction.'); }
      return { ...data, transactions: [...data.transactions, { ...normalized, id: operationId, createdAt: Date.now() }] };
    }, (writer) => writer.addTransaction(normalized, operationId));
  };
  updateTransaction = (id: string, input: TransactionInput) => {
    validateTransaction(input); if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) return Promise.reject(new Error('This transaction ID is invalid.'));
    return this.change((data) => {
      const current = data.transactions.find((record) => record.id === id); if (!current) throw new Error('This transaction no longer exists.');
      const linked = data.plannedExpenses.filter((item) => item.transactionId === id);
      if (linked.length && input.type !== 'expense') throw new Error('A linked bill payment must remain an expense. Delete it to reopen the planned bill.');
      return { ...data, transactions: data.transactions.map((record) => record.id === id ? { ...current, ...input, note: input.note.trim() } : record),
        plannedExpenses: data.plannedExpenses.map((item) => item.transactionId === id ? { ...item, amountPaise: input.amountPaise, category: input.category } : item) };
    }, (writer) => writer.updateTransaction(id, { ...input, note: input.note.trim() }));
  };
  deleteTransaction = (id: string) => this.change((data) => {
    const plannedExpenses = data.plannedExpenses.map((item) => { if (item.transactionId !== id) return item;
      const { transactionId: discarded, ...rest } = item; void discarded; return { ...rest, status: 'planned' as const }; });
    return { ...data, transactions: data.transactions.filter((record) => record.id !== id), plannedExpenses };
  }, (writer) => writer.deleteTransaction(id));
  saveBudget = (budget: Budget) => { validateBudget(budget); return this.change((data) => ({ ...data, budgets: [...data.budgets.filter((record) => record.monthKey !== budget.monthKey), budget] }), (writer) => writer.saveBudget(budget)); };
  savePlan = (plan: StudentPlan) => { validateStudentPlan(plan); return this.change((data) => ({ ...data, planning: [...data.planning.filter((record) => record.monthKey !== plan.monthKey), plan] }), (writer) => writer.savePlan(plan)); };
  savePlannedExpense = (item: PlannedExpense) => {
    validatePlannedExpense(item);
    return this.change((data) => {
      const previous = data.plannedExpenses.find((record) => record.id === item.id);
      if (!previous && item.status === 'paid') throw new Error('Create a planned bill first, then record its payment.');
      if (previous?.status === 'paid' && (item.status !== 'paid' || item.transactionId !== previous.transactionId || item.amountPaise !== previous.amountPaise || item.category !== previous.category)) throw new Error('Change a paid bill through its ledger payment.');
      if (previous?.status === 'planned' && item.status === 'paid') throw new Error('Use Record payment to mark this bill paid.');
      if (!previous && data.plannedExpenses.filter((record) => record.status === 'planned').length >= MAX_OPEN_PLANNED_EXPENSES) throw new Error(`Keep at most ${MAX_OPEN_PLANNED_EXPENSES} open planned expenses.`);
      return { ...data, plannedExpenses: [...data.plannedExpenses.filter((record) => record.id !== item.id), { ...item, title: item.title.trim(), createdAt: previous?.createdAt ?? item.createdAt }] };
    }, (writer) => writer.savePlannedExpense(item));
  };
  deletePlannedExpense = (id: string) => this.change((data) => ({ ...data, plannedExpenses: data.plannedExpenses.filter((item) => item.id !== id) }), (writer) => writer.deletePlannedExpense(id));
  recordPlannedExpense = (id: string, date: string) => {
    if (!validRecordId(id)) return Promise.reject(new Error('The planned expense ID is invalid.'));
    validateTransaction({ type: 'expense', amountPaise: 1, category: 'Other', date, note: '' });
    return this.change((data) => {
      const item = data.plannedExpenses.find((record) => record.id === id); if (!item) throw new Error('This planned expense no longer exists.'); if (item.status === 'paid') return data;
      const paymentId = `plan_${id}`; if (data.transactions.some((record) => record.id === paymentId)) throw new Error('The planned payment ID already exists. Refresh first.');
      return { ...data, transactions: [...data.transactions, { id: paymentId, type: 'expense', amountPaise: item.amountPaise, category: item.category, date, note: item.title, createdAt: Date.now() }],
        plannedExpenses: data.plannedExpenses.map((record) => record.id === id ? { ...record, status: 'paid', transactionId: paymentId } : record) };
    }, (writer) => writer.recordPlannedExpense(id, date));
  };
  saveGoal = (goal: SavingsGoal) => {
    validateSavingsGoal(goal); return this.change((data) => { const existing = data.goals.find((record) => record.id === goal.id);
      if (!existing && data.goals.length >= MAX_GOALS) throw new Error(`Keep at most ${MAX_GOALS} savings goals.`);
      return { ...data, goals: [...data.goals.filter((record) => record.id !== goal.id), { ...goal, title: goal.title.trim(), createdAt: existing?.createdAt ?? goal.createdAt }] };
    }, (writer) => writer.saveGoal(goal));
  };
  deleteGoal = (id: string) => this.change((data) => ({ ...data, goals: data.goals.filter((goal) => goal.id !== id) }), (writer) => writer.deleteGoal(id));
  importTransactions = (record: ImportRecord, records: PreparedImportTransaction[]) => {
    validateImportRecord(record);
    if (records.length !== record.importedCount) return Promise.reject(new Error('The import reconciliation count does not match the selected rows.'));
    records.forEach((entry) => validateTransaction(entry.input));
    return this.change((data) => {
      const history = data.imports.find((item) => item.id === record.id);
      if (history?.status === 'completed') return data;
      if (history && (history.status === 'rolled_back' || history.status === 'partial_rollback')) throw new Error('Start a new import session after a rollback.');
      const transactions = [...data.transactions];
      records.forEach((entry) => {
        const existing = transactions.find((transaction) => transaction.id === entry.id);
        if (existing) {
          if (existing.importId === record.id && existing.importOriginalHash === entry.input.importOriginalHash) return;
          throw new Error('An import transaction ID already belongs to another record.');
        }
        transactions.push({ ...entry.input, id: entry.id, createdAt: Date.now() });
      });
      const completed: ImportRecord = { ...record, status: 'completed', importedCount: records.length, updatedAt: Date.now() };
      return { ...data, transactions, imports: [...data.imports.filter((item) => item.id !== record.id), completed] };
    }, (writer) => writer.importTransactions(record, records));
  };
  rollbackImport = async (importId: string): Promise<ImportRollbackResult> => {
    if (!validRecordId(importId)) throw new Error('The import ID is invalid.');
    if (this.state.mode === 'demo') {
      const result: ImportRollbackResult = { deletedCount: 0, conflictCount: 0 };
      await this.mutateDemo((data) => {
        const linked = new Set(data.plannedExpenses.flatMap((item) => item.transactionId ? [item.transactionId] : []));
        const removable = new Set<string>();
        data.transactions.filter((transaction) => transaction.importId === importId).forEach((transaction) => {
          const { id: discardedId, createdAt: discardedCreatedAt, ...input } = transaction;
          void discardedId; void discardedCreatedAt;
          if (linked.has(transaction.id) || !transaction.importOriginalHash || transactionCoreHash(input) !== transaction.importOriginalHash) {
            result.conflictCount += 1;
          } else removable.add(transaction.id);
        });
        result.deletedCount = removable.size;
        const imports = data.imports.map((record) => record.id === importId
          ? { ...record, status: result.conflictCount ? 'partial_rollback' as const : 'rolled_back' as const, updatedAt: Date.now() } : record);
        return { ...data, transactions: data.transactions.filter((transaction) => !removable.has(transaction.id)), imports };
      });
      return result;
    }
    return this.cloudWrite((writer) => writer.rollbackImport(importId));
  };
  saveCategoryRule = (rule: CategoryRule) => {
    validateCategoryRule(rule);
    return this.change((data) => {
      const existing = data.categoryRules.find((item) => item.id === rule.id);
      if (!existing && data.categoryRules.length >= MAX_CATEGORY_RULES) throw new Error(`Keep at most ${MAX_CATEGORY_RULES} reusable categorization rules.`);
      return { ...data, categoryRules: [...data.categoryRules.filter((item) => item.id !== rule.id), { ...rule, createdAt: existing?.createdAt ?? rule.createdAt }] };
    }, (writer) => writer.saveCategoryRule(rule));
  };
  deleteCategoryRule = (id: string) => this.change((data) => ({ ...data, categoryRules: data.categoryRules.filter((rule) => rule.id !== id) }), (writer) => writer.deleteCategoryRule(id));
  resetDemo = async () => {
    if (this.state.mode !== 'demo') throw new Error('Reset demo is available only in local demo mode.');
    await this.mutateDemo(() => createDemoData()); try { localStorage.removeItem('spendsmart.demo.recovery-backup.v1'); } catch { /* Reset also works in a session-only demo. */ } this.patch({ error: null });
  };
}
