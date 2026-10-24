# SpendSmart implementation plan

Source: ../SpendSmart_AXION.pdf (six pages, read on 2026-10-24).

## Requirements

- React + Vite mobile-first app with Firebase Authentication and UID-scoped Firestore.
- Fast income/expense capture, date and category filters, edit and delete.
- Monthly and category budgets with integer-paise amounts.
- Deterministic budget engine: usage, month-end run-rate, safe daily allowance.
- Explainable alerts at >=80% usage, >100% exceeded, projected >100% pace risk.
- Handle unset/zero budgets, month boundaries, refunds and future dates explicitly.
- Recharts for category mix, spending pace and historical month totals.
- Local demo mode works without accounts or paid services; cloud mode uses the user's Firebase project.

## Decisions

- Follow the PDF's React/Vite/Firebase stack rather than the earlier provisional Next.js proposal.
- One INR ledger; all monetary values are positive safe integer paise.
- Refunds return cash and reduce expense in their recorded month/category; they are not income.
- Run-rate includes today; daily guidance spreads the remaining budget over days after today, and on the last day uses the remaining amount for today.
- Historical months use actual full-month spend and no actionable daily guidance.
- User-entered future transactions are rejected; dates are local calendar dates in YYYY-MM-DD format.
- Local demo data is clearly labeled and stays on the device. No external accounts are created automatically.

## Delivery sequence

1. Verify this plan and create shared types and project configuration.
2. Domain specialist: implement budget calculations, validation, CSV and meaningful unit tests.
3. Data specialist: implement Firebase identity, Firestore adapter, demo persistence and access rules.
4. UI specialist: implement dashboard/report insights and responsive chart components.
5. Integrate shell, authentication screens, transaction forms and budgets.
6. Install dependencies; run TypeScript, unit tests and production build.
7. Verify real browser workflows and responsive rendering; document local/cloud setup and limitations.

## Completion checks

- PDF example: 560000 paise spent on day 20 of a 30-day month with an 800000-paise cap => forecast 840000, safe daily 24000, PACE_RISK.
- CRUD, refunds, filters, budget changes and persistence work in local demo.
- Firebase rules restrict both reads and writes to the UID owner and validate accepted fields.
- Build and tests pass; no Firebase credentials are required to launch the demo.
- Cloud deployment instructions distinguish completed local verification from account-dependent setup.
