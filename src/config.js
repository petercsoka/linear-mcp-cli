// Settings: flags > environment (shell, then .env) > project .linear.toml >
// global ~/.config/linear/linear.toml. Same keys as schpet/linear-cli, plus
// the MCP connection settings that replace the API key.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CliError, EXIT } from "./errors.js";

export const OPTIONS = {
  team_id: { env: "LINEAR_TEAM_ID", description: "default team for operations" },
  workspace: { env: "LINEAR_WORKSPACE", description: "workspace slug for web/app URLs" },
  issue_sort: { env: "LINEAR_ISSUE_SORT", values: ["priority", "manual"], description: "how to sort issue lists" },
  issue_create_assign_self: {
    env: "LINEAR_ISSUE_CREATE_ASSIGN_SELF",
    values: ["always", "auto", "never"],
    description: "self-assign new issues",
  },
  vcs: { env: "LINEAR_VCS", values: ["git", "jj"], description: "version control system" },
  pr_template: { env: "LINEAR_PR_TEMPLATE", description: "template file for `issue pr` bodies" },
  mcp_server: {
    env: "LINEAR_MCP_SERVER",
    description: "command that runs the Linear MCP server (default: npx -y mcp-remote https://mcp.linear.app/mcp)",
  },
  mcp_transport: {
    env: "LINEAR_MCP_TRANSPORT",
    values: ["auto", "mcp", "stdio"],
    description: "`mcp` shells out to the mcp CLI per call; `stdio` talks to the server directly",
  },
  mcp_command: { env: "LINEAR_MCP_COMMAND", description: "the mcp CLI to run (default: mcp)" },
  mcp_timeout: { env: "LINEAR_MCP_TIMEOUT", description: "seconds to wait for a tool call (default: 180)" },
};

/** A tiny TOML subset: `key = "string" | 'string' | true | false | 123`. */
export function parseToml(text, file) {
  const out = {};
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.replace(/^\s+|\s+$/g, "");
    if (!line || line.startsWith("#") || line.startsWith("[")) continue;
    const match = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!match) throw new CliError(`${file}:${index + 1}: cannot parse "${raw}"`, EXIT.usage);
    let [, key, value] = match;
    value = value.replace(/\s+#.*$/, "");
    if (/^"(.*)"$/.test(value)) value = JSON.parse(value);
    else if (/^'(.*)'$/.test(value)) value = value.slice(1, -1);
    else if (value === "true" || value === "false") value = value === "true";
    else if (/^-?\d+(\.\d+)?$/.test(value)) value = Number(value);
    else throw new CliError(`${file}:${index + 1}: invalid value for ${key}`, EXIT.usage);
    out[key] = value;
  }
  return out;
}

function readToml(file) {
  try {
    return parseToml(fs.readFileSync(file, "utf8"), file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function readDotenv(dir) {
  if (process.env.LINEAR_IGNORE_ENV_FILE) return {};
  try {
    const out = {};
    for (const line of fs.readFileSync(path.join(dir, ".env"), "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2];
      if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
      out[m[1]] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function repoRoot(cwd = process.cwd()) {
  for (const args of [["git", ["rev-parse", "--show-toplevel"]], ["jj", ["root"]]]) {
    try {
      return execFileSync(args[0], args[1], { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {
      /* not that VCS */
    }
  }
  return null;
}

export function globalConfigPath() {
  if (process.platform === "win32" && process.env.APPDATA) {
    return path.join(process.env.APPDATA, "linear", "linear.toml");
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "linear", "linear.toml");
}

export function projectConfigPath(cwd = process.cwd()) {
  const candidates = [path.join(cwd, "linear.toml"), path.join(cwd, ".linear.toml")];
  const root = repoRoot(cwd);
  if (root) {
    candidates.push(
      path.join(root, "linear.toml"),
      path.join(root, ".linear.toml"),
      path.join(root, ".config", "linear.toml"),
    );
  }
  return candidates.find((file) => fs.existsSync(file)) ?? null;
}

export function loadConfig(cwd = process.cwd()) {
  const globalFile = globalConfigPath();
  const projectFile = projectConfigPath(cwd);
  const tiers = [
    { source: "environment", values: {} },
    { source: ".env", values: {} },
    { source: projectFile, values: (projectFile && readToml(projectFile)) || {} },
    { source: globalFile, values: readToml(globalFile) || {} },
  ];
  const dotenv = readDotenv(repoRoot(cwd) ?? cwd);
  for (const [key, option] of Object.entries(OPTIONS)) {
    if (process.env[option.env] !== undefined) tiers[0].values[key] = process.env[option.env];
    if (dotenv[option.env] !== undefined) tiers[1].values[key] = dotenv[option.env];
  }
  const config = {};
  for (const tier of [...tiers].reverse()) {
    for (const [key, value] of Object.entries(tier.values)) {
      const option = OPTIONS[key];
      if (option?.values && !option.values.includes(String(value))) {
        throw new CliError(
          `${tier.source}: ${key} must be one of ${option.values.join(", ")}, not "${value}"`,
          EXIT.usage,
        );
      }
      config[key] = value;
    }
  }
  config.projectFile = projectFile;
  config.globalFile = globalFile;
  return config;
}

export function writeToml(file, values) {
  const lines = Object.entries(values)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k} = ${typeof v === "string" ? JSON.stringify(v) : v}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
}
