// Talking to Linear's MCP server.
//
// Two transports, both driving the same server command (by default
// `npx -y mcp-remote https://mcp.linear.app/mcp`, which handles the OAuth
// login and token storage, so no API key is ever needed):
//
//   mcp    shells out to the `mcp` CLI (github.com/f/mcptools), one process per
//          tool call, exactly like
//            mcp call list_issues --params '{"assignee":"me"}' -f json \
//              npx -y mcp-remote https://mcp.linear.app/mcp
//   stdio  speaks MCP's JSON-RPC over stdio to the server command directly,
//          keeping one session open for every call a command makes.
//
// `auto` (the default) uses `mcp` when it is on PATH and `stdio` otherwise.
import { spawn, spawnSync } from "node:child_process";
import { CliError, EXIT } from "./errors.js";

export const DEFAULT_SERVER = "npx -y mcp-remote https://mcp.linear.app/mcp";

/** Splits a command line into words, honouring single and double quotes. */
export function splitCommand(line) {
  const words = [];
  let word = null;
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < line.length) word += line[++i];
      else word += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      word ??= "";
    } else if (/\s/.test(ch)) {
      if (word !== null) words.push(word);
      word = null;
    } else if (ch === "\\" && i + 1 < line.length) {
      word = (word ?? "") + line[++i];
    } else {
      word = (word ?? "") + ch;
    }
  }
  if (quote) throw new CliError(`Unbalanced quote in MCP server command: ${line}`, EXIT.usage);
  if (word !== null) words.push(word);
  return words;
}

function onPath(command) {
  if (command.includes("/")) return true;
  const probe = spawnSync(process.platform === "win32" ? "where" : "sh",
    process.platform === "win32" ? [command] : ["-c", `command -v "$1"`, "sh", command],
    { stdio: "ignore" });
  return probe.status === 0;
}

/** Text of an MCP tool result, parsed as JSON when it is JSON. */
export function unwrapResult(result) {
  if (result === null || typeof result !== "object" || !Array.isArray(result.content)) {
    return result;
  }
  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    return result.structuredContent;
  }
  const texts = result.content.filter((c) => c && c.type === "text").map((c) => c.text);
  const text = texts.join("\n");
  if (result.isError) throw toolError(text);
  return parseMaybeJson(text);
}

export function parseMaybeJson(text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed === "") return null;
  if (/^[[{"]/.test(trimmed) || /^(true|false|null|-?\d)/.test(trimmed)) {
    try {
      return JSON.parse(trimmed);
    } catch {
      /* plain text */
    }
  }
  return trimmed;
}

/** Maps an error message from the server or transport to an exit status. */
export function toolError(message) {
  const text = String(message || "The Linear MCP server returned an error").trim();
  let code = EXIT.failure;
  if (/not ?found|does not exist|no (issue|team|project|user|document|cycle|milestone)/i.test(text)) {
    code = EXIT.notFound;
  } else if (/unauthori[sz]ed|\b401\b|\b403\b|forbidden|authenticat|invalid[_ ]token|oauth/i.test(text)) {
    code = EXIT.auth;
  } else if (/rate limit|timed? ?out|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|\b50[0-9]\b|unavailable/i.test(text)) {
    code = EXIT.unavailable;
  }
  const error = new CliError(text, code);
  error.toolError = true;
  return error;
}

/** Whether `error` says the server has no tool by that name. */
export function isUnknownTool(error) {
  return /unknown tool|tool .*not found|no such tool|tool not found|method not found|not a valid tool|-32601/i
    .test(error?.message ?? "");
}

function debug(...parts) {
  if (process.env.LINEAR_DEBUG) process.stderr.write(`[linear] ${parts.join(" ")}\n`);
}

/** Forwards the lines of a server's stderr the user must act on (login). */
function relayAuthLines(chunk, state) {
  state.buffer += chunk;
  let index;
  while ((index = state.buffer.indexOf("\n")) >= 0) {
    const line = state.buffer.slice(0, index);
    state.buffer = state.buffer.slice(index + 1);
    if (process.env.LINEAR_DEBUG) process.stderr.write(`${line}\n`);
    else if (/authori[sz]|browser|https?:\/\/\S+\/(authorize|oauth)/i.test(line)) {
      process.stderr.write(`${line.replace(/^\[\d+\]\s*/, "")}\n`);
    }
  }
}

// ---------------------------------------------------------------- mcp CLI

class McpCliTransport {
  constructor({ mcpCommand, server, timeoutMs }) {
    this.mcpCommand = mcpCommand;
    this.server = server;
    this.timeoutMs = timeoutMs;
    this.name = "mcp";
  }

  run(args) {
    const [cmd, ...pre] = splitCommand(this.mcpCommand);
    const argv = [...pre, ...args, ...this.server];
    debug("$", cmd, ...argv.map((a) => (/[\s'"{}]/.test(a) ? `'${a}'` : a)));
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(cmd, argv, { stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        reject(new CliError(`Could not run ${cmd}: ${error.message}`, EXIT.unavailable));
        return;
      }
      let stdout = "";
      let stderr = "";
      const relay = { buffer: "" };
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new CliError(`The Linear MCP server did not answer within ${this.timeoutMs / 1000}s`, EXIT.unavailable));
      }, this.timeoutMs);
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => {
        stderr += d;
        relayAuthLines(String(d), relay);
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        const hint = error.code === "ENOENT"
          ? `\nInstall it (https://github.com/f/mcptools) or set LINEAR_MCP_TRANSPORT=stdio.`
          : "";
        reject(new CliError(`Could not run \`${cmd}\`: ${error.message}${hint}`, EXIT.unavailable));
      });
      child.on("close", (status) => {
        clearTimeout(timer);
        if (status !== 0) {
          reject(toolError(stderr.trim() || stdout.trim() || `${cmd} exited with status ${status}`));
          return;
        }
        resolve(stdout);
      });
    });
  }

  async callTool(name, params) {
    const out = await this.run(["call", name, "--params", JSON.stringify(params ?? {}), "-f", "json"]);
    const parsed = parseMaybeJson(out);
    if (typeof parsed === "string" && /^error[: ]/i.test(parsed)) throw toolError(parsed);
    return unwrapResult(parsed);
  }

  async listTools() {
    const out = parseMaybeJson(await this.run(["tools", "-f", "json"]));
    return Array.isArray(out) ? out : out?.tools ?? [];
  }

  close() {}
}

// ---------------------------------------------------------------- stdio

class StdioTransport {
  constructor({ server, timeoutMs }) {
    this.server = server;
    this.timeoutMs = timeoutMs;
    this.name = "stdio";
    this.nextId = 1;
    this.pending = new Map();
    this.ready = null;
  }

  start() {
    if (this.ready) return this.ready;
    const [cmd, ...args] = this.server;
    debug("$", cmd, ...args);
    this.ready = new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
      this.child = child;
      this.stderr = "";
      const relay = { buffer: "" };
      let buffer = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (data) => {
        buffer += data;
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line) this.onMessage(line);
        }
      });
      child.stderr.on("data", (d) => {
        this.stderr += d;
        relayAuthLines(String(d), relay);
      });
      child.on("error", (error) => {
        const failure = new CliError(`Could not start the MCP server \`${cmd}\`: ${error.message}`, EXIT.unavailable);
        reject(failure);
        this.failAll(failure);
      });
      child.on("close", (status) => {
        const failure = toolError(
          this.stderr.trim().split("\n").slice(-5).join("\n")
            || `The MCP server exited with status ${status}`,
        );
        if (failure.code === EXIT.failure) failure.code = EXIT.unavailable;
        reject(failure);
        this.failAll(failure);
      });
      this.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "linear-mcp-cli", version: "1.0.0" },
      }).then(() => {
        this.notify("notifications/initialized", {});
        resolve();
      }, reject);
    });
    return this.ready;
  }

  onMessage(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      debug("ignoring non-JSON line from server:", line);
      return;
    }
    if (message.id !== undefined && this.pending.has(message.id) && !message.method) {
      const { resolve, reject, timer } = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(timer);
      if (message.error) {
        const error = toolError(`${message.error.message ?? "error"} (${message.error.code ?? ""})`);
        reject(error);
      } else resolve(message.result);
    } else if (message.method && message.id !== undefined) {
      // Server-to-client request (ping, roots, ...): answer politely.
      const result = message.method === "roots/list" ? { roots: [] } : {};
      this.send({ jsonrpc: "2.0", id: message.id, result });
    }
  }

  failAll(error) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }

  send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CliError(`The Linear MCP server did not answer ${method} within ${this.timeoutMs / 1000}s`, EXIT.unavailable));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async callTool(name, params) {
    await this.start();
    debug("call", name, JSON.stringify(params ?? {}));
    return unwrapResult(await this.request("tools/call", { name, arguments: params ?? {} }));
  }

  async listTools() {
    await this.start();
    const tools = [];
    let cursor;
    do {
      const page = await this.request("tools/list", cursor ? { cursor } : {});
      tools.push(...(page.tools ?? []));
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  close() {
    if (!this.child) return;
    this.failAll(new CliError("closed", EXIT.failure));
    this.child.stdin.end();
    this.child.kill("SIGTERM");
  }
}

// ---------------------------------------------------------------- client

export class McpClient {
  constructor(options = {}) {
    const server = splitCommand(options.server || DEFAULT_SERVER);
    if (server.length === 0) throw new CliError("The MCP server command is empty", EXIT.usage);
    const mcpCommand = options.mcpCommand || "mcp";
    const timeoutMs = Number(options.timeoutMs) || 180_000;
    let kind = options.transport || "auto";
    if (kind === "auto") kind = onPath(splitCommand(mcpCommand)[0]) ? "mcp" : "stdio";
    if (kind === "mcp" || kind === "mcp-cli") {
      this.transport = new McpCliTransport({ mcpCommand, server, timeoutMs });
    } else if (kind === "stdio") {
      this.transport = new StdioTransport({ server, timeoutMs });
    } else {
      throw new CliError(`Unknown MCP transport "${kind}": use auto, mcp, or stdio`, EXIT.usage);
    }
    this.cache = new Map();
  }

  /**
   * Calls the first tool in `names` the server has. Linear has renamed tools
   * over time (create_issue → save_issue), so callers can list alternatives.
   */
  async call(names, params = {}) {
    const list = Array.isArray(names) ? names : [names];
    let lastError;
    for (const name of list) {
      try {
        return await this.transport.callTool(name, stripUndefined(params));
      } catch (error) {
        lastError = error;
        if (!isUnknownTool(error) || name === list.at(-1)) throw error;
        debug(`tool ${name} unavailable, trying the next one`);
      }
    }
    throw lastError;
  }

  /** `call`, remembered for the rest of the command. */
  async cached(names, params = {}) {
    const key = JSON.stringify([names, params]);
    if (!this.cache.has(key)) {
      this.cache.set(key, this.call(names, params).catch((error) => {
        this.cache.delete(key);
        throw error;
      }));
    }
    return this.cache.get(key);
  }

  listTools() {
    return this.transport.listTools();
  }

  close() {
    this.transport.close();
  }
}

function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = stripUndefined(v);
    return out;
  }
  return value;
}
