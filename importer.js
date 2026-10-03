/* OmniPocket statement importer (CSV/XLSX preview + commit).
 * Extracted from app.js to reduce file size; preserves global API.
 */

function parseStatementCsv(text) {
  const rows = [];
  let current = "";
  let inQuotes = false;
  const chars = text.replace(/\r\n/g, "\n").split("");
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === '"') {
      if (inQuotes && chars[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
      continue;
    }
    if (c === "," && !inQuotes) { rows.push(current); current = ""; continue; }
    if (c === "\n" && !inQuotes) { rows.push(current); current = ""; continue; }
    current += c;
  }
  rows.push(current);
  return rows.map(cell => cell.trim());
}

function statementColumn(headers, patterns) {
  const list = headers.map((h, i) => ({ i, h: String(h || "").toLowerCase() }));
  return list.find(item => patterns.some(p => item.h.includes(p)))?.i ?? -1;
}

function normalizeStatementDate(value) {
  if (!value) return { valid: false };
  const s = String(value).trim();
  const iso = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (iso) { const d = new Date(Number(iso[1]), Number(iso[2])-1, Number(iso[3])); if (!isNaN(d)) return { valid: true, date: d.toISOString().slice(0,10) }; }
  const nigerian = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);
  if (nigerian) { const d = new Date(Number(nigerian[3]), Number(nigerian[2])-1, Number(nigerian[1])); if (!isNaN(d)) return { valid: true, date: d.toISOString().slice(0,10) }; }
  const d2 = new Date(s);
  if (!isNaN(d2) && s.length > 3) return { valid: true, date: d2.toISOString().slice(0,10) };
  return { valid: false };
}

function parseStatementAmount(value) {
  if (value === null || value === undefined) return { valid: false };
  const cleaned = String(value).replace(/[,\s]/g, "").replace(/^[^\d-()]+/, "").replace(/[^\d-]+$/, "");
  if (!cleaned || cleaned === "-" || cleaned === "()" || cleaned === "( - )") return { valid: false };
  const parenthetic = cleaned.match(/^\(([-+]?\d+(?:\.\d+)?)\)$/);
  if (parenthetic) return { valid: true, amount: -Math.abs(parseFloat(parenthetic[1])) };
  const n = parseFloat(cleaned);
  if (isNaN(n)) return { valid: false };
  return { valid: true, amount: n };
}

function statementHeaderOptions(headers, selected, emptyLabel = "Ignore") {
  const base = [{ value: -1, label: emptyLabel }];
  return base.concat(headers.map((h, i) => ({ value: i, label: String(h || `Column ${i+1}`) })));
}

function previewStatementImport(text, accountId, mapping = {}) {
  const raw = parseStatementCsv(text);
  if (!raw.length) return { headers: [], rows: [], invalidCount: 0, duplicateCount: 0, transferCount: 0 };
  const headers = raw[0].split(",").map(c => c.replace(/^"|"$/g, ""));
  if (!raw[1] && raw.length === 1) return { headers, rows: [], invalidCount: 0, duplicateCount: 0, transferCount: 0 };
  const data = raw.slice(1).map(line => line.split(",").map(c => c.replace(/^"|"$/g, "")));
  return previewStatementImportObjects(data, accountId, mapping, headers);
}

function previewStatementImportObjects(parsed, accountId, mapping = {}, headersIn = []) {
  const accountTarget = account(accountId);
  if (!parsed.rows && !Array.isArray(parsed)) return { headers: headersIn, rows: [], invalidCount: 0, duplicateCount: 0, transferCount: 0 };
  const rowsArray = parsed.rows || parsed;
  if (!accountTarget) throw new Error("Choose an account for this statement first.");
  const headers = headersIn.length ? headersIn : (rowsArray[0] ? Object.keys(rowsArray[0]) : []);
  const getValue = (row, idx) => (Array.isArray(row) ? (row[idx] ?? "") : (row[headers[idx]] ?? ""));
  const dateCol = mapping.date != null ? Number(mapping.date) : statementColumn(headers, ["date","transaction date","value date","posted date","booking date"]);
  const descCol = mapping.description != null ? Number(mapping.description) : statementColumn(headers, ["description","narration","details","transaction","name","payee","beneficiary"]);
  const refCol = mapping.reference != null ? Number(mapping.reference) : statementColumn(headers, ["reference","ref","id","transaction id","txn id","trace","time","channel"]);
  const amountCol = mapping.amount != null ? Number(mapping.amount) : statementColumn(headers, ["amount","amount (ngn)","value","credit/debit","dr/cr"]);
  const debitCol = mapping.debit != null ? Number(mapping.debit) : statementColumn(headers, ["debit","dr","outflow"]);
  const creditCol = mapping.credit != null ? Number(mapping.credit) : statementColumn(headers, ["credit","cr","inflow"]);
  if (dateCol < 0 || (amountCol < 0 && debitCol < 0 && creditCol < 0)) throw new Error("Map a Date and either Amount or Debit/Credit before previewing.");
  const now = Date.now();
  const rows = rowsArray.filter(r => Array.isArray(r) ? r.some(c => String(c||"").trim()) : Object.values(r).some(c => String(c||"").trim())).map((row, index) => {
    const dateRaw = getValue(row, dateCol);
    const descRaw = getValue(row, descCol);
    const refRaw = refCol >= 0 ? getValue(row, refCol) : "";
    const amountRaw = amountCol >= 0 ? getValue(row, amountCol) : "";
    const debitRaw = debitCol >= 0 ? getValue(row, debitCol) : "";
    const creditRaw = creditCol >= 0 ? getValue(row, creditCol) : "";
    const d = normalizeStatementDate(dateRaw);
    let signed = 0;
    if (amountCol >= 0) { const a = parseStatementAmount(amountRaw); signed = a.valid ? a.amount : 0; }
    else {
      const dr = parseStatementAmount(debitRaw); const cr = parseStatementAmount(creditRaw);
      if (dr.valid && Math.abs(dr.amount) > 0) signed = -Math.abs(dr.amount);
      else if (cr.valid && Math.abs(cr.amount) > 0) signed = Math.abs(cr.amount);
    }
    const invalid = !d.valid || !isFinite(signed) || Math.abs(signed) < 0.01;
    const date = d.valid ? d.date : "";
    const description = String(descRaw || "").trim();
    const reference = String(refRaw || "").trim();
    const suggestion = suggestTransactionCategory({ description, amount: Math.abs(signed), currency: accountTarget.currency, type: signed > 0 ? "income" : "expense" });
    const handling = suggestTransactionHandling({ description, amount: Math.abs(signed), currency: accountTarget.currency, type: signed > 0 ? "income" : "expense" });
    const pair = findTransferCounterpart({ id: "preview-" + index, type: signed > 0 ? "income" : "expense", sourceAccountId: accountTarget.id, amount: Math.abs(signed), currency: accountTarget.currency, date, description, reference, external: { provider: "statement_import" } });
    return {rowNumber:index+2,date,description,reference,signedAmount:signed,type:signed>0?"income":"expense",currency:accountTarget.currency,accountId:accountTarget.id,suggestedCategory:suggestion?.category||null,categoryConfidence:suggestion?.confidence??null,categoryReason:suggestion?.reason||"",suggestedType:handling?.type||null,suggestedSourceAccountId:handling?.suggestedSourceAccountId||null,suggestedDestinationAccountId:handling?.destinationAccountId||null,handlingConfidence:handling?.confidence??null,handlingReason:handling?.reason||"",suggestedPairTransactionId:pair?.transactionId||null,suggestedPairCandidates:pair?.candidates?.map(candidate=>candidate.transactionId)||[],suggestedPairCandidateMeta:Object.fromEntries((pair?.candidates||[]).map(candidate=>[candidate.transactionId,{confidence:candidate.confidence,reason:candidate.reason}])),suggestedPairConfidence:pair?.confidence??null,suggestedPairReason:pair?.reason||""};
  });
  const analyzedRows = rows.filter(row => !row.invalid);
  const previewFingerprint = row => [row.accountId,row.date,row.signedAmount.toFixed(2),row.description.toLowerCase().replace(/\s+/g," ").trim(),row.reference.toLowerCase().trim()].join("|");
  const duplicateRows = analyzedRows.filter(row => state.transactions.some(t => (t.external?.provider === "statement_import" || t.external?.provider === "statement_csv") && t.external.providerTransactionId === previewFingerprint(row)));
  const duplicateFingerprints = new Set(duplicateRows.map(previewFingerprint));
  analyzedRows.forEach(row => { row.isDuplicate = duplicateFingerprints.has(previewFingerprint(row)); });
  const transferRows = analyzedRows.filter(row => row.suggestedType === "transfer" || row.suggestedType === "withdrawal");
  return { headers, rows, invalidCount: rows.filter(r => r.invalid).length, duplicateCount: duplicateRows.length, transferCount: transferRows.length };
}

function commitStatementImport(previewRows) {
  if (!Array.isArray(previewRows)) return { imported: 0, duplicates: 0, invalid: 0 };
  let imported = 0, duplicates = 0, invalid = 0;
  const now = Date.now();
  for (const row of previewRows) {
    if (row.invalid) { invalid++; continue; }
    const fingerprint = [row.accountId,row.date,row.signedAmount.toFixed(2),row.description.toLowerCase().replace(/\s+/g," ").trim(),row.reference.toLowerCase().trim()].join("|");
    const existing = state.transactions.find(t => t.external?.providerTransactionId === fingerprint);
    if (existing) {
      existing.external.lastSeenAt = new Date().toISOString();
      duplicates++;
      continue;
    }
    importTransaction({
      type: row.type,
      sourceAccountId: row.accountId,
      amount: Math.abs(row.signedAmount),
      signedAmount: row.signedAmount,
      currency: row.currency,
      suggestedType: row.suggestedType,
      suggestedSourceAccountId: row.suggestedSourceAccountId,
      suggestedDestinationAccountId: row.suggestedDestinationAccountId,
      suggestedPairTransactionId: row.suggestedPairTransactionId,
      suggestedPairCandidates: row.suggestedPairCandidates,
      suggestedPairCandidateMeta: row.suggestedPairCandidateMeta,
      suggestedPairConfidence: row.suggestedPairConfidence,
      suggestedPairReason: row.suggestedPairReason,
      handlingConfidence: row.handlingConfidence,
      handlingReason: row.handlingReason,
      category: row.type === "income" ? "Imported income" : "Other",
      description: row.description,
      reference: row.reference,
      note: row.description || "Imported from bank statement",
      date: row.date,
      external: { provider: "statement_import", providerTransactionId: fingerprint }
    });
    imported++;
  }
  refreshTransferPairSuggestions();
  rebuildBalances();
  saveState();
  return { imported, duplicates, invalid };
}