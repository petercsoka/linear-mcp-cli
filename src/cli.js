// A small subcommand parser with generated help, in the spirit of clap.
import { CliError, EXIT } from "./errors.js";

const GLOBAL_OPTIONS = [
  { name: "workspace", type: "string", value: "SLUG", desc: "Workspace slug used for web and app URLs" },
  { name: "no-input", aliases: ["no-interactive"], type: "boolean", desc: "Never prompt; fail instead when a required value is missing" },
  { name: "help", short: "h", type: "boolean", desc: "Print help" },
];

const camel = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

function findCommand(parent, word) {
  return (parent.commands ?? []).find((c) => c.name === word || (c.aliases ?? []).includes(word));
}

function closest(word, names) {
  let best = null;
  let bestScore = Infinity;
  for (const name of names) {
    const d = distance(word, name);
    if (d < bestScore) [best, bestScore] = [name, d];
  }
  return bestScore <= Math.max(2, Math.floor(word.length / 3)) ? best : null;
}

function distance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

export function parse(root, argv) {
  const path = [root];
  let i = 0;
  // Global flags may come before the subcommand.
  const early = [];
  while (i < argv.length) {
    const word = argv[i];
    if (word.startsWith("-")) {
      early.push(word);
      const option = GLOBAL_OPTIONS.find((o) => `--${o.name}` === word);
      if (option?.type === "string") early.push(argv[++i]);
      i++;
      continue;
    }
    const current = path.at(-1);
    if (!current.commands) break;
    const next = findCommand(current, word);
    if (!next) {
      if (current.run) break;
      const suggestion = closest(word, current.commands.map((c) => c.name));
      throw new CliError(
        `unrecognized subcommand '${word}'${suggestion ? `\n\n  tip: a similar subcommand exists: '${suggestion}'` : ""}`,
        EXIT.usage,
        `For more information, try '${commandPath(path)} --help'.`,
      );
    }
    path.push(next);
    i++;
  }
  const command = path.at(-1);
  const rest = [...early, ...argv.slice(i)];
  const options = [...(command.options ?? []), ...GLOBAL_OPTIONS];
  const values = {};
  for (const o of options) {
    const key = camel(o.name);
    if (o.type === "multi") values[key] = [];
    else if (o.type === "boolean") values[key] = false;
    if (o.default !== undefined) values[key] = o.default;
  }
  const seen = new Set();
  const positionals = [];
  const lookupLong = (name) => options.find((o) => o.name === name || (o.aliases ?? []).includes(name));
  const lookupShort = (ch) => options.find((o) => o.short === ch || (o.shortAliases ?? []).includes(ch));
  const assign = (option, value, flag) => {
    const key = camel(option.name);
    if (option.type === "boolean") {
      values[key] = true;
    } else {
      if (value === undefined) throw new CliError(`a value is required for '${flag}' but none was supplied`, EXIT.usage);
      if (option.type === "multi") {
        if (!seen.has(key) && option.default !== undefined) values[key] = [];
        values[key].push(value);
      } else values[key] = value;
    }
    seen.add(key);
  };
  for (let j = 0; j < rest.length; j++) {
    const word = rest[j];
    if (word === "--") {
      positionals.push(...rest.slice(j + 1));
      break;
    }
    if (word.startsWith("--")) {
      const [name, inline] = word.slice(2).split(/=(.*)/s);
      const option = lookupLong(name);
      if (!option) {
        const suggestion = closest(name, options.map((o) => o.name));
        throw new CliError(
          `unexpected argument '${word}' found${suggestion ? `\n\n  tip: a similar argument exists: '--${suggestion}'` : ""}`,
          EXIT.usage,
          `For more information, try '${commandPath(path)} --help'.`,
        );
      }
      if (option.type === "boolean") {
        if (inline !== undefined) throw new CliError(`unexpected value '${inline}' for '--${name}'`, EXIT.usage);
        assign(option, undefined, word);
      } else assign(option, inline !== undefined ? inline : rest[++j], word);
      continue;
    }
    if (word.startsWith("-") && word.length > 1 && !/^-\d/.test(word)) {
      const chars = word.slice(1);
      for (let k = 0; k < chars.length; k++) {
        const option = lookupShort(chars[k]);
        if (!option) throw new CliError(`unexpected argument '-${chars[k]}' found`, EXIT.usage, `For more information, try '${commandPath(path)} --help'.`);
        if (option.type === "boolean") assign(option, undefined, `-${chars[k]}`);
        else {
          const value = chars.slice(k + 1) || rest[++j];
          assign(option, value, `-${chars[k]}`);
          break;
        }
      }
      continue;
    }
    positionals.push(word);
  }
  if (values.help || (!command.run && command.commands)) {
    return { command, path, help: true, values, positionals };
  }
  const args = {};
  const specs = command.args ?? [];
  specs.forEach((spec, index) => {
    const key = camel(spec.name);
    if (spec.variadic) args[key] = positionals.slice(index);
    else args[key] = positionals[index];
    if (spec.required && (args[key] === undefined || (spec.variadic && args[key].length === 0))) {
      throw new CliError(
        `the following required arguments were not provided:\n  <${spec.name.toUpperCase()}>`,
        EXIT.usage,
        `Usage: ${usageLine(path)}`,
      );
    }
  });
  const max = specs.some((s) => s.variadic) ? Infinity : specs.length;
  if (positionals.length > max) {
    throw new CliError(`unexpected argument '${positionals[max]}' found`, EXIT.usage, `Usage: ${usageLine(path)}`);
  }
  for (const group of command.conflicts ?? []) {
    const set = group.filter((name) => seen.has(camel(name)));
    if (set.length > 1) {
      throw new CliError(`the argument '--${set[0]}' cannot be used with '--${set[1]}'`, EXIT.usage);
    }
  }
  return { command, path, values, args, seen };
}

export function commandPath(path) {
  return path.map((c) => c.name).join(" ");
}

function usageLine(path) {
  const command = path.at(-1);
  const parts = [commandPath(path)];
  if (command.commands) parts.push("<COMMAND>");
  if (command.options?.length) parts.push("[OPTIONS]");
  for (const a of command.args ?? []) {
    const n = a.name.toUpperCase();
    parts.push(a.required ? `<${n}>${a.variadic ? "..." : ""}` : `[${n}]${a.variadic ? "..." : ""}`);
  }
  return parts.join(" ");
}

function optionLabel(o) {
  const long = `--${o.name}${o.type === "boolean" ? "" : ` <${o.value ?? o.name.toUpperCase()}>`}`;
  return o.short ? `-${o.short}, ${long}` : `    ${long}`;
}

export function help(path) {
  const command = path.at(-1);
  const out = [];
  out.push(command.description ?? command.summary ?? "");
  out.push("");
  out.push(`Usage: ${usageLine(path)}`);
  if (command.commands) {
    out.push("", "Commands:");
    const pad = Math.max(...command.commands.map((c) => c.name.length)) + 2;
    for (const c of command.commands) {
      const alias = c.aliases?.length ? ` [aliases: ${c.aliases.join(", ")}]` : "";
      out.push(`  ${c.name.padEnd(pad)}${c.summary ?? ""}${alias}`);
    }
  }
  if (command.args?.length) {
    out.push("", "Arguments:");
    for (const a of command.args) out.push(`  [${a.name.toUpperCase()}]${a.variadic ? "..." : ""}  ${a.desc ?? ""}`);
  }
  const options = command.options ?? [];
  if (options.length) {
    out.push("", "Options:");
    const pad = Math.max(...options.map((o) => optionLabel(o).length)) + 2;
    for (const o of options) {
      const def = o.default !== undefined && o.type !== "boolean" ? ` [default: ${[].concat(o.default).join(", ")}]` : "";
      out.push(`  ${optionLabel(o).padEnd(pad)}${o.desc ?? ""}${def}`);
    }
  }
  out.push("", "Global options:");
  const pad = Math.max(...GLOBAL_OPTIONS.map((o) => optionLabel(o).length)) + 2;
  for (const o of GLOBAL_OPTIONS) out.push(`  ${optionLabel(o).padEnd(pad)}${o.desc}`);
  if (path.length === 1) out.push("  -V, --version".padEnd(pad + 2) + "Print version");
  if (command.after) out.push("", command.after);
  return `${out.join("\n").replace(/^\n+/, "")}\n`;
}
