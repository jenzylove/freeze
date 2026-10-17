// Call one tool on the built plugin the way PayBox does (one stateless request per process).
// Usage: node scripts/call.mjs <tool> '<json arguments>'
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const [tool, args = "{}"] = process.argv.slice(2);
const child = spawn(process.execPath, ["dist/plugin.mjs"], { stdio: ["pipe", "pipe", "inherit"] });
const lines = createInterface({ input: child.stdout });
child.stdin.write(
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: tool,
      arguments: JSON.parse(args),
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "freeze-smoke", version: "0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  }) + "\n",
);
for await (const line of lines) {
  const msg = JSON.parse(line);
  if (msg.id !== 1) continue;
  console.log(JSON.stringify(msg.result ?? msg.error, null, 2));
  break;
}
child.kill();
