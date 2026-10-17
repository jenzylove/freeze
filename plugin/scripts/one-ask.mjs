// One user ask on a local Arbitrum fork (anvil :8546): call freeze_lock repeatedly, executing each
// proposal it returns, until the freeze card exists. Then freeze again to show it is one step.
// Usage: node scripts/one-ask.mjs <wallet-with-eth-only>
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";

const [who] = process.argv.slice(2);
const R = "http://127.0.0.1:8546";
const cast = (...a) => execFileSync("cast", [...a, "--rpc-url", R], { encoding: "utf8" }).trim();

async function call(name, args) {
  const child = spawn(process.execPath, ["dist/plugin.mjs"], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, ARBITRUM_RPC: R } });
  const lines = createInterface({ input: child.stdout });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args, _meta: {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "one-ask", version: "0" },
    "io.modelcontextprotocol/clientCapabilities": {} } } }) + "\n");
  for await (const line of lines) { const m = JSON.parse(line); if (m.id !== 1) continue; child.kill(); return m.result; }
}

cast("rpc", "anvil_impersonateAccount", who);
cast("rpc", "anvil_setBalance", who, "0x2386F26FC10000"); // 0.01 ETH, no USDC.e
const ask = { asset: "BTC", usd: 20, days: 7, sender: who };
for (const round of [1, 2]) {
  console.log(`\n== ask ${round}: "freeze $20 of BTC for a week"`);
  for (let i = 1; i <= 4; i++) {
    const r = await call("freeze_lock", ask);
    const p = r.structuredContent?.["io.paybox/transactionProposal"];
    if (!p) throw new Error(r.content?.[0]?.text);
    const out = JSON.parse(cast("send", p.transaction.to, p.transaction.data, "--value", p.transaction.value, "--from", who, "--unlocked", "--json"));
    console.log(`approval ${i}: ${r.content[0].text.slice(0, 90)}... -> ${out.status === "0x1" ? "OK" : "FAILED"}`);
    if (p.transaction.to.toLowerCase() === "0xec096ea6eb9aa5ea689b0cf00882366e92377371") break;
  }
}
console.log("\n" + (await call("freeze_cards", { sender: who })).content[0].text);
