// Minimal interactive prompts on the terminal (stderr), no dependencies.
import readline from "node:readline";
import { CliError, EXIT } from "./errors.js";

export const interactive = (noInput) => !noInput && Boolean(process.stdin.isTTY && process.stderr.isTTY);

export function requireInteractive(noInput, what, flag) {
  if (!interactive(noInput)) {
    throw new CliError(`Missing ${what}${flag ? `: pass ${flag}` : ""}`, EXIT.usage);
  }
}

function ask(question) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    let answered = false;
    rl.on("SIGINT", () => {
      rl.close();
      reject(new CliError("Cancelled", EXIT.cancelled));
    });
    rl.on("close", () => {
      if (!answered) reject(new CliError("Cancelled", EXIT.cancelled));
    });
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      resolve(answer);
    });
  });
}

export async function input(message, { initial = "", required = false } = {}) {
  for (;;) {
    const answer = (await ask(`? ${message}${initial ? ` (${initial})` : ""} `)).trim() || initial;
    if (answer || !required) return answer;
  }
}

export async function confirm(message, initial = false) {
  const answer = (await ask(`? ${message} ${initial ? "(Y/n)" : "(y/N)"} `)).trim().toLowerCase();
  if (!answer) return initial;
  return answer === "y" || answer === "yes";
}

/** Numbered choice list; typing text filters it. */
export async function select(message, choices) {
  if (choices.length === 0) throw new CliError(`Nothing to choose for ${message}`, EXIT.notFound);
  let shown = choices;
  for (;;) {
    process.stderr.write(`? ${message}\n`);
    shown.slice(0, 30).forEach((choice, i) => process.stderr.write(`  ${String(i + 1).padStart(2)}) ${choice.label}\n`));
    if (shown.length > 30) process.stderr.write(`  … ${shown.length - 30} more; type to filter\n`);
    const answer = (await ask("  Number or filter: ")).trim();
    if (/^\d+$/.test(answer) && shown[Number(answer) - 1]) return shown[Number(answer) - 1].value;
    const filtered = choices.filter((c) => c.label.toLowerCase().includes(answer.toLowerCase()));
    if (filtered.length === 1) return filtered[0].value;
    shown = filtered.length ? filtered : choices;
  }
}
