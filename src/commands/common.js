import fs from "node:fs";
import { spawn } from "node:child_process";
import { usage } from "../errors.js";

export const issueLimitOption = {
  name: "limit", type: "string", default: "50", desc: "Maximum number of issues to show (a number or `all`)",
};

export function parseLimit(value) {
  if (value === undefined || value === null) return 50;
  if (String(value).toLowerCase() === "all") return Infinity;
  if (!/^\d+$/.test(String(value)) || Number(value) < 1) {
    throw usage(`invalid value '${value}' for '--limit <LIMIT>': use a whole number or \`all\``);
  }
  return Number(value);
}

/** A file's text, or stdin for "-". */
export function readText(file) {
  try {
    return fs.readFileSync(file === "-" ? 0 : file, "utf8");
  } catch (error) {
    throw usage(`Could not read ${file}: ${error.message}`);
  }
}

/** Opens a Linear URL in the browser, or in the desktop app with `app`. */
export function openUrl(url, app = false) {
  const target = app ? url.replace(/^https:\/\/linear\.app\//, "linear://") : url;
  const [cmd, args] = process.platform === "darwin" ? ["open", [target]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", target]]
      : ["xdg-open", [target]];
  process.stdout.write(`Opening ${target}\n`);
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    /* printed the URL; that is enough */
  }
}

export const jsonOption = { name: "json", short: "j", type: "boolean", desc: "Print JSON" };
