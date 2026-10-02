# Testing

CI runs JavaScript syntax checks, the test suite below, and a Playwright browser smoke.

## Suites

| Command | What it covers |
| --- | --- |
| `tests/domain-smoke-runner.mjs` | Minimal engine bootstrap |
| `tests/runtime.test.mjs` | Real behaviour: balances/transfers/FX/adjustments/snapshots/goals, the IndexedDB adapter (save/load/clear/legacy migration), and the event bus |
| `tests/bank-core.test.mjs` | Provider normalization, minor-unit conversion, reconciliation |
| `tests/provider-contract.test.mjs` | The Mono adapter exposes every required capability |
| `tests/schema-contract.test.mjs` | Edge functions only write columns that migrations actually create |
| `tests/migration-fixtures.test.mjs` | State migration system is present |
| `tests/bank-pipeline.test.mjs` | Amount-unit handling and sync contract |
| `tests/static-smoke.mjs` | Asset presence, script load order, config sourcing, service-worker cache coverage |
| `tests/playwright.smoke.mjs` | Real browser: every module evaluates, IndexedDB round-trips, engine runs, no page errors |

Run `npm test` for the Node suites and `npm run test:e2e` for the browser suite.

## Fixtures

Fixtures cover a bank snapshot, credits/debits, a pending transaction and a webhook envelope.

## Notes

`schema-contract.test.mjs` exists because a whole feature shipped broken once:
`mono-connect-link` and `mono-webhook` wrote `client_account_id` and
`provider_customer_id`, but no migration created those columns, so every Connect
Link completion failed. The guard parses migrations and edge functions and fails
on any drift.

The demo bank remains the deterministic simulator. Future scenario coverage should
include provider outage, stale data, reauth, reversal, duplicate webhook and balance
mismatch.

Before production Mono use, validate exact provider payloads and set MONO_AMOUNT_UNIT
accordingly.