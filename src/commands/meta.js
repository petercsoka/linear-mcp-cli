// config, auth, mcp, completions
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { usage } from "../errors.js";
import { OPTIONS, globalConfigPath, repoRoot, writeToml } from "../config.js";
import { DEFAULT_SERVER, parseMaybeJson } from "../mcp.js";
import { done, print, printJson, table } from "../format.js";
import { TOOLS, one, normUser } from "../linear.js";
import { confirm, input, interactive, select } from "../prompt.js";
import { jsonOption } from "./common.js";

// ---------------------------------------------------------------- config

async function config(ctx, o) {
  const values = {};
  const file = o.global ? globalConfigPath() : path.join(repoRoot() ?? process.cwd(), ".linear.toml");
  let team = o.team;
  if (!team) {
    if (!interactive(ctx.noInput)) throw usage("No team given", "Pass --team.");
    const teams = await ctx.linear().teams({ refresh: true });
    team = await select("Default team:", teams.map((t) => ({ label: `${t.key}  ${t.name}`, value: t.key })));
  }
  values.team_id = team;
  let workspace = o.workspaceSlug ?? ctx.workspace;
  if (!workspace) {
    try {
      const issues = await ctx.linear().issues({ team, limit: 1 }, 1);
      workspace = /linear\.app\/([^/]+)\//.exec(issues[0]?.url ?? "")?.[1];
    } catch {
      /* optional */
    }
  }
  if (!workspace && interactive(ctx.noInput)) workspace = await input("Workspace slug (from linear.app/<slug>/...):");
  if (workspace) values.workspace = workspace;
  if (o.vcs) values.vcs = o.vcs;
  else if (fs.existsSync(path.join(repoRoot() ?? process.cwd(), ".jj"))) values.vcs = "jj";
  for (const key of ["mcp_server", "mcp_transport"]) {
    if (ctx.config[key] && process.env[OPTIONS[key].env] === undefined && o.global) values[key] = ctx.config[key];
  }
  if (fs.existsSync(file) && !o.yes) {
    if (!interactive(ctx.noInput)) throw usage(`${file} exists`, "Pass --yes to overwrite it.");
    if (!(await confirm(`Overwrite ${file}?`))) return process.stderr.write("Canceled.\n");
  }
  writeToml(file, values);
  print(done("Wrote", "config", file));
}

// ---------------------------------------------------------------- auth

function authDir() {
  return process.env.MCP_REMOTE_CONFIG_DIR || path.join(os.homedir(), ".mcp-auth");
}

async function whoami(ctx, o) {
  const me = one(await ctx.linear().mcp.call(TOOLS.getUser, { query: "me" }), "user");
  if (o.json) return printJson(me);
  const user = normUser(me);
  const org = me?.organization?.name ?? me?.organization;
  print(`${user.name}${user.email ? ` <${user.email}>` : ""}${org ? ` (${typeof org === "string" ? org : ""})` : ""}\n`);
}

async function login(ctx) {
  process.stderr.write(`Connecting to ${ctx.config.mcp_server || DEFAULT_SERVER}\n`
    + "mcp-remote opens your browser to authorize Linear if you are not logged in yet.\n");
  const me = normUser(one(await ctx.linear().mcp.call(TOOLS.getUser, { query: "me" }), "user"));
  print(done("Logged in", "as", `${me.name}${me.email ? ` <${me.email}>` : ""}`));
}

async function logout(ctx, o) {
  const dir = authDir();
  if (!fs.existsSync(dir)) return print("Not logged in: no mcp-remote credentials found.\n");
  if (!o.yes) {
    if (!interactive(ctx.noInput)) throw usage("Confirmation needed", "Pass --yes.");
    if (!(await confirm(`Remove mcp-remote's stored credentials in ${dir}? This logs out every mcp-remote server.`))) {
      return process.stderr.write("Canceled.\n");
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  print(done("Removed", "credentials in", dir));
}

async function status(ctx) {
  const c = ctx.config;
  const rows = [
    ["server", c.mcp_server || DEFAULT_SERVER],
    ["transport", `${ctx.linear().mcp.transport.name}${c.mcp_transport && c.mcp_transport !== "auto" ? "" : " (auto)"}`],
    ["mcp cli", c.mcp_command || "mcp"],
    ["credentials", fs.existsSync(authDir()) ? authDir() : "none stored yet"],
    ["team", c.team_id ?? "-"],
    ["workspace", ctx.workspace ?? "-"],
    ["project config", c.projectFile ?? "-"],
    ["global config", fs.existsSync(c.globalFile) ? c.globalFile : "-"],
  ];
  print(table([{ header: "SETTING" }, { header: "VALUE", flexible: true }], rows));
}

// ---------------------------------------------------------------- mcp

async function tools(ctx, o) {
  const list = await ctx.linear().mcp.listTools();
  if (o.json) return printJson(list);
  print(table([{ header: "TOOL" }, { header: "DESCRIPTION", flexible: true }],
    list.map((t) => [t.name, (t.description ?? "").split("\n")[0]])));
}

async function call(ctx, o, a) {
  let params = {};
  const raw = a.params ?? o.params ?? (!process.stdin.isTTY ? fs.readFileSync(0, "utf8") : "");
  if (raw && raw.trim()) {
    params = parseMaybeJson(raw);
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
      throw usage("Params must be a JSON object, like '{\"assignee\":\"me\"}'");
    }
  }
  const result = await ctx.linear().mcp.call(a.tool, params);
  if (typeof result === "string") print(`${result}\n`);
  else printJson(result);
}

// ---------------------------------------------------------------- completions

function completions(ctx, o, a, root) {
  const shell = a.shell ?? "bash";
  const tree = {};
  const walk = (cmd, prefix) => {
    tree[prefix] = [...(cmd.commands ?? []).map((c) => c.name), ...(cmd.options ?? []).map((op) => `--${op.name}`)].join(" ");
    for (const c of cmd.commands ?? []) walk(c, prefix ? `${prefix} ${c.name}` : c.name);
  };
  walk(root, "");
  if (shell === "bash" || shell === "zsh") {
    const cases = Object.entries(tree).map(([k, v]) => `    "${k}") words="${v}" ;;`).join("\n");
    print(`${shell === "zsh" ? "autoload -U +X bashcompinit && bashcompinit\n" : ""}_linear() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" path="" words
  for w in "\${COMP_WORDS[@]:1:COMP_CWORD-1}"; do [[ $w == -* ]] || path="\${path:+$path }$w"; done
  case "$path" in
${cases}
    *) words="" ;;
  esac
  COMPREPLY=($(compgen -W "$words" -- "$cur"))
}
complete -F _linear linear
`);
  } else if (shell === "fish") {
    for (const [k, v] of Object.entries(tree)) {
      const cond = k ? `__fish_seen_subcommand_from ${k.split(" ").at(-1)}` : "__fish_use_subcommand";
      for (const w of v.split(" ").filter((x) => x && !x.startsWith("-"))) print(`complete -c linear -f -n '${cond}' -a ${w}\n`);
    }
  } else throw usage(`Unsupported shell: ${shell} (use bash, zsh, or fish)`);
}

// ---------------------------------------------------------------- grammar

const yes = { name: "yes", short: "y", type: "boolean", desc: "Do not ask for confirmation" };

export const configCommand = {
  name: "config", aliases: ["configure"], summary: "Write a .linear.toml for the current repository", run: config,
  options: [
    { name: "team", type: "string", desc: "Default team key" },
    { name: "workspace-slug", type: "string", value: "SLUG", desc: "Workspace slug for web/app URLs" },
    { name: "vcs", type: "string", desc: "git or jj" },
    { name: "global", type: "boolean", desc: "Write the global config instead of the repository's" },
    yes,
  ],
};

export const authCommand = {
  name: "auth", summary: "Log in to Linear's MCP server and inspect the connection",
  commands: [
    { name: "login", summary: "Authorize with Linear through mcp-remote's OAuth flow", run: login },
    { name: "logout", summary: "Remove mcp-remote's stored credentials", run: logout, options: [yes] },
    { name: "whoami", summary: "Print the logged-in user", run: whoami, options: [jsonOption] },
    { name: "status", summary: "Show the MCP connection settings", run: status },
  ],
};

export const mcpCommand = {
  name: "mcp", aliases: ["api"],
  summary: "Call a Linear MCP tool directly (the MCP counterpart of `linear api`)",
  commands: [
    { name: "tools", summary: "List the tools the Linear MCP server offers", run: tools, options: [jsonOption] },
    {
      name: "call", summary: "Call a tool with JSON params, printing the result", run: call,
      args: [{ name: "tool", required: true, desc: "Tool name, like list_issues" }, { name: "params", desc: "JSON object (or pass on stdin)" }],
      options: [{ name: "params", short: "p", type: "string", value: "JSON", desc: "JSON object of arguments" }],
    },
  ],
};

export const completionsCommand = {
  name: "completions", summary: "Print shell completions (bash, zsh, fish)",
  args: [{ name: "shell", desc: "bash, zsh, or fish" }],
  run: completions,
};

