# OmniPocket Architecture

Financial flow: Provider -> Supabase canonical bank data -> local IndexedDB projection -> UI.

Manual, CSV, OCR, SMS/parser, payment and bank inputs become normalized transactions with explicit provenance. The browser projection may be stale; it must not silently rewrite provider opening balances or historical transactions.

Layers: bank-core.js provider boundary; Supabase canonical backend; domain.js financial engine; IndexedDB persistence; app.js UI/projection; architecture.js, diagnostics.js and financial-services.js operational services.

Providers expose connect, exchangeToken, getAccount, getTransactions, sync, disconnect and status. Mono is the first adapter.

Financial lifecycle and review lifecycle are separate: pending/posted/reversed/failed versus imported/classified/reviewed/recorded.

Provider balance and local balance are separate. A mismatch becomes a reconciliation event or explicit adjustment.