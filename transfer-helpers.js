// Extracted from app.js: transfer pairing helpers.

function transactionExternalKey(external) {
  if (!external?.provider || !external?.providerTransactionId) return null;
  return String(external.provider) + ':' + String(external.providerTransactionId);
}

function findImportedTransaction(external) {
  const key = transactionExternalKey(external);
  if (!key) return null;
  return state.transactions.find(t => transactionExternalKey(t.external) === key) || null;
}

function normalizeTransferText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(?:transfer|trf|nip|inward|outward|credit|debit|from|to|payment|transaction|txn|ref|reference)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedReference(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

function accountAliases(a) {
  if (!a) return [];
  const values = [a.name, a.institution];
  return [...new Set(values.flatMap(value => {
    const normalized = normalizeTransferText(value);
    return normalized ? [normalized, ...normalized.split(" ").filter(part => part.length >= 4)] : [];
  }))];
}

function findTransferCounterpart(input) {
  const amount = Math.abs(Number(input.amount) || 0);
  if (!amount || !input.sourceAccountId) return null;
  const source = account(input.sourceAccountId);
  if (!source) return null;

  const targetDate = new Date(String(input.date || today()) + "T00:00:00");
  const inputReference = normalizedReference(input.reference);
  const inputText = normalizeTransferText([input.description, input.note, input.reference].filter(Boolean).join(" "));
  const sourceAliases = accountAliases(source);
  const candidates = [];

  for (const tx of state.transactions) {
    if (tx.status !== "needs_review" || tx.id === input.id || tx.pairedTransactionId) continue;
    if (tx.type !== "income" && tx.type !== "expense") continue;
    if (input.type !== "income" && input.type !== "expense") continue;
    if (tx.type === input.type) continue;

    const other = account(tx.sourceAccountId);
    if (!other || other.id === source.id || other.archived) continue;

    const otherAmount = Math.abs(Number(tx.amount) || 0);
    if (!otherAmount) continue;

    const txDate = new Date(String(tx.date || "") + "T00:00:00");
    const dayGap = Math.abs(targetDate - txDate) / 86400000;
    if (!Number.isFinite(dayGap) || dayGap > 2) continue;

    const otherReference = normalizedReference(tx.reference);
    const otherText = normalizeTransferText([tx.description, tx.note, tx.reference].filter(Boolean).join(" "));
    const combinedText = inputText + " " + otherText;
    const inputIsSource = input.type === "expense";
    const sourceCurrency = inputIsSource ? source.currency : other.currency;
    const destinationCurrency = inputIsSource ? other.currency : source.currency;
    const comparableRate = rate(sourceCurrency, destinationCurrency);
    const expectedOtherAmount = amount * comparableRate;
    const crossCurrency = source.currency !== tx.currency;
    const fxDelta = expectedOtherAmount > 0 ? Math.abs(otherAmount - expectedOtherAmount) / expectedOtherAmount : Infinity;
    const sameCurrencyDelta = Math.abs(otherAmount - amount) / Math.max(amount, 0.01);
    const fxDifferenceAmount = crossCurrency && expectedOtherAmount > 0 ? otherAmount - expectedOtherAmount : otherAmount - amount;
    const fxDifferencePercent = crossCurrency && expectedOtherAmount > 0 ? fxDifferenceAmount / expectedOtherAmount : sameCurrencyDelta;
    const feeLikeDifference = Math.abs(fxDifferencePercent) <= 0.03;
    const fxPlausible = crossCurrency && comparableRate > 0 && Number.isFinite(fxDelta) && fxDelta <= 0.15;

    // Same-currency legs retain the strict 0.5% guard. Cross-currency legs use
    // the cached/manual FX rate with a 15% tolerance so fees, spread and stale
    // rates do not prevent an otherwise obvious internal transfer from matching.
    if (!crossCurrency && sameCurrencyDelta > 0.005) continue;
    if (crossCurrency && !fxPlausible) continue;

    let score = 0;
    const reasons = [];

    if (!crossCurrency) {
      if (Math.abs(otherAmount - amount) < 0.000001) {
        score += 0.28;
        reasons.push("exact amount");
      } else {
        score += 0.18;
        reasons.push("near amount");
      }
    } else {
      const fxQuality = Math.max(0, 1 - fxDelta / 0.15);
      score += 0.18 + fxQuality * 0.12;
      reasons.push("FX-plausible amount");
      reasons.push("implied rate " + (otherAmount / amount).toFixed(6));
      if (feeLikeDifference && Math.abs(fxDifferenceAmount) > 0.000001) reasons.push((fxDifferenceAmount < 0 ? "possible transfer fee/spread" : "small FX gain") + " " + Math.abs(fxDifferencePercent * 100).toFixed(2) + "%");
    }

    if (dayGap === 0) {
      score += 0.15;
      reasons.push("same date");
    } else if (dayGap <= 1) {
      score += 0.10;
      reasons.push("within 1 day");
    } else {
      score += 0.05;
      reasons.push("within 2 days");
    }

    if (source.currency === tx.currency) {
      score += 0.06;
      reasons.push("same currency");
    } else {
      score += 0.05;
      reasons.push(source.currency + " → " + tx.currency);
    }

    const exactReference = inputReference && otherReference && inputReference === otherReference;
    if (exactReference) {
      score += 0.42;
      reasons.push("exact reference match");
    } else if (inputReference && otherReference) {
      const inputTokens = new Set(normalizeTransferText(input.reference).split(" ").filter(Boolean));
      const otherTokens = new Set(normalizeTransferText(tx.reference).split(" ").filter(Boolean));
      const overlap = [...inputTokens].filter(token => otherTokens.has(token) && token.length >= 4);
      if (overlap.length) {
        score += 0.16;
        reasons.push("reference tokens overlap");
      }
    }

    if (/\b(?:transfer|trf|nip)\b/i.test(combinedText)) {
      score += 0.08;
      reasons.push("transfer language");
    }

    const otherAliases = accountAliases(other);
    const matchedAlias = [...new Set([...sourceAliases, ...otherAliases])]
      .find(alias => alias.length >= 4 && combinedText.includes(alias));
    if (matchedAlias) {
      score += 0.08;
      reasons.push("account name appears in narration");
    }

    if (input.external?.provider && tx.external?.provider && input.external.provider === tx.external.provider) {
      score += 0.03;
      reasons.push("same import source");
    }

    candidates.push({
      transaction: tx,
      score: Math.min(0.99, score),
      exactReference,
      reasons,
      reconciliation: { sourceAmount: inputIsSource ? amount : otherAmount, sourceCurrency, destinationAmount: inputIsSource ? otherAmount : amount, destinationCurrency, expectedDestinationAmount: expectedOtherAmount, differenceAmount: fxDifferenceAmount, differencePercent: fxDifferencePercent, feeLikeDifference }
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  if (!candidates.length) return null;

  const strong = candidates.filter(candidate => candidate.score >= 0.70).slice(0, 4);
  if (!strong.length) return null;

  const best = strong[0];
  const runnerUp = strong[1];
  const ambiguous = runnerUp && !best.exactReference && Math.abs(best.score - runnerUp.score) < 0.08;

  return {
    transactionId: ambiguous ? null : best.transaction.id,
    confidence: best.score,
    reason: ambiguous ? "Multiple plausible transfer matches require review" : "Matched " + reasonsForTransferPair(best),
    candidates: strong.map(candidate => ({
      transactionId: candidate.transaction.id,
      confidence: candidate.score,
      reason: reasonsForTransferPair(candidate), reconciliation: candidate.reconciliation
    }))
  };
}

function reasonsForTransferPair(candidate) {
  return candidate.reasons.join(", ");
}
