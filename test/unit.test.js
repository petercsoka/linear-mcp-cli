import { test } from "node:test";
import assert from "node:assert/strict";
import { splitCommand, unwrapResult, isUnknownTool, toolError } from "../src/mcp.js";
import { normIssue, items, nextCursor } from "../src/linear.js";
import { ago, priorityGlyph, parsePriority } from "../src/format.js";
import { parseIssueRef } from "../src/commands/issue.js";
import { issueIdFromBranch } from "../src/vcs.js";
import { parseToml } from "../src/config.js";

test("splitCommand honours quotes", () => {
  assert.deepEqual(splitCommand("npx -y mcp-remote https://mcp.linear.app/mcp"), ["npx", "-y", "mcp-remote", "https://mcp.linear.app/mcp"]);
  assert.deepEqual(splitCommand(`node "/a b/s.js" --x 'y z'`), ["node", "/a b/s.js", "--x", "y z"]);
});

test("unwrapResult parses JSON text content and raises tool errors", () => {
  assert.deepEqual(unwrapResult({ content: [{ type: "text", text: '{"a":1}' }] }), { a: 1 });
  assert.equal(unwrapResult({ content: [{ type: "text", text: "plain" }] }), "plain");
  assert.throws(() => unwrapResult({ content: [{ type: "text", text: "Entity not found" }], isError: true }), (e) => e.code === 3);
  assert.equal(toolError("401 Unauthorized").code, 4);
  assert.ok(isUnknownTool(new Error("Unknown tool: delete_issue")));
});

test("normIssue accepts string and object shapes", () => {
  const a = normIssue({ id: "u", identifier: "ENG-1", title: "T", status: "Todo", priority: { value: 2, name: "High" }, assignee: "Jane Doe", labels: ["Bug"], gitBranchName: "b" });
  assert.equal(a.state.name, "Todo");
  assert.equal(a.priority, 2);
  assert.equal(a.assignee.initials, "JD");
  assert.equal(a.team.key, "ENG");
  assert.equal(a.branchName, "b");
  const b = normIssue({ identifier: "OPS-2", state: { name: "Done", type: "completed" }, priority: 4, labels: { nodes: [{ name: "x", color: "#fff" }] } });
  assert.equal(b.state.type, "completed");
  assert.equal(b.priorityLabel, "Low");
  assert.equal(b.labels.nodes[0].name, "x");
});

test("items and nextCursor find lists and cursors", () => {
  assert.equal(items({ issues: [1, 2] }, "issues").length, 2);
  assert.equal(items({ issues: { nodes: [1] } }, "issues").length, 1);
  assert.equal(nextCursor({ hasNextPage: true, cursor: "c" }), "c");
  assert.equal(nextCursor({ pageInfo: { hasNextPage: false, endCursor: "c" } }), null);
});

test("formatting helpers match the original CLI", () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(priorityGlyph), ["---", "⚠⚠⚠", "▄▆█", "▄▆ ", "▄  "]);
  assert.equal(parsePriority("urgent"), 1);
  const now = new Date("2026-09-25T12:00:00Z");
  assert.equal(ago("2026-09-25T11:58:00Z", now), "2 minutes ago");
  assert.equal(ago("2026-09-24T12:00:00Z", now), "1 day ago");
  assert.equal(ago("2026-09-25T11:00:00Z", now), "1 hour ago");
});

test("issue references", () => {
  assert.equal(parseIssueRef("eng-12"), "ENG-12");
  assert.equal(parseIssueRef("12", "ENG"), "ENG-12");
  assert.equal(parseIssueRef("https://linear.app/acme/issue/ENG-7/some-title"), "ENG-7");
  assert.equal(issueIdFromBranch("feature/eng-123-my-feature"), "ENG-123");
  assert.equal(issueIdFromBranch("main"), null);
});

test("toml subset", () => {
  assert.deepEqual(parseToml('team_id = "ENG"\n# c\nvcs = \'jj\'\ndownload_images = false\n', "x"), { team_id: "ENG", vcs: "jj", download_images: false });
});
