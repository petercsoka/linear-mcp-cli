// Shared output helpers: tables, colors, priorities, times, paging.
import { spawnSync } from "node:child_process";

export const tty = () => Boolean(process.stdout.isTTY);
export const color = () => tty() && !process.env.NO_COLOR && process.env.TERM !== "dumb";

const sgr = (code) => (text) => (color() ? `\x1b[${code}m${text}\x1b[0m` : text);
export const bold = sgr("1");
export const gray = sgr("90");
export const green = sgr("32");
export const yellow = sgr("33");
export const red = sgr("31");
export const heading = sgr("1;4");

export function hex(text, value) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value ?? "");
  if (!m || !color()) return text;
  const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16));
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

/** One line with no control characters. */
export function singleLine(text) {
  // eslint-disable-next-line no-control-regex
  return String(text ?? "").replace(/[\r\n\t]+/g, " ").replace(/[\x00-\x1f\x7f]/g, "");
}

const ANSI = /\x1b\[[0-9;]*m/g; // eslint-disable-line no-control-regex

/** Terminal columns a string takes up (wide CJK and emoji count as two). */
export function width(text) {
  let n = 0;
  for (const ch of String(text).replace(ANSI, "")) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x300 && cp <= 0x36f) continue;
    n += (cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3)
      || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60)
      || (cp >= 0x1f300 && cp <= 0x1faff))) ? 2 : 1;
  }
  return n;
}

function cut(text, max) {
  if (width(text) <= max) return text;
  let out = "";
  for (const ch of text) {
    if (width(out + ch) > max - 1) break;
    out += ch;
  }
  return `${out}…`;
}

const FLEX_MIN = 12;
const FLEX_LAST_RESORT = 6;
const GUTTER = "  ";

/**
 * columns: [{ header, flexible?, drop? }]; rows: arrays of cells, each a
 * string or { text, paint(text) }. Fitted to the terminal like the original:
 * flexible columns shrink first, then droppable ones hide (lowest rank first).
 */
export function table(columns, rows) {
  const cells = rows.map((row) => row.map((c) => (typeof c === "object" && c !== null
    ? { text: singleLine(c.text), paint: c.paint }
    : { text: singleLine(c ?? "") })));
  const natural = columns.map((col, i) => Math.max(width(col.header), ...cells.map((r) => width(r[i].text))));
  const widths = [...natural];
  const total = () => widths.reduce((sum, w, i) => sum + (w === null ? 0 : w + (i ? GUTTER.length : 0)), 0);
  const available = tty() ? process.stdout.columns || 0 : 0;
  if (available) {
    const shrink = (floor) => {
      while (total() > available) {
        let widest = -1;
        columns.forEach((col, i) => {
          if (col.flexible && widths[i] !== null && widths[i] > Math.min(floor, natural[i])
            && (widest < 0 || widths[i] > widths[widest])) widest = i;
        });
        if (widest < 0) return;
        widths[widest] -= 1;
      }
    };
    shrink(FLEX_MIN);
    const droppable = columns.map((c, i) => [c.drop, i]).filter(([d]) => d !== undefined).sort((a, b) => a[0] - b[0]);
    for (const [, i] of droppable) {
      if (total() <= available) break;
      widths[i] = null;
      for (let j = 0; j < widths.length; j++) if (widths[j] !== null && columns[j].flexible) widths[j] = natural[j];
      shrink(FLEX_MIN);
    }
    shrink(FLEX_LAST_RESORT);
  }
  const lines = [];
  const header = columns.map((c) => ({ text: c.header, paint: heading }));
  for (const row of [header, ...cells]) {
    const parts = [];
    row.forEach((cell, i) => {
      if (widths[i] === null) return;
      const shown = cut(cell.text, widths[i]);
      const padded = i === row.length - 1 || widths.slice(i + 1).every((w) => w === null)
        ? shown
        : shown + " ".repeat(Math.max(0, widths[i] - width(shown)));
      const painted = cell.paint ? cell.paint(shown) + padded.slice(shown.length) : padded;
      parts.push(painted);
    });
    lines.push(parts.join(GUTTER).replace(/\s+$/, ""));
  }
  return `${lines.join("\n")}\n`;
}

export function priorityGlyph(value) {
  switch (Number(value ?? 0)) {
    case 0: return "---";
    case 1: return "⚠⚠⚠";
    case 2: return "▄▆█";
    case 3: return "▄▆ ";
    case 4: return "▄  ";
    default: return String(value);
  }
}

export const PRIORITY_NAMES = ["No priority", "Urgent", "High", "Medium", "Low"];

export function parsePriority(value) {
  if (value === undefined) return undefined;
  const v = String(value).trim().toLowerCase();
  const names = { none: 0, "no priority": 0, urgent: 1, high: 2, medium: 3, normal: 3, low: 4 };
  if (v in names) return names[v];
  if (/^[0-4]$/.test(v)) return Number(v);
  const error = new Error(`invalid priority "${value}": use 0-4 or none, urgent, high, medium, low`);
  error.usage = true;
  throw error;
}

function localDate(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** "5 minutes ago" for the last week, the local date after that. */
export function ago(value, now = new Date()) {
  if (!value) return "-";
  const then = new Date(value);
  if (Number.isNaN(then.getTime())) return String(value);
  const minutes = Math.floor((now - then) / 60000);
  const count = (n, unit) => `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  if (minutes < 1) return "just now";
  if (minutes < 60) return count(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return count(hours, "hour");
  const days = Math.floor(hours / 24);
  if (days < 7) return count(days, "day");
  return localDate(then);
}

export function day(value) {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : localDate(d);
}

/** `✓ Created issue ENG-1: Title` and the URL on its own line. */
export function done(verb, entity, label, url) {
  let out = `✓ ${verb} ${entity} ${singleLine(label)}\n`;
  if (url) out += `${singleLine(url)}\n`;
  return out;
}

export function print(text) {
  process.stdout.write(text);
}

export function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Shows long terminal output through $PAGER (less by default). */
export function page(text, paging = true) {
  const rows = process.stdout.rows || 0;
  if (!paging || !tty() || !rows || text.split("\n").length < rows) {
    print(text);
    return;
  }
  const pager = process.env.PAGER || "less";
  const result = spawnSync(pager, [], {
    input: text,
    stdio: ["pipe", "inherit", "inherit"],
    shell: true,
    env: { LESS: "FRX", ...process.env },
  });
  if (result.error || result.status === 127) print(text);
}

/** Light terminal rendering of Markdown: headings, bold, inline code. */
export function renderMarkdown(text) {
  if (!color()) return text;
  let fence = false;
  return text.split("\n").map((line) => {
    if (/^\s*```/.test(line)) {
      fence = !fence;
      return gray(line);
    }
    if (fence) return line;
    if (/^#{1,6}\s/.test(line)) return bold(line.replace(/^#{1,6}\s+/, ""));
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) return gray("─".repeat(Math.min(process.stdout.columns || 40, 40)));
    return line
      .replace(/\*\*([^*]+)\*\*/g, (_, t) => bold(t))
      .replace(/`([^`]+)`/g, (_, t) => yellow(t));
  }).join("\n");
}
