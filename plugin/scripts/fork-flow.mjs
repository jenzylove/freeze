// Full first-time flow for a real wallet on a local Arbitrum fork (anvil on :8546):
// freeze_fund -> freeze_approve -> freeze_lock, executing each proposal the plugin returns.
// Usage: node scripts/fork-flow.mjs <owner> <usd-to-fund> <asset> <usd> <days>
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";

const [owner, fund, asset, usd, days] = process.argv.slice(2);
const R = "http://127.0.0.1:8546";
const cast = (...a) => execFileSync("cast", [...a, "--rpc-url", R], { encoding: "utf8" }).trim();

async function call(name, args) {
  const child = spawn(process.execPath, ["dist/plugin.mjs"], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, ARBITRUM_RPC: R },
  });
  const lines = createInterface({ input: child.stdout });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args, _meta: {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "fork-flow", version: "0" },
    "io.modelcontextprotocol/clientCapabilities": {} } } }) + "\n");
  for await (const line of lines) {
    const m = JSON.parse(line);
    if (m.id !== 1) continue;
    child.kill();
    return m.result;
  }
}

function send(result) {
  const p = result.structuredContent?.["io.paybox/transactionProposal"];
  if (!p) throw new Error(result.content?.[0]?.text ?? "no proposal");
  const out = JSON.parse(cast("send", p.transaction.to, p.transaction.data, "--value", p.transaction.value, "--from", owner, "--unlocked", "--json"));
  return `${out.status === "0x1" ? "OK" : "FAILED"} gas ${parseInt(out.gasUsed, 16)}`;
}

cast("rpc", "anvil_impersonateAccount", owner);
const usdce = () => cast("call", "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8", "balanceOf(address)(uint256)", owner).split(" ")[0];
console.log("ETH before:", cast("balance", owner, "--ether"), "USDC.e before:", usdce());

let r = await call("freeze_fund", { usd: Number(fund), owner });
console.log("fund:", r.content[0].text, "->", send(r), "USDC.e now:", usdce());
r = await call("freeze_approve", { asset, usd: Number(usd), days: Number(days), owner });
console.log("approve:", r.content[0].text, "->", send(r));
r = await call("freeze_lock", { asset, usd: Number(usd), days: Number(days), owner });
console.log("lock:", r.content[0].text, "->", send(r));
r = await call("freeze_cards", { owner });
console.log("cards:", r.content[0].text);
console.log("ETH after:", cast("balance", owner, "--ether"), "USDC.e after:", usdce());
