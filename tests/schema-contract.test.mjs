// Guards against edge functions writing columns that no migration creates.
// This is the exact failure that broke Mono Connect Link: client_account_id
// and provider_customer_id were written by two functions but never declared.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const migrationDir = "supabase/migrations";
const functionDir = "supabase/functions";

// Parse all migrations into { table: Set<column> }.
function parseSchema() {
  const tables = new Map();
  const ensure = name => {
    if (!tables.has(name)) tables.set(name, new Set());
    return tables.get(name);
  };

  for (const file of fs.readdirSync(migrationDir).filter(f => f.endsWith(".sql")).sort()) {
    const sql = fs.readFileSync(path.join(migrationDir, file), "utf8");
    // Strip comments so commented-out DDL cannot register phantom columns.
    const clean = sql
      .split("\n")
      .map(line => line.replace(/--.*$/, ""))
      .join("\n");

    for (const match of clean.matchAll(
      /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?(\w+)\s*\(([\s\S]*?)\n\);/gi
    )) {
      const [, table, body] = match;
      for (const line of body.split("\n")) {
        const col = line.trim().match(/^(\w+)\s+/);
        if (col) ensure(table.toLowerCase()).add(col[1].toLowerCase());
      }
    }

    // alter table X add column [if not exists] y ... (comma-separated repeats)
    for (const match of clean.matchAll(
      /alter\s+table\s+(?:if\s+exists\s+)?(?:public\.)?(\w+)\s+([\s\S]*?);/gi
    )) {
      const [, table, statement] = match;
      for (const col of statement.matchAll(
        /add\s+column\s+(?:if\s+not\s+exists\s+)?([A-Za-z_]\w*)/gi
      )) {
        ensure(table.toLowerCase()).add(col[1].toLowerCase());
      }
    }
  }
  return tables;
}

// Pull `{ column: ... }` keys out of .insert()/.update() payloads in a function.
function parseWrittenColumns(source) {
  const written = new Map();
  const add = (table, column) => {
    if (!written.has(table)) written.set(table, new Set());
    written.get(table).add(column);
  };

  // `.from("t").insert({ ... })` / `.update({ ... })` / .upsert({...})
  const callRe = /\.from\(\s*["'`](\w+)["'`]\s*\)[\s\S]{0,80}?\.(?:insert|update|upsert)\(\s*\{/gi;
  for (const match of source.matchAll(callRe)) {
    const table = match[1].toLowerCase();
    const start = match.index + match[0].length;
    let braceDepth = 1;
    let i = start;
    const body = [];
    while (i < source.length && braceDepth > 0) {
      const ch = source[i];
      if (ch === "{") braceDepth++;
      else if (ch === "}") braceDepth--;
      if (braceDepth > 0) body.push(ch);
      i++;
    }
    // Only top-level keys of the payload object. Keys are read at depth 1,
    // which also covers payloads written on a single line.
    let depth = 1;
    let line = "";
    const flush = () => {
      const m = line.match(/^\s*["'`]?([A-Za-z_]\w*)["'`]?\s*:/);
      if (m && depth === 1) add(table, m[1].toLowerCase());
      line = "";
    };
    for (const ch of body) {
      if (ch === "{" || ch === "[" || ch === "(") {
        flush();
        depth++;
        line = "";
      } else if (ch === "}" || ch === "]" || ch === ")") {
        flush();
        depth--;
        line = "";
      } else if (ch === "\n") {
        flush();
      } else if (ch === "," && depth === 1) {
        flush();
      } else {
        line += ch;
      }
    }
    flush();
  }
  return written;
}

const schema = parseSchema();
assert(schema.size > 0, "No tables parsed from migrations");

const known = new Set();
for (const cols of schema.values()) for (const c of cols) known.add(c);

// Values assigned into JSON columns are not column names.
const jsonColumns = new Set(["metadata", "payload", "raw", "fx", "connection"]);

const missing = [];
for (const entry of fs.readdirSync(functionDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const file = path.join(functionDir, entry.name, "index.ts");
  if (!fs.existsSync(file)) continue;
  const written = parseWrittenColumns(fs.readFileSync(file, "utf8"));
  for (const [table, columns] of written) {
    if (!schema.has(table)) {
      missing.push(`${entry.name}: writes unknown table "${table}"`);
      continue;
    }
    for (const column of columns) {
      if (jsonColumns.has(column)) continue;
      if (!schema.get(table).has(column)) {
        missing.push(`${entry.name}: "${table}" has no column "${column}"`);
      }
    }
  }
}

assert.deepEqual(missing, [], "Edge function / migration schema drift:\n" + missing.join("\n"));

// Sanity: the known-broken columns must now exist.
assert(schema.get("bank_connections").has("client_account_id"), "bank_connections.client_account_id missing");
assert(schema.get("bank_connections").has("provider_customer_id"), "bank_connections.provider_customer_id missing");

console.log(`OmniPocket schema contract tests passed (${schema.size} tables)`);