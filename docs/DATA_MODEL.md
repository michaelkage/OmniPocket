# Data Model

Accounts contain user-facing identity plus optional provider identity. Transactions contain type, amount, currency, source/destination, date, bank status, review status, provenance, category, note and optional provider IDs.

Provider IDs are the primary bank dedupe key. A normalized fingerprint is the secondary duplicate detector for statement/manual imports.

Goals reference contributing accounts. They do not add money a second time.

Reconciliation stores provider balance, local balance, difference, reason and resolution state independently.