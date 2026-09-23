# OmniPocket

OmniPocket is a local-first, multi-currency wealth tracker designed to give a single connected view of money across bank accounts, cash, digital wallets, and locked savings.

## V1 foundation

- Multiple supported account types and currencies
- Base-currency net worth aggregation
- Income, expense, transfer, withdrawal, and reconciliation transactions
- Two-sided transfers between accounts
- Cross-currency transfers with calculated or manually supplied FX
- Historical transaction dates
- `Handle later` status for quick entries
- Multiple goals with account selection
- Hideable financial values
- Local-first persistence with a versioned state migration path
- PWA shell and offline mode foundation

## Architecture direction

The financial state is treated as a domain model rather than a collection of UI counters. Transactions describe money movement; account balances are maintained as the current materialized state; reconciliation is recorded as an adjustment rather than silently changing history.

The current persistence adapter uses localStorage for the bootstrap build. The domain model is intentionally separated from the UI so IndexedDB, synchronization, bank integrations, and live FX providers can be introduced without rewriting the product model.

## Status

Active V1 development.
