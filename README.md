# SpendSmart

**Explainable personal financial intelligence for students and early earners**

Built from [the AXION specification](../SpendSmart_AXION.pdf), preserving the existing React + Vite + TypeScript + Firebase + Recharts architecture. The local demo needs no credentials or paid services.

## Run locally

Requirements: Node.js 22.12+ or 24 LTS, and npm.

```powershell
cd C:\path\to\SPENDSMART
npm ci
npm run dev
```

Open **http://127.0.0.1:5173** and choose **Try the free demo**.

To serve built assets locally:

```powershell
npm run build
npm run preview -- --port 4173 --strictPort
```

Open **http://127.0.0.1:4173**. This is a local production preview, not a cloud deployment.

## Implemented workflows

- **Overview:** actual cash, received income, expenses, remaining budget, utilization, estimated month-end spending, projected variance/cash, safe-to-spend today, category constraints and inspectable calculations.
- **Transactions:** create/edit/confirmed delete for income, expenses and refunds; dates and notes; search, type/category/date filters, date/amount sorting, 20-row pagination and filtered CSV.
- **Import & Analyze:** local-first CSV/XLSX upload, multiple files/accounts, automatic column detection with manual mapping, exact-paise normalization, preview editing, confidence labels, duplicate review, retry-safe confirmation, import history and conflict-aware rollback.
- **Budgets:** monthly and category limits, month selection, editing and recent history. Category caps restrict the overall budget; they never add money.
- **Plan ahead:** expected allowance, scholarship, salary and other income; configurable essential categories; upcoming bills with linked payments; cash-backed savings reservations and weekly funding targets.
- **Reports:** gross expenses, refunds, signed net expenses, category reconciliation, six-month trends, Indian financial years, calendar/custom/month periods, account and merchant summaries, CSV/PDF downloads and a simulation that changes no records.
- **Financial intelligence:** explainable categorization and movement classification, cautious recurring-payment patterns, minimum-history anomaly rules, deterministic summaries and editable historical budget recommendations.
- **Onboarding:** contextual budget, income and first-expense actions with optional dismissal.
- **How it works:** formulas, limitations and a resettable demonstration.

## Architecture and key files

```text
React: App + Transactions + Planning + lazy-loaded Insights / ImportAnalyze
                         |
       SpendSmartProvider / useSyncExternalStore
                         |
                  SpendSmartStore
                  /             \
      Demo adapter               Firebase Auth + CloudWriter
  localStorage / Web Locks                |
                                users/{authenticated uid}/...
                                Firestore ownership/schema rules
                         |
         Pure TypeScript engine + financial intelligence
                         |
           Dashboard, reports, alerts, simulations
```

Navigation is protected by authenticated application state. Firestore rules enforce authorization independently of the UI. There is no custom server or routing dependency.

`read-excel-file` handles browser-compatible XLSX extraction. `jspdf` and `jspdf-autotable` are dynamically loaded only when a PDF report is requested, so normal dashboard loading does not include the PDF generator.

| Area | Files |
| --- | --- |
| Shell, auth, onboarding, budgets | [src/App.tsx](src/App.tsx) |
| Transactions and student planning | [Transactions.tsx](src/components/Transactions.tsx), [Planning.tsx](src/components/Planning.tsx) |
| Dashboard and reports | [Insights.tsx](src/components/Insights.tsx), [FinancialYearReview.tsx](src/components/FinancialYearReview.tsx) |
| Statement import | [ImportAnalyze.tsx](src/components/ImportAnalyze.tsx), [statement-files.ts](src/data/statement-files.ts), [import-engine.ts](src/domain/import-engine.ts) |
| Financial logic | [engine.ts](src/domain/engine.ts), [intelligence.ts](src/domain/intelligence.ts), [financial-analysis.ts](src/domain/financial-analysis.ts), domain types/tests |
| Report downloads | [report-export.ts](src/data/report-export.ts) |
| Persistence | [store.ts](src/data/store.ts), [cloud.ts](src/data/cloud.ts), [demo.ts](src/data/demo.ts), [SpendSmartProvider.tsx](src/data/SpendSmartProvider.tsx) |
| Design | [tokens.css](src/tokens.css), [styles.css](src/styles.css), [workflows.css](src/workflows.css), [insights.css](src/components/insights.css) |
| Database boundary | [firestore.rules](firestore.rules), [firestore.indexes.json](firestore.indexes.json) |
| Tests | [tests/](tests), [scripts/test-firestore-rules.mjs](scripts/test-firestore-rules.mjs), domain/data tests |

## Financial rules

Money is INR integer **paise**. Text input is parsed exactly with at most two decimal places. Negative/zero transactions, fractional paise, unsupported types/currencies, invalid categories and impossible dates are rejected. Zero or blank budget limits explicitly mean **unset**, not a zero-spending mandate.

| Record | Actual cash | Budget spending |
| --- | --- | --- |
| Income | Adds received funds | No effect |
| Expense | Subtracts funds | Adds spending |
| Refund | Adds returned funds | Reduces spending in recorded month/category |
| Expected income | No effect | No effect |
| Unpaid planned bill | No effect until paid | Reserves headroom, not an actual expense |
| Savings reservation | Earmarks existing cash | No expense |
| Manually entered transfer | Unsupported transaction type | Rejected |
| Imported transfer/card payment/investment/loan movement/cash withdrawal | Excluded from combined cash totals unless reclassified | Excluded |
| Imported unknown debit/credit | Excluded until reviewed | Excluded |

Signed reports preserve excess refunds; budget spending is floored at zero. Categories are floored independently, with a visible reconciliation adjustment.

```text
Actual cash = all received income + refunds − expenses through today
Budget spending = max(0, monthly expenses − monthly refunds)
Remaining budget = configured positive budget − budget spending
Utilization = budget spending / budget × 100
Run-rate = round(budget spending / elapsed days × days in month)

D = days remaining INCLUDING today
U = unpaid bills due this month or overdue
G = savings reservations backed by actual cash
Budget headroom = max(0, remaining budget − U)
Cash headroom = max(0, actual cash − G − U)
Safe today = floor(min(budget headroom, cash headroom) / D)
```

Selecting a capped category adds its remaining cap minus unpaid category bills as another constraint. Missing overall budget or unknown cash yields unavailable guidance.

Elapsed days start at calendar day 1 and include today, even if logging began later. The estimate assumes a complete ledger and continuing pace. No expenses means an unavailable forecast; fewer than seven elapsed days or three expense records means an **early estimate**. Final-day guidance divides by one; closed/future months have no actionable daily allowance.

Totals use BigInt intermediates. Forecasts round half up to the nearest paise, daily allowances round down, and weekly savings needs round up. Oversized aggregates are flagged unavailable. Percentage rounding is presentation-only.

Dates use browser-local calendar strings (`YYYY-MM-DD`). No UTC conversion shifts transaction months. The app rejects future recorded transactions and uses upcoming plans instead. Firestore validates calendar dates but cannot enforce the browser's local today boundary; future records written outside the UI are excluded from totals through today. There is no configurable account timezone.

### Original PDF example

₹5,600 spent against ₹8,000 on April 20:

- Forecast: ₹5,600 ÷ 20 × 30 = **₹8,400**.
- PDF allowance after today: ₹2,400 ÷ 10 = **₹240**.
- Inclusive allowance today: ₹2,400 ÷ 11 = **₹218.18**, with sufficient cash and no reservations.

Both daily formulas are labeled in the dashboard explanation.

### Alerts and planning

Central thresholds in `BUDGET_POLICY`: near-limit at 80–100%, exceeded above 100%, pace risk when forecast exceeds the cap. Equality is not overspending. Overall breach takes precedence over an overall pace warning. Category warnings identify their category. Financial health uses transparent ordered rules, not a fabricated score or AI prediction.

A paid plan links to one actual expense. Creation, edits and deletion keep both sides consistent atomically; deleting the expense reopens the plan. A paid status remains meaningful when its payment is outside the loaded month. Removing a paid plan preserves its actual expense and clears the link.

Savings progress allocates recorded cash to requested reservations, oldest goal first. Unfunded amounts remain visible. Weekly amounts are arithmetic funding targets, not guarantees.

Expected remaining income is calculated per source after matching actual receipts. Cash projections add expected income and subtract the greater of remaining run-rate spending and unpaid commitments. Commitments are a spending floor, avoiding double-counting. Savings remain part of total cash but are unavailable for daily discretionary spending. Historical reports are not historical cash or savings snapshots.

## Bank statement import

Open **Import & Analyze** in either local demo or authenticated cloud mode.

1. Choose one or more `.csv` or `.xlsx` files, or load the clearly labeled fictional sample.
2. Give each account a short label. Reusing the same label groups statement files; it does not prove account ownership or match transfers.
3. Verify the detected columns. Required data is a date, description and either a signed amount or separate debit/credit columns.
4. Build the preview. Invalid rows remain visible, uncertain rows are marked for review, and exact duplicates are not selectable.
5. Correct type, category, classification and whether the row belongs in financial totals. Optionally save a reusable local/user-scoped categorization rule.
6. Confirm the selected rows. No transaction is persisted before confirmation.

Recognized header variations include transaction/value/posting date, narration/particulars/remarks/details, debit/withdrawal/DR, credit/deposit/CR, signed amount, balance, reference/UTR/transaction ID and optional account label. Dates support ISO, common Indian `DD/MM/YYYY` forms, named months and valid Excel serial dates. Amounts are parsed to integer paise without floating-point multiplication.

Limits are 12 files, 10 MB per file and 5,000 rows per import session. PDF statements are not accepted: browser PDF extraction is intentionally deferred rather than risking silent, incorrect transactions. Original CSV/XLSX bytes are hashed and parsed locally, then discarded; only confirmed normalized transactions, masked account labels, source fingerprints and import reconciliation metadata are stored.

Duplicate handling is deliberately conservative:

- A matching bank reference within the same labeled account, or the same source-file row, is an exact duplicate.
- Matching date, normalized description, amount, direction and account is only a **probable** duplicate. It requires inspection because two legitimate transactions can be identical.
- Overlapping statements without stable bank references therefore produce review flags, not automatic deletion.
- A repeated confirmation reuses deterministic operation IDs. A partial cloud write can be retried safely.
- Rollback deletes only unchanged transactions carrying that import ID. Edited or linked records are retained as conflicts.

Categorization first uses saved user rules, then conservative merchant/description and keyword rules. Suggestions map into SpendSmart's existing categories: Food, Travel, Shopping, Bills, Education, Health, Entertainment and Other. Salary, scholarship and allowance remain the supported income categories. An unmatched debit or credit is classified as unknown and excluded from totals until the user reviews it. No external AI key is required, and no statement or transaction is sent to an AI provider.

Financial Year Review supports Indian April–March years, calendar years, custom ranges and individual months. It reports recorded income, gross expenses, refunds, signed net expenses, net cash flow, observed-month averages, trends, categories, merchants, largest transactions, month changes, prior-period comparisons and labeled-account summaries. Coverage gaps and the 5,000-record cloud analysis cap are always disclosed. Recurring and unusual-spending indicators use minimum-data rules and explain their evidence; they are not subscription verification or fraud detection.

Budget recommendations use observed monthly category history only. They show median, average, recent average, variability, months used and the rounding/buffer assumption. Accepting a recommendation updates only the selected category limit for the current month; existing limits are never silently overwritten.

## Persistence and privacy

Cloud collections are `users/{uid}/transactions`, `budgets`, `planning`, `plannedExpenses`, `goals`, `imports` and `categoryRules`.

- Rules restrict reads/writes to the authenticated owner and validate fields, amounts, types, categories, dates, timestamps and paid-plan links.
- Server timestamps and stable transaction IDs prevent duplicate retries. Editing a deleted record fails rather than recreating it.
- The monthly workspace retains its selected-month stream. A separate owner-scoped history stream loads at most the latest 5,000 transactions for duplicate checks and annual analysis; the UI warns when this cap is reached. Server aggregates still compute all-time cash and six-month history.
- Planning reads allow at most 200 current planned-expense records and 50 goals. These are application limits, not security quotas. Over-limit snapshots stop trusted guidance.
- Failed/missing aggregates remain unknown. Failed subscriptions can be retried. Offline cloud writes are rejected before submission. A timed-out save may still complete; the UI labels it unconfirmed, and transaction retry retains its operation ID.
- Auth changes clear old-user records and invalidate stale asynchronous results. Token refresh is checked before cloud refreshes/writes; invalid sessions clear the private workspace. Network failures do not automatically invalidate a login.
- Demo data uses a separate local ledger, never a shared cloud account. Confirmed reset affects only that browser. Older demo schemas migrate without reseeding. Web Locks serialize tabs; blocked/full storage or unavailable locking produces explicit **session-only** mode.
- Local demo storage is unencrypted and unsuitable for private data on shared devices. No bank credentials are requested.
- CSV quotes/line breaks are escaped and spreadsheet formula prefixes neutralized. Period CSV, import reconciliation CSV and locally generated multi-page PDF summaries contain only accessible user records and calculated aggregates.

## Firebase configuration

No production project or deployment is configured. Demo mode works with blank environment values.

1. Create/select a Firebase project. Enable **Email/Password** in Authentication.
2. Register a web app and create Cloud Firestore in production mode.
3. Copy the example:

   ```powershell
   Copy-Item .env.example .env.local
   ```

4. Fill the Firebase web configuration:

   ```dotenv
   VITE_FIREBASE_API_KEY=your-web-api-key
   VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
   VITE_FIREBASE_PROJECT_ID=your-project-id
   VITE_FIREBASE_STORAGE_BUCKET=your-storage-bucket
   VITE_FIREBASE_MESSAGING_SENDER_ID=your-sender-id
   VITE_FIREBASE_APP_ID=your-web-app-id
   VITE_USE_FIREBASE_EMULATORS=false
   ```

   API key, auth domain, project ID and app ID enable cloud mode; copy the complete web configuration. These client identifiers are public. Never put service-account credentials in `VITE_*` variables. Real local environment files are ignored.
5. Deploy rules and indexes to your project:

   ```powershell
   npx firebase-tools login
   npx firebase-tools deploy --only firestore:rules,firestore:indexes --project YOUR_PROJECT_ID
   ```

6. Add local/deployed hostnames under Authentication → Settings → Authorized domains. Verify the password-reset action URL. Wait for indexes to finish building.
7. Restart Vite and verify independent ledgers using two test accounts.

Google sign-in is not offered without configured support. No service account or Cloud Function is required.

No Azure/OpenAI resource, API key or item ID is used by this project. Financial summaries are deterministic. Any future optional AI provider must receive aggregate statistics only, never original files, full account numbers or unnecessary transaction details.

## Verification

```powershell
npm run typecheck
npm run lint
npm test
npx playwright install chromium
npm run test:e2e
npm run build
npm run test:preview
```

The preview suite tests built `dist` assets on port 4173. Dev tests use port 5173.

Emulator checks need **Java 21+** on PATH and free ports 8080/9099. They clear only the isolated `demo-spendsmart` emulator. Run sequentially:

```powershell
java -version
npm run test:rules
npm run test:cloud
npm run test:auth
```

Auth browser tests use their own dev server on port 5175. The emulator flag is development-only. Normal unit runs deliberately skip cloud tests; `test:cloud` executes them with local Firebase SDK/emulator behavior.

Executed results and the judge script are in [HANDOFF.md](HANDOFF.md).

## Known limitations

- Text or scanned PDF bank statements are not parsed.
- Automatic mapping cannot resolve every proprietary bank layout; ambiguous fields require manual mapping.
- Signed-amount-only statements must use negative debits and positive credits. Otherwise map separate debit/credit columns or correct the preview.
- Probable duplicate detection cannot prove two matching transactions are the same. Stable bank references and repeated source-file rows are the only exact signals.
- Merchant labels are conservative normalized descriptions, not enriched or externally verified business identities.
- Confirmed recurring patterns and dismissed insights are review-session state. They are not converted into planned expenses automatically.
- Cloud annual analysis covers the latest 5,000 accessible transactions. Imports are limited to 5,000 rows per session.
- The app has no bank synchronization, balance reconciliation, tax calculation, professional financial advice or fraud determination.
- Firestore rule changes must be deployed before cloud imports are used. Existing Vercel configuration needs no structural change.

## Deploy to Vercel

```powershell
cd C:\path\to\SPENDSMART
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npx vercel login
npx vercel link
```

Select Vite, Node 22.12+ or 24, build `npm run build`, output `dist`; `vercel.json` also defines these settings.

For cloud mode, add the six Firebase web configuration values in Vercel for the intended environment. Keep the emulator flag false. Deploy Firestore rules/indexes first.

```powershell
npx vercel --prod
```

Authorize the deployed hostname in Firebase, then verify HTTPS registration/login, password recovery, CRUD, reload persistence and two-account isolation. Local tests do not verify external settings. For demo-only hosting, omit Firebase configuration.

Alternatively, import [the SpendSmart GitHub repository](https://github.com/Gauravwakle96/SPENDSMART) through Vercel. GitHub publication and application hosting are separate steps.

Local use has no service charges. Firebase/Vercel free-tier eligibility and quotas depend on provider terms; higher usage or a custom domain may cost money.
