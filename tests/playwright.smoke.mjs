import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
const root=process.cwd();
const types={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".json":"application/json",".svg":"image/svg+xml",".webmanifest":"application/manifest+json"};
const server=createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,"http://127.0.0.1");
    const file=normalize(join(root,decodeURIComponent(url.pathname==="/" ? "/index.html" : url.pathname)));
    if(!file.startsWith(root)) throw new Error("bad path");
    const body=await readFile(file);
    res.writeHead(200,{"content-type":types[extname(file)]||"application/octet-stream","cache-control":"no-store"});res.end(body);
  }catch{res.writeHead(404);res.end("not found");}
});
await new Promise(resolve=>server.listen(4173,"127.0.0.1",resolve));
const browser=await chromium.launch({headless:true});
try{
  const page=await browser.newPage();
  await page.goto("http://127.0.0.1:4173/index.html",{waitUntil:"domcontentloaded"});
  await page.waitForTimeout(1200);
  if((await page.title())!=="OmniPocket") throw new Error("Unexpected page title");
  await page.locator("#netWorth").waitFor();
  await page.locator("#dashboardGalaxy").waitFor();
  console.log("OmniPocket Playwright smoke passed");
} finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }