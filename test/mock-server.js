#!/usr/bin/env node
// A stdio MCP server that behaves like Linear's hosted MCP server, for tests.
// Every tool call is appended to $MOCK_LOG as one JSON line.
import fs from "node:fs";
import readline from "node:readline";

const log = (entry) => process.env.MOCK_LOG && fs.appendFileSync(process.env.MOCK_LOG, `${JSON.stringify(entry)}\n`);
const old = "2024-01-01T00:00:00.000Z";
const teams = [
  { id: "team-eng", key: "ENG", name: "Engineering", createdAt: old, updatedAt: old },
  { id: "team-ops", key: "OPS", name: "Operations", createdAt: old, updatedAt: old },
];
const statuses = [
  { id: "s-backlog", type: "backlog", name: "Backlog" },
  { id: "s-todo", type: "unstarted", name: "Todo" },
  { id: "s-prog", type: "started", name: "In Progress" },
  { id: "s-done", type: "completed", name: "Done" },
];
const issue = (n, extra = {}) => ({
  id: `uuid-${n}`, identifier: `ENG-${n}`, title: `Issue ${n} title`,
  description: n === 1 ? "## Body\n\nPlain **bold** text." : "",
  priority: { value: n % 5, name: ["No priority", "Urgent", "High", "Medium", "Low"][n % 5] },
  url: `https://linear.app/acme/issue/ENG-${n}/issue-${n}-title`,
  gitBranchName: `eng-${n}-issue-${n}-title`,
  createdAt: old, updatedAt: old, status: "Todo", labels: n === 1 ? ["Bug"] : [],
  assignee: "Alice Example", assigneeId: "user-alice", createdBy: "Sam Example",
  project: n === 1 ? "Launch" : undefined, team: "Engineering", teamId: "team-eng",
  ...extra,
});
const issues = [issue(1), issue(2, { status: "In Progress" }), issue(3)];
const comments = [
  { id: "c-root", body: "Root comment body", createdAt: old, author: { name: "Alice Example" } },
  { id: "c-reply", body: "Reply body", createdAt: old, author: { name: "Bob" }, parentId: "c-root" },
];

const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });
const fail = (message) => ({ content: [{ type: "text", text: message }], isError: true });

const tools = {
  list_teams: () => ({ teams }),
  list_issue_statuses: () => statuses,
  get_user: ({ query }) => (query === "me" ? { id: "user-alice", name: "Alice Example", email: "alice@example.com" } : fail("User not found")),
  list_users: () => [{ id: "user-alice", name: "Alice Example", displayName: "alice", email: "alice@example.com", active: true }],
  list_issues: (args) => {
    let list = issues;
    if (args.query) list = list.filter((i) => i.title.includes(args.query));
    if (args.state === "started") list = list.filter((i) => i.status === "In Progress");
    if (args.state === "unstarted") list = list.filter((i) => i.status === "Todo");
    const start = args.cursor ? Number(args.cursor) : 0;
    const limit = args.limit ?? 50;
    const page = list.slice(start, start + limit);
    const more = start + limit < list.length;
    return { issues: page, hasNextPage: more, ...(more ? { cursor: String(start + limit) } : {}) };
  },
  get_issue: ({ id }) => issues.find((i) => i.identifier === id || i.id === id) ?? fail(`Entity not found: Issue - Could not find referenced Issue.`),
  list_comments: ({ issueId }) => (issueId === "ENG-1" || issueId === "uuid-1" ? { comments } : { comments: [] }),
  save_issue: (args) => {
    if (args.id) {
      const found = issues.find((i) => i.identifier === args.id);
      if (!found) return fail("Entity not found: Issue");
      return { ...found, ...(args.title ? { title: args.title } : {}), ...(args.state ? { status: args.state } : {}) };
    }
    if (!args.title || !args.team) return fail("title and team are required");
    return issue(99, { title: args.title });
  },
  create_comment: (args) => ({ id: "c-new", body: args.body, url: "https://linear.app/acme/issue/ENG-1#comment-c-new" }),
  list_projects: () => ({ projects: [{ id: "p-1", name: "Launch", status: { name: "Started" }, url: "https://linear.app/acme/project/launch-272f50ef9250", targetDate: "2026-12-01", lead: { name: "Alice Example" }, teams: [{ key: "ENG", name: "Engineering" }] }] }),
  list_cycles: () => [{ id: "cy-7", number: 7, name: "Sprint 7", startsAt: "2026-11-10T00:00:00.000Z", endsAt: "2099-11-24T00:00:00.000Z" }],
};

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    respond(message.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "mock-linear", version: "0" } });
  } else if (message.method === "tools/list") {
    respond(message.id, { tools: Object.keys(tools).map((name) => ({ name, description: `mock ${name}`, inputSchema: { type: "object" } })) });
  } else if (message.method === "tools/call") {
    const { name, arguments: args } = message.params;
    log({ name, args });
    if (!tools[name]) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: `Unknown tool: ${name}` } })}\n`);
      return;
    }
    const value = tools[name](args ?? {});
    respond(message.id, value && value.isError ? value : text(value));
  } else if (message.id !== undefined) {
    respond(message.id, {});
  }
});
