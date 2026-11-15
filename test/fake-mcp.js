#!/usr/bin/env node
// Stands in for the `mcp` CLI (github.com/f/mcptools) in tests, reproducing
// its argument parsing and its `-f json` output: the tool result map printed
// as one line of JSON, or "error: ..." on stderr with status 1.
import { spawn } from "node:child_process";
import fs from "node:fs";

const argv = process.argv.slice(2);
if (process.env.FAKE_MCP_LOG) fs.appendFileSync(process.env.FAKE_MCP_LOG, `${JSON.stringify(argv)}\n`);
const sub = argv.shift();
let params = {};
let format = "table";
let tool;
const rest = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if ((a === "--params" || a === "-p") && i + 1 < argv.length) params = JSON.parse(argv[++i]);
  else if ((a === "--format" || a === "-f") && i + 1 < argv.length) format = argv[++i];
  else if (sub === "call" && tool === undefined) tool = a;
  else rest.push(a);
}
if (format !== "json") throw new Error("tests always use -f json");
const child = spawn(rest[0], rest.slice(1), { stdio: ["pipe", "pipe", "inherit"] });
let buffer = "";
const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
child.stdout.on("data", (d) => {
  buffer += d;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const m = JSON.parse(buffer.slice(0, idx));
    buffer = buffer.slice(idx + 1);
    if (m.id === 1) {
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send(sub === "call"
        ? { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: params } }
        : { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    } else if (m.id === 2) {
      if (m.error) {
        process.stderr.write(`error: ${m.error.message}\n`);
        process.exitCode = 1;
      } else process.stdout.write(`${JSON.stringify(m.result)}\n`);
      child.kill();
    }
  }
});
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-mcp", version: "0" } } });
