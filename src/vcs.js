// git and jj: finding the current issue and preparing a branch or change.
import { execFileSync, spawnSync } from "node:child_process";
import { CliError, EXIT } from "./errors.js";

const ISSUE_IN_BRANCH = /(?:^|[^a-zA-Z0-9])([a-zA-Z][a-zA-Z0-9]{0,9}-[1-9][0-9]*)(?:$|[^0-9])/;

export function run(cmd, args, { allowFail = false } = {}) {
  try {
    return execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }).toString();
  } catch (error) {
    if (allowFail) return null;
    const stderr = error.stderr?.toString().trim();
    throw new CliError(`${cmd} ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
  }
}

export function issueIdFromBranch(branch) {
  const m = ISSUE_IN_BRANCH.exec(branch ?? "");
  return m ? m[1].toUpperCase() : null;
}

export function currentBranch() {
  return run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { allowFail: true })?.trim() || null;
}

export function issueIdFromJj() {
  const out = run("jj", ["log", "--no-graph", "-r", "::@", "-n", "20", "-T", 'description ++ "\\x00"'], { allowFail: true });
  if (!out) return null;
  for (const description of out.split("\0")) {
    const m = /^Linear-issue:\s*(?:(?:Fixes|References|Closes|Part of|Related to)\s+)?([A-Za-z0-9]+-\d+)/im.exec(description);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

export function currentIssueId(vcs) {
  return vcs === "jj" ? issueIdFromJj() : issueIdFromBranch(currentBranch());
}

export function gitBranchExists(branch) {
  return spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).status === 0;
}

export function gitSwitch(branch) {
  run("git", ["switch", branch]);
  return `Switched to branch '${branch}'\n`;
}

export function gitCreate(branch, fromRef) {
  run("git", ["switch", "-c", branch, ...(fromRef ? [fromRef] : [])]);
  return `Switched to a new branch '${branch}'\n`;
}

export function freeSuffix(branch) {
  for (let n = 1; n < 1000; n++) {
    const candidate = `${branch}-${n}`;
    if (!gitBranchExists(candidate)) return candidate;
  }
  throw new CliError(`No free branch name like ${branch}-N`);
}

export function jjDescribe(identifier, title, url) {
  const current = run("jj", ["log", "--no-graph", "-r", "@", "-T", 'if(empty && description == "", "fresh", "used")']).trim();
  if (current !== "fresh") run("jj", ["new"]);
  const message = describeText(identifier, title, url, false);
  run("jj", ["describe", "-m", message]);
  return `Described the working-copy change as ${identifier} ${title}\n`;
}

export function describeText(identifier, title, url, references) {
  const magic = references ? "References" : "Fixes";
  return `${identifier} ${title}\n\nLinear-issue: ${magic} ${identifier}\nLinear-issue-url: ${url}\n`;
}

export function requireTool(cmd) {
  if (spawnSync(cmd, ["--version"], { stdio: "ignore" }).error) {
    throw new CliError(`\`${cmd}\` is not installed or not on PATH`, EXIT.failure);
  }
}
