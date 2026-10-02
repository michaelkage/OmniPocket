# OmniPocket Architecture

Financial flow: Provider -> Supabase canonical bank data -> local IndexedDB projection -> UI.

Manual, CSV, OCR, SMS/parser, payment and bank inputs become normalized transactions with explicit provenance. The browser projection may be stale; it must not silently rewrite provider opening balances or historical transactions.

Layers: bank-core.js provider boundary; Supabase canonical backend; domain.js financial engine; storage.js IndexedDB persistence; supabase-client.js integration boundary (runtime config, client singleton, anonymous session, edge-function calls); app.js UI/projection; architecture.js, diagnostics.js and financial-services.js operational services.

Runtime config comes from `_build.js` (overwritten on deploy from repo variables) and must load before app.js. Secrets never live in the client; only the Supabase publishable key and Mono public key are exposed, both server-validated.

Any column written by an edge function must exist in a migration. `tests/schema-contract.test.mjs` enforces this.

Providers expose connect, exchangeToken, getAccount, getTransactions, sync, disconnect and status. Mono is the first adapter.

Financial lifecycle and review lifecycle are separate: pending/posted/reversed/failed versus imported/classified/reviewed/recorded.

Provider balance and local balance are separate. A mismatch becomes a reconciliation event or explicit adjustment.