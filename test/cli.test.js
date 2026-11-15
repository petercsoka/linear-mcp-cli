// End-to-end tests: the real CLI against a mock Linear MCP server, over both
// transports (the `mcp` CLI shell-out and direct stdio).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(here, "..", "bin", "linear.js");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "linear-mcp-cli-test-"));

function run(args, { transport = "stdio", env = {}, cwd = tmp } = {}) {
  const log = path.join(tmp, `calls-${Math.random().toString(36).slice(2)}.log`);
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: tmp,
      XDG_CONFIG_HOME: path.join(tmp, "config"),
      XDG_CACHE_HOME: path.join(tmp, "cache"),
      LINEAR_NO_CACHE: "1",
      LINEAR_IGNORE_ENV_FILE: "1",
      LINEAR_TEAM_ID: "ENG",
      LINEAR_MCP_SERVER: `${process.execPath} ${path.join(here, "mock-server.js")}`,
      LINEAR_MCP_TRANSPORT: transport,
      LINEAR_MCP_COMMAND: `${process.execPath} ${path.join(here, "fake-mcp.js")}`,
      MOCK_LOG: log,
      FAKE_MCP_LOG: `${log}.mcp`,
      ...env,
    },
  });
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { ...result, calls: read(log), mcpArgv: read(`${log}.mcp`) };
}

for (const transport of ["mcp", "stdio"]) {
  test(`[${transport}] issue list lists my unstarted issues in the configured team`, () => {
    const r = run(["issue", "list"], { transport });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^◌\s+ID\s+TITLE/);
    assert.match(r.stdout, /ENG-1\s+Issue 1 title\s+Bug\s+Todo/);
    assert.doesNotMatch(r.stdout, /ENG-2/);
    assert.deepEqual(r.calls, [{ name: "list_issues", args: { assignee: "me", team: "ENG", state: "unstarted", limit: 50 } }]);
  });

  test(`[${transport}] issue view renders the issue and its comments`, () => {
    const r = run(["issue", "view", "ENG-1"], { transport });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.startsWith("# ENG-1: Issue 1 title\n\n**State:** Todo\n**Priority:** ⚠⚠⚠\n**Assignee:** @Alice Example\n"), r.stdout);
    assert.match(r.stdout, /## Comments/);
    assert.match(r.stdout, /Root comment body/);
    assert.match(r.stdout, /Reply body/);
  });
}

test("the mcp transport runs `mcp call <tool> --params <json> -f json <server>`", () => {
  const r = run(["issue", "title", "ENG-1"], { transport: "mcp" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "Issue 1 title\n");
  const [argv] = r.mcpArgv;
  assert.deepEqual(argv.slice(0, 5), ["call", "get_issue", "--params", '{"id":"ENG-1"}', "-f"]);
  assert.equal(argv[5], "json");
  assert.match(argv.slice(6).join(" "), /mock-server\.js$/);
});

test("issue view --json prints the normalized issue", () => {
  const r = run(["issue", "view", "ENG-1", "--json", "--no-comments"]);
  const issue = JSON.parse(r.stdout);
  assert.equal(issue.identifier, "ENG-1");
  assert.equal(issue.priority, 1);
  assert.deepEqual(issue.state, { id: null, name: "Todo", type: "" });
  assert.equal(issue.team.key, "ENG");
  assert.deepEqual(issue.labels, { nodes: [{ name: "Bug" }] });
});

test("bare numbers use the configured team; unknown issues exit 3", () => {
  assert.equal(run(["issue", "url", "2"]).stdout, "https://linear.app/acme/issue/ENG-2/issue-2-title\n");
  const missing = run(["issue", "view", "ENG-404"]);
  assert.equal(missing.status, 3);
  assert.match(missing.stderr, /Issue not found: ENG-404/);
});

test("issue list --limit follows cursors", () => {
  const r = run(["issue", "query", "--all-teams", "--limit", "all", "--json"], { env: { LINEAR_TEAM_ID: "" } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).length, 3);
});

test("issue create and update call save_issue", () => {
  const created = run(["issue", "create", "-t", "New thing", "-p", "high", "-l", "Bug", "--no-input"]);
  assert.equal(created.status, 0, created.stderr);
  assert.equal(created.stdout, "✓ Created issue ENG-99: New thing\nhttps://linear.app/acme/issue/ENG-99/issue-99-title\n");
  assert.deepEqual(created.calls[0], { name: "save_issue", args: { team: "ENG", title: "New thing", priority: 2, labels: ["Bug"] } });

  const updated = run(["issue", "update", "ENG-2", "-s", "Done", "--clear-due-date"]);
  assert.equal(updated.status, 0, updated.stderr);
  assert.match(updated.stdout, /^✓ Updated issue ENG-2: Issue 2 title\n/);
  assert.deepEqual(updated.calls[0], { name: "save_issue", args: { id: "ENG-2", state: "Done", dueDate: null } });
});

test("usage errors exit 2 before any tool call", () => {
  for (const args of [["issue", "update", "ENG-2"], ["issue", "list", "--limit", "x"], ["issue", "view", "not an id"], ["isue"]]) {
    const r = run(args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.deepEqual(r.calls, []);
  }
});

test("comments: list and add", () => {
  const list = run(["issue", "comment", "list", "ENG-1"]);
  assert.match(list.stdout, /^@Alice Example commented 2024-01-01 \[c-root\]\nRoot comment body\n\n {2}@Bob replied/);
  const add = run(["issue", "comment", "add", "ENG-1", "--body", "hi"]);
  assert.equal(add.stdout, "✓ Added comment to issue ENG-1\nhttps://linear.app/acme/issue/ENG-1#comment-c-new\n");
  // save_comment is tried first; this server only has the older create_comment.
  assert.deepEqual(add.calls.map((c) => c.name), ["save_comment", "create_comment"]);
  assert.deepEqual(add.calls.at(-1).args, { issueId: "ENG-1", body: "hi" });
});

test("issue id, describe and start work from the git branch", () => {
  const repo = fs.mkdtempSync(path.join(tmp, "repo-"));
  const git = (...a) => spawnSync("git", a, { cwd: repo, encoding: "utf8" });
  git("init", "-q");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  const start = run(["issue", "start", "ENG-1"], { cwd: repo });
  assert.equal(start.status, 0, start.stderr);
  assert.equal(start.stdout, "Switched to a new branch 'eng-1-issue-1-title'\n✓ Issue state updated to 'In Progress'\n");
  assert.deepEqual(start.calls.at(-1), { name: "save_issue", args: { id: "ENG-1", state: "In Progress" } });
  assert.equal(run(["issue", "id"], { cwd: repo }).stdout, "ENG-1\n");
  assert.equal(
    run(["issue", "describe"], { cwd: repo }).stdout,
    "ENG-1 Issue 1 title\n\nLinear-issue: Fixes ENG-1\nLinear-issue-url: https://linear.app/acme/issue/ENG-1/issue-1-title\n",
  );
});

test("team, user, project and cycle lists", () => {
  assert.match(run(["team", "list"]).stdout, /^KEY\s+NAME\s+CYCLES\s+UPDATED\s+ID\nENG\s+Engineering/);
  assert.equal(run(["team", "id"]).stdout, "ENG\n");
  assert.match(run(["user", "list"]).stdout, /Alice Example\s+alice\s+alice@example.com/);
  assert.match(run(["project", "list"]).stdout, /272f50ef9250\s+Launch\s+Started/);
  const cycles = run(["cycle", "list"]);
  assert.match(cycles.stdout, /^#\s+NAME\s+START\s+END\s+STATUS\n7\s+Sprint 7/);
  assert.deepEqual(cycles.calls.at(-1), { name: "list_cycles", args: { teamId: "team-eng" } });
});

test("a missing tool is reported clearly", () => {
  const r = run(["issue", "delete", "ENG-1", "--yes"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no delete_issue tool/);
});

test("mcp call passes params through and prints the result", () => {
  const r = run(["mcp", "call", "list_issues", '{"assignee":"me","limit":1}']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).issues.length, 1);
  assert.deepEqual(r.calls, [{ name: "list_issues", args: { assignee: "me", limit: 1 } }]);
});

test("a server that cannot start is unavailable (exit 5)", () => {
  const r = run(["issue", "title", "ENG-1"], { env: { LINEAR_MCP_SERVER: "/nonexistent/server" } });
  assert.equal(r.status, 5, r.stderr);
});
