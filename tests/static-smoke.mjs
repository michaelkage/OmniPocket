import assert from "node:assert/strict";
import fs from "node:fs";
for(const file of ["index.html","styles.css","sw.js","manifest.webmanifest","favicon.svg","app.js","domain.js","storage.js","bus.js","bank-core.js","architecture.js","diagnostics.js"]){
  assert(fs.existsSync(file),`Missing required asset: ${file}`);
}
const html=fs.readFileSync("index.html","utf8");
const app=fs.readFileSync("app.js","utf8");
for(const marker of ["supabase-js","bank-core.js","architecture.js","diagnostics.js"]) assert(html.includes(marker),`Missing integration marker: ${marker}`);
for(const marker of ["mono-exchange-token","mono-account-sync","omnipocket-payment-initiate"]) assert(app.includes(marker),`Missing app integration marker: ${marker}`);
console.log("OmniPocket static smoke tests passed");