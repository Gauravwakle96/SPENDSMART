# Hackathon readiness audit — 24 October 2026

Audited the existing React/Vite/TypeScript/Firebase/Recharts codebase, configuration, financial engine, provider, rule tests and browser tests. This directory is not currently a Git repository. The original PDF and existing implementation are retained.

## Executed baseline

- `npm test`: 49/49 passed (36 engine, 13 demo recovery).
- `npm run build`: passed; Firebase manual chunks produced circular dependency warnings requiring correction.
- Firestore emulator: existing 11 rule groups passed in real local emulator, including cross-user denial. This does not verify production Firebase configuration.
- Existing Playwright suite: 4 failures/timeouts. A fresh live Chromium run without the clock override successfully opened the app, created a transaction, showed no JavaScript exceptions, and had no horizontal overflow at 390px. The clock override is implicated; fix the harness without weakening behavioral checks.
- Inspected desktop and mobile screenshots from the live app in `test-results/audit-*.png`.
- Production dependency audit started; result pending at audit time.

## Retain

Exact paise parsing, calendar validation, refund semantics, reproducible PDF forecast, CRUD, local demo persistence, auth adapter, owner-only rules, CSV quoting, accessible native dialog and responsive navigation.

## Priorities

1. Correctness: separate cash balance, budget headroom and affordable daily guidance; add forecast readiness, centralized thresholds, category constraints and noncontradictory primary status. Preserve the PDF after-today formula, while labeling today's inclusive allowance separately.
2. Integrity: stable submission IDs, deleted-record edit failures, generation-scoped async errors, useful offline/sync status, server timestamps and selected-month cloud queries with independent balance/history aggregates.
3. Validation: explicit INR-only validation, safe overflow handling, exact editing, signed refund reconciliation.
4. Design: navy/neutral/amber reusable tokens; compact decision-first dashboard; two primary alerts with expandable category details; mobile-safe tables and planning forms.
5. Workflows: date range, amount/date sort and pagination; onboarding; budget history; allowance planning, essential spending classification, upcoming obligations, savings allocations and read-only simulations.
6. Demo: a resettable, clearly labeled deterministic scenario proving input-to-forecast updates, isolated from cloud data.
7. Verification: meaningful new unit/browser/auth-emulator/rules tests, lint/typecheck/build, production browser smoke and desktop/mobile visual inspection.

## Production limitation

No user Firebase project configuration or deployment credentials exist in the repository. Local/demo and emulator behavior can be verified; production authentication, domain authorization and deployment require the user's project setup.
