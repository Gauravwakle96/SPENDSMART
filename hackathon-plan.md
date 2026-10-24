# SpendSmart hackathon implementation plan

Audit: see `hackathon-audit.md`. Existing stack and successful behavior are preserved.

## Order

1. Core correctness: additive financial intelligence module, persistence/rules reliability, fix baseline clock tests and circular chunks.
2. Design system: CSS tokens for navy, warm neutral surfaces, amber emphasis, green healthy and red breach; strengthen text contrast and simplify hierarchy.
3. Dashboard: affordable today, actual cash, budget remaining, run-rate/variance, rule-based health, category-specific allowance and explainable calculations.
4. Complete workflows: transaction range/sort/pagination, setup checklist, monthly budgets/history, planning and simulations.
5. Judge mode: deterministic resettable scenario and a short guided demonstration.
6. Quality gates: unit, integration/browser, Firebase auth/rules emulator, lint/typecheck/build, production and responsive smoke.
7. Delivery: tested local preview, README configuration/deployment, architecture and judge script. Distinguish production setup from verified local behavior.

## Planning semantics

- Expected income is a plan by source, not cash; only actual income increases balance.
- Planned expenses are separate records. Recording a payment atomically creates an actual expense and links it; deleting that payment reopens the plan.
- Savings reservations earmark recorded cash, not expenses. Display only the portion backed by actual balance as progress; never double-count the same cash across goals.
- Today's allowance uses days including today; the original PDF after-today allowance remains exposed in explanations for reproducibility.
- Selected category can tighten an allowance; category caps do not add to the overall cap.
- Simulations use copies of data and never write to the ledger.
- Unavailable cash aggregates or insufficient transaction history must remain explicitly unknown rather than appearing as healthy zero values.

## Delivery status

The local implementation stages are complete and verified. See `HANDOFF.md` for the executed test matrix, retained architecture, remaining limits and repeatable judge demonstration. Production assets are available through `npm run preview`; real Firebase/Vercel configuration and a verified public deployment remain external setup steps.
