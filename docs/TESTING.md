# Testing

CI runs JavaScript syntax checks, domain smoke tests, bank normalization/provider-contract tests, migration guards, static integration checks and a Playwright browser smoke.

Fixtures cover a bank snapshot, credits/debits, a pending transaction and a webhook envelope.

The demo bank remains the deterministic simulator. Future scenario coverage should include provider outage, stale data, reauth, reversal, duplicate webhook and balance mismatch.

Before production Mono use, validate exact provider payloads and set MONO_AMOUNT_UNIT accordingly.