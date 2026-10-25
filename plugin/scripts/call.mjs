// Call one tool of the built plugin, the way PayBox does. Usage: node scripts/call.mjs <tool> '<json args>'
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const [name, json] = process.argv.slice(2);
const child = spawn(process.execPath, ["dist/plugin.mjs"], { stdio: ["pipe", "pipe", "inherit"] });
const lines = createInterface({ input: child.stdout });
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: JSON.parse(json ?? "{}"), _meta: {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "call", version: "0" },
  "io.modelcontextprotocol/clientCapabilities": {} } } }) + "\n");
for await (const line of lines) {
  const m = JSON.parse(line);
  if (m.id !== 1) continue;
  child.kill();
  const r = m.result ?? m.error;
  console.log(r?.isError ? "ERROR:" : "OK:", r?.content?.[0]?.text ?? JSON.stringify(r));
  const p = r?.structuredContent?.["io.paybox/transactionProposal"];
  if (p) console.log("proposal:", p.kind, p.chain, JSON.stringify(p.transaction).slice(0, 160));
  break;
}
