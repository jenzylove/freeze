// v0.2 end to end on a local Arbitrum fork (anvil --fork-url https://arb1.arbitrum.io/rpc --port 8546).
// A brand new wallet that only has money on Solana: every proposal the plugin returns is executed on the fork,
// except the Solana deposit, whose arrival is simulated by crediting what Relay would deliver.
// Usage: node scripts/e2e-v02.mjs
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";

const R = "http://127.0.0.1:8546";
const cast = (...a) => execFileSync("cast", [...a, "--rpc-url", R], { encoding: "utf8" }).trim();
const USDCE = "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8";
const CARDS = "0x5Fe380D68fEe022d8acd42dc4D36FbfB249a76d5";
const AUTOCASH = "0x679399608d973c2476d1D9ECd8eB1150e97936Ec";
const SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failures++;
};

async function call(name, args) {
  const child = spawn(process.execPath, ["dist/plugin.mjs"], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, ARBITRUM_RPC: R } });
  const lines = createInterface({ input: child.stdout });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args, _meta: {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "e2e", version: "0" },
    "io.modelcontextprotocol/clientCapabilities": {} } } }) + "\n");
  for await (const line of lines) {
    const m = JSON.parse(line);
    if (m.id !== 1) continue;
    child.kill();
    const r = m.result ?? {};
    return { text: r.content?.[0]?.text ?? JSON.stringify(m.error), error: !!r.isError || !!m.error, p: r.structuredContent?.["io.paybox/transactionProposal"], s: r.structuredContent };
  }
}

function send(owner, p) {
  const out = JSON.parse(cast("send", p.transaction.to, p.transaction.data, "--value", p.transaction.value, "--from", owner, "--unlocked", "--json"));
  return out.status === "0x1";
}

const owner = JSON.parse(execFileSync("cast", ["wallet", "new", "--json"], { encoding: "utf8" }))[0].address;
cast("rpc", "anvil_impersonateAccount", owner);
const args = { asset: "BTC", usd: 30, sender: owner, pay_from: "solana" };
console.log("new wallet", owner);

// 1. Empty wallet, user said "using my funds on Solana".
let r = await call("freeze_lock", args);
check(r.error && /freeze_fund_solana/.test(r.text) && /don't pay again/.test(r.text), "freeze_lock on an empty wallet sends the agent to freeze_fund_solana, with the no double pay line");
const usd = Number(/usd ([\d.]+)/.exec(r.text)?.[1]);
check(usd >= 3, `asks to bring at least $3 (got $${usd})`);

// 2. The Solana deposit itself (real Relay quote).
r = await call("freeze_fund_solana", { usd, sender: owner, solana_sender: SOL });
check(!r.error && r.p?.kind === "solana" && r.p.chain === "solana:mainnet", "freeze_fund_solana returns a Solana proposal");
check(/\$0\.25 of ETH for network fees/.test(r.text), "includes $0.25 of gas because the Arbitrum wallet is empty");
check(Buffer.from(r.p?.transaction.transactionBase64 ?? "", "base64").length <= 1232, "Solana transaction fits in 1,232 bytes");

// 3. Simulate Relay landing: USDC.e and a little ETH arrive.
const whale = "0x489ee077994B6658eAfA855C308275EAd8097C4A"; // GMX vault, holds USDC.e
cast("rpc", "anvil_impersonateAccount", whale);
cast("rpc", "anvil_setBalance", whale, "0xDE0B6B3A7640000");
cast("send", USDCE, "transfer(address,uint256)", owner, String(Math.round(usd * 1e6)), "--from", whale, "--unlocked");
cast("rpc", "anvil_setBalance", owner, "0x" + (107_000_000_000_000n).toString(16)); // about $0.25 of ETH

// 4. freeze_lock walks: allow fees, auto cash, freeze.
r = await call("freeze_lock", args);
check(!r.error && r.p?.transaction.to.toLowerCase() === USDCE.toLowerCase() && /3 approvals to go/.test(r.text), "next: allow fees (3 approvals to go)");
check(send(owner, r.p), "allowance confirmed on the fork");
r = await call("freeze_lock", args);
check(!r.error && r.p?.transaction.to.toLowerCase() === CARDS.toLowerCase() && /auto cash/.test(r.text), "next: turn on auto cash");
check(send(owner, r.p), "auto cash approval confirmed");
check(cast("call", CARDS, "isApprovedForAll(address,address)(bool)", owner, AUTOCASH) === "true", "auto cash contract is approved for this wallet's cards");
r = await call("freeze_lock", args);
check(!r.error && /Last step/.test(r.text), "next: the freeze itself");
check(/paid from the USDC\.e in this Arbitrum wallet/.test(r.text), "says where the fee is paid from");
check(send(owner, r.p), "freeze confirmed on the fork");

// 5. The card shows up with auto cash on.
r = await call("freeze_cards", { sender: owner });
const card = r.s?.cards?.[0];
check(!r.error && card && card.status === "open" && r.s.auto_cash === true, `freeze_cards shows card ${card?.card} open, auto cash on`);
check(Number(cast("balance", owner)) > 40_000_000_000_000, "wallet still has gas left after three Arbitrum transactions");

// 6. A second freeze is one approval, and says where the fee came from.
r = await call("freeze_lock", args);
check(!r.error && /Last step/.test(r.text) && /paid from the USDC\.e/.test(r.text), "second freeze: one approval, fee from USDC.e already on Arbitrum");

// 7. Gas only: plenty of USDC.e but no ETH asks for $1, not $3.
cast("rpc", "anvil_setBalance", owner, "0x0");
r = await call("freeze_lock", args);
check(r.error && /usd 1[ ,]/.test(r.text), "no ETH for gas: asks to bring $1");

// 8. Base path: allowance proposal on Base with 3% headroom.
r = await call("freeze_fund", { from: "base", usd: 3, sender: owner });
const approveAmt = r.p ? BigInt("0x" + r.p.transaction.data.slice(74, 138)) : 0n;
check(!r.error && r.p?.chain === "eip155:8453" && r.p.transaction.data.startsWith("0x095ea7b3"), "freeze_fund from base returns the Base allowance step");
check(approveAmt > 3_000_000n * 103n / 100n, `allowance has headroom (${Number(approveAmt) / 1e6} USDC for a $3 transfer)`);

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
