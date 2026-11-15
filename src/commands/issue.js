// `linear issue …`
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { CliError, EXIT, usage, notFound } from "../errors.js";
import {
  ago, bold, day, done, gray, green, hex, page, parsePriority, print, printJson, priorityGlyph,
  renderMarkdown, singleLine, table, tty,
} from "../format.js";
import { TOOLS, teamKeyOf, normComment, one } from "../linear.js";
import * as vcs from "../vcs.js";
import { confirm, input, interactive, requireInteractive, select } from "../prompt.js";
import { openUrl, parseLimit, readText, issueLimitOption } from "./common.js";

// ---------------------------------------------------------------- refs

/** ENG-123, 123 (with a team), or an issue URL → ENG-123. */
export function parseIssueRef(ref, teamKey) {
  const value = String(ref).trim();
  const url = /linear\.app\/[^/]+\/issue\/([A-Za-z0-9]+-\d+)/i.exec(value);
  if (url) return url[1].toUpperCase();
  if (/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(value)) return value.toUpperCase();
  if (/^\d+$/.test(value)) {
    if (!teamKey) throw usage(`Cannot resolve issue number ${value} without a team`, "Pass a full ID like ENG-123, or configure a team with `linear config`.");
    return `${teamKey.toUpperCase()}-${value}`;
  }
  throw usage(`Invalid issue ID: ${value}`, "Use an ID like ENG-123, a number with a configured team, or an issue URL.");
}

function configuredTeamKey(ctx) {
  const team = ctx.config.team_id;
  return team && /^[A-Za-z][A-Za-z0-9]*$/.test(team) ? team : null;
}

export function resolveIssueId(ctx, ref) {
  if (ref) return parseIssueRef(ref, configuredTeamKey(ctx));
  const id = vcs.currentIssueId(ctx.config.vcs);
  if (!id) {
    throw usage(
      "No issue ID given, and none found in the current " + (ctx.config.vcs === "jj" ? "jj change" : "git branch"),
      "Pass an issue ID like ENG-123.",
    );
  }
  return id;
}

// ---------------------------------------------------------------- filters

function userParam(value) {
  if (value === undefined) return undefined;
  const v = String(value).trim();
  if (/^https?:\/\//.test(v)) throw usage(`Pass a user's name, email, or @me, not a URL: ${v}`);
  if (/^@?(me|self)$/i.test(v)) return "me";
  return v.replace(/^@/, "");
}

const STATE_TYPES = ["triage", "backlog", "unstarted", "started", "completed", "canceled"];

function dateParam(value, flag) {
  if (value === undefined) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00.000Z`;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw usage(`invalid value '${value}' for '${flag}': use YYYY-MM-DD or RFC 3339`);
  return d.toISOString();
}

function cycleParam(value) {
  if (value === undefined) return undefined;
  const v = String(value).trim().toLowerCase();
  if (v === "active" || v === "current" || v === "now") return "current";
  if (v === "next" || v === "+1") return "next";
  if (v === "previous" || v === "prev" || v === "-1") return "previous";
  if (/^linear\.app|^https?:/.test(v) && !/\/cycle\//.test(v)) throw usage(`Not a cycle URL: ${value}`);
  return value;
}

async function filterParams(ctx, o) {
  const params = {};
  if (o.unassigned) params.assignee = null;
  else if (o.assignee !== undefined) params.assignee = userParam(o.assignee);
  if (o.project) params.project = o.project;
  if (o.milestone) params.milestone = o.milestone;
  if (o.cycle) params.cycle = cycleParam(o.cycle);
  if (o.label.length) params.label = o.label[0];
  if (o.projectLabel) params.projectLabel = o.projectLabel;
  if (o.createdAfter) params.createdAt = dateParam(o.createdAfter, "--created-after");
  if (o.updatedAfter) params.updatedAt = dateParam(o.updatedAfter, "--updated-after");
  if (o.includeArchived) params.includeArchived = true;
  return params;
}

function stateOrder(issue) {
  const index = STATE_TYPES.indexOf(issue.state.type);
  return index < 0 ? STATE_TYPES.length : index;
}

/** Workflow-state type first, then priority (urgent first, none last). */
export function sortIssues(issues, sort) {
  if (sort === "manual") return issues;
  const p = (i) => (i.priority === 0 ? 5 : i.priority);
  return [...issues].sort((a, b) => stateOrder(a) - stateOrder(b) || p(a) - p(b));
}

async function fetchIssues(ctx, { teams, states, params, limit, labels }) {
  const linear = ctx.linear();
  const teamList = teams.length ? teams : [undefined];
  const stateList = states.length ? states : [undefined];
  const all = [];
  const seen = new Set();
  for (const team of teamList) {
    for (const state of stateList) {
      const page = await linear.issues({ ...params, team, state }, limit);
      for (const issue of page) {
        if (state && STATE_TYPES.includes(state) && !issue.state.type) issue.state.type = state;
        if (!seen.has(issue.identifier)) {
          seen.add(issue.identifier);
          all.push(issue);
        }
      }
    }
  }
  // The MCP gives a state's name but not its type; sorting by workflow
  // (backlog → started → done) needs the type, so look the team's up.
  if (states.length !== 1 && all.some((i) => !i.state.type)) {
    const byTeam = new Map();
    for (const issue of all) byTeam.set(issue.team.id ?? issue.team.key, null);
    for (const team of byTeam.keys()) {
      if (!team) continue;
      try {
        byTeam.set(team, await linear.statuses(team));
      } catch {
        /* sorting falls back to priority alone */
      }
    }
    for (const issue of all) {
      const found = byTeam.get(issue.team.id ?? issue.team.key)?.find((s) => s.name === issue.state.name);
      if (found) issue.state = { ...issue.state, type: issue.state.type || found.type, color: issue.state.color ?? found.color };
    }
  }
  const wanted = labels.map((l) => l.toLowerCase());
  const filtered = wanted.length > 1
    ? all.filter((i) => wanted.every((w) => i.labels.nodes.some((l) => l.name.toLowerCase() === w)))
    : all;
  return Number.isFinite(limit) ? filtered.slice(0, limit) : filtered;
}

function cycleShort(cycle) {
  if (!cycle) return { text: "-", paint: gray };
  if (cycle.isActive) return { text: "now", paint: green };
  if (cycle.isNext) return { text: "+1" };
  if (cycle.isPrevious) return { text: "-1", paint: gray };
  if (cycle.number !== null && cycle.number !== undefined) return { text: `#${cycle.number}` };
  return { text: cycle.name ?? "-" };
}

export function issueTable(rows, { team = false, assignee = false } = {}) {
  const showCycle = rows.some((r) => r.cycle);
  const showEstimate = rows.some((r) => r.estimate !== null && r.estimate !== undefined);
  const columns = [{ header: "◌" }, { header: "ID" }];
  if (team) columns.push({ header: "TEAM", drop: 6 });
  columns.push({ header: "TITLE", flexible: true }, { header: "LABELS", flexible: true, drop: 2 });
  if (showEstimate) columns.push({ header: "E", drop: 4 });
  if (showCycle) columns.push({ header: "CYC", drop: 3 });
  if (assignee) columns.push({ header: "A" });
  columns.push({ header: "STATE" }, { header: "UPDATED", drop: 1 });
  const body = rows.map((r) => {
    const cells = [priorityGlyph(r.priority), r.identifier];
    if (team) cells.push(r.team.key ?? "");
    cells.push(r.title, r.labels.nodes.map((l) => l.name).join(", "));
    if (showEstimate) cells.push(r.estimate === null || r.estimate === undefined ? "-" : String(r.estimate));
    if (showCycle) cells.push(cycleShort(r.cycle));
    if (assignee) cells.push((r.assignee?.initials || "-").slice(0, 2));
    cells.push({ text: r.state.name, paint: (t) => hex(t, r.state.color) });
    cells.push({ text: ago(r.updatedAt), paint: gray });
    return cells;
  });
  return table(columns, body);
}

function printIssues(issues, o, layout) {
  if (o.json) return printJson(issues);
  if (issues.length === 0) return print("No issues found.\n");
  page(issueTable(issues, layout), !o.noPager);
}

function workspace(ctx, issue) {
  if (ctx.workspace) return ctx.workspace;
  const m = /linear\.app\/([^/]+)\//.exec(issue?.url ?? "");
  if (m) return m[1];
  throw usage("No workspace configured", "Pass --workspace or set `workspace` with `linear config` to open Linear URLs.");
}

// ---------------------------------------------------------------- commands

async function list(ctx, o) {
  const teamRef = o.team ?? ctx.config.team_id;
  if (!teamRef) throw usage("No team given", "Pass --team, set LINEAR_TEAM_ID, or run `linear config`.");
  if (o.web || o.app) {
    const ws = workspace(ctx);
    const key = /^[A-Za-z0-9]+$/.test(teamRef) ? teamRef.toUpperCase() : (await ctx.linear().team(teamRef)).key;
    const suffix = o.allAssignees ? "" : "?filter=assigned-to-me";
    return openUrl(`https://linear.app/${ws}/team/${key}/active${suffix}`, o.app);
  }
  const params = await filterParams(ctx, o);
  if (!o.allAssignees && !o.unassigned && o.assignee === undefined) params.assignee = "me";
  const states = o.allStates ? [] : o.state;
  const issues = await fetchIssues(ctx, {
    teams: [teamRef], states, params, limit: parseLimit(o.limit), labels: o.label,
  });
  const showAssignee = o.allAssignees || (params.assignee && params.assignee !== "me");
  printIssues(sortIssues(issues, o.sort ?? ctx.config.issue_sort), o, { assignee: Boolean(showAssignee) });
}

async function query(ctx, o) {
  if (o.searchComments && !o.search) throw usage("--search-comments requires --search");
  if (o.search && o.sort) throw usage("the argument '--search' cannot be used with '--sort'");
  const params = await filterParams(ctx, o);
  if (o.search) params.query = o.search;
  if (o.searchComments) params.includeComments = true;
  let teams = o.allTeams ? [] : o.team;
  if (!o.allTeams && teams.length === 0 && ctx.config.team_id) teams = [ctx.config.team_id];
  const states = o.allStates ? [] : o.state;
  const issues = await fetchIssues(ctx, { teams, states, params, limit: parseLimit(o.limit), labels: o.label });
  const ordered = o.search ? issues : sortIssues(issues, o.sort ?? ctx.config.issue_sort);
  const multiTeam = new Set(ordered.map((i) => i.team.key)).size > 1 || teams.length !== 1;
  printIssues(ordered, o, { team: multiTeam, assignee: true });
}

function userName(u) {
  return u ? (u.displayName || u.name || null) : null;
}

export function issueMarkdown(issue, { showResolved = false } = {}) {
  const parts = [`**State:** ${issue.state.name}`, `**Priority:** ${priorityGlyph(issue.priority)}`];
  parts.push(`**Assignee:** ${userName(issue.assignee) ? `@${userName(issue.assignee)}` : "Unassigned"}`);
  if (userName(issue.delegate)) parts.push(`**Delegate:** @${userName(issue.delegate)}`);
  if (issue.project?.name) parts.push(`**Project:** ${issue.project.name}`);
  if (issue.projectMilestone?.name) parts.push(`**Milestone:** ${issue.projectMilestone.name}`);
  if (issue.cycle) {
    const c = issue.cycle;
    const label = c.number !== null && c.number !== undefined ? `#${c.number}${c.name ? ` ${c.name}` : ""}` : c.name;
    const short = cycleShort(c).text;
    parts.push(`**Cycle:** ${label}${short !== "-" && !short.startsWith("#") ? ` (${short})` : ""}`);
  }
  if (issue.labels.nodes.length) parts.push(`**Labels:** ${issue.labels.nodes.map((l) => l.name).join(", ")}`);
  if (issue.dueDate) parts.push(`**Due:** ${day(issue.dueDate)}`);
  if (issue.estimate !== null && issue.estimate !== undefined) parts.push(`**Estimate:** ${issue.estimate}`);
  if (userName(issue.creator)) parts.push(`**Creator:** @${userName(issue.creator)}`);
  if (issue.createdAt) parts.push(`**Created:** ${ago(issue.createdAt)}`);
  if (issue.updatedAt) parts.push(`**Updated:** ${ago(issue.updatedAt)}`);
  let out = `# ${issue.identifier}: ${issue.title}\n\n${parts.join("\n")}`;
  if (issue.description) out += `\n\n${issue.description}`;
  if (issue.parent) {
    const p = issue.parent;
    out += `\n\n## Parent\n\n- **${p.identifier}**${p.title ? `: ${p.title}` : ""}${p.state?.name ? ` _[${p.state.name}]_` : ""}\n`;
  }
  if (issue.children.nodes.length) {
    out += "\n\n## Sub-issues\n\n";
    for (const c of issue.children.nodes) {
      out += `- **${c.identifier}**${c.title ? `: ${c.title}` : ""}${c.state?.name ? ` _[${c.state.name}]_` : ""}\n`;
    }
  }
  if (issue.attachments.nodes.length) {
    out += "\n\n## Attachments\n\n";
    for (const a of issue.attachments.nodes) {
      out += `- **${a.title ?? a.url}**: ${a.url}${a.sourceType ? ` _[${a.sourceType}]_` : ""}\n`;
      if (a.subtitle) out += `  _${a.subtitle}_\n`;
    }
  }
  if (issue.documents.nodes.length) {
    out += "\n\n## Documents\n\n";
    for (const d of issue.documents.nodes) out += `- **${d.title}**: ${d.url}\n`;
  }
  const comments = issue.comments?.nodes ?? [];
  const resolvedRoots = new Set(comments.filter((c) => !c.parent && c.resolvedAt).map((c) => c.id));
  const roots = comments.filter((c) => !c.parent).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const shownRoots = roots.filter((c) => showResolved || !resolvedRoots.has(c.id));
  if (shownRoots.length) {
    out += "\n\n## Comments\n\n";
    for (const root of shownRoots) {
      const resolved = root.resolvedAt ? " [resolved]" : "";
      out += `- **@${userName(root.user) ?? "unknown"}** commented *${ago(root.createdAt)}* [${root.id}]${resolved}\n\n  ${root.body.replace(/\n/g, "\n  ")}\n\n`;
      for (const reply of comments.filter((c) => c.parent?.id === root.id)) {
        out += `  - **@${userName(reply.user) ?? "unknown"}** replied *${ago(reply.createdAt)}*\n\n    ${reply.body.replace(/\n/g, "\n    ")}\n\n`;
      }
    }
  }
  const hidden = roots.length - shownRoots.length;
  if (hidden > 0) out += `\n\nResolved ${hidden === 1 ? "thread" : "threads"} hidden: ${hidden}. Use --show-resolved-threads to show them.`;
  return out;
}

function forTerminal(markdown) {
  return renderMarkdown(markdown.replace(/^\*\*([A-Za-z ]+):\*\* /gm, "$1: "));
}

async function view(ctx, o, a) {
  const ids = a.issueIds.length ? a.issueIds.map((r) => resolveIssueId(ctx, r)) : [resolveIssueId(ctx)];
  if (o.web || o.app) {
    for (const id of ids) {
      const ws = ctx.workspace ?? workspace(ctx, await ctx.linear().issue(id));
      openUrl(`https://linear.app/${ws}/issue/${id}`, o.app);
    }
    return;
  }
  const linear = ctx.linear();
  const issues = [];
  for (const id of ids) {
    const issue = await linear.issue(id);
    if (!o.noComments && issue.comments === undefined) {
      issue.comments = { nodes: await linear.comments(issue.id ?? id) };
    }
    issues.push(issue);
  }
  if (o.json) return printJson(issues.length === 1 ? issues[0] : issues);
  const views = issues.map((i) => issueMarkdown(i, { showResolved: o.showResolvedThreads }));
  if (!tty()) return print(`${views.join("\n\n---\n\n")}\n`);
  const rendered = views.map((v, n) => `${forTerminal(v)}\n\n${gray(issues[n].url ?? "")}`);
  page(`${rendered.join(`\n\n${gray("─".repeat(40))}\n\n`)}\n`, !o.noPager);
}

async function id(ctx) {
  const value = vcs.currentIssueId(ctx.config.vcs);
  if (!value) throw notFound("No issue ID found in the current " + (ctx.config.vcs === "jj" ? "jj change" : "git branch"));
  print(`${value}\n`);
}

async function title(ctx, o, a) {
  const issue = await ctx.linear().issue(resolveIssueId(ctx, a.issue));
  print(`${tty() ? singleLine(issue.title) : issue.title}\n`);
}

async function url(ctx, o, a) {
  const issue = await ctx.linear().issue(resolveIssueId(ctx, a.issue));
  print(`${issue.url}\n`);
}

async function describe(ctx, o, a) {
  const identifier = resolveIssueId(ctx, a.issue);
  const issue = await ctx.linear().issue(identifier);
  print(vcs.describeText(identifier, tty() ? singleLine(issue.title) : issue.title, issue.url, o.references));
}

async function startedState(ctx, teamRef) {
  const statuses = await ctx.linear().statuses(teamRef);
  const started = statuses.filter((s) => s.type === "started")
    .sort((x, y) => (x.position ?? 0) - (y.position ?? 0));
  if (!started.length) throw notFound(`Team ${teamRef} has no started workflow state`);
  return started[0].name;
}

async function start(ctx, o, a) {
  const linear = ctx.linear();
  let identifier;
  if (a.issue) identifier = parseIssueRef(a.issue, o.team ?? configuredTeamKey(ctx));
  else {
    requireInteractive(ctx.noInput, "an issue to start", "an issue ID");
    const team = o.team ?? ctx.config.team_id;
    const params = { team, state: "unstarted" };
    if (o.unassigned) params.assignee = null;
    else if (!o.allAssignees) params.assignee = "me";
    const candidates = sortIssues(await linear.issues(params, 100));
    identifier = await select("Which issue do you want to start?", candidates.map((i) => ({
      label: `${i.identifier}: ${i.title}`, value: i.identifier,
    })));
  }
  const issue = await linear.issue(identifier);
  let output;
  if (ctx.config.vcs === "jj") {
    output = vcs.jjDescribe(identifier, issue.title, issue.url);
  } else {
    const branch = o.branch || issue.branchName || `${identifier.toLowerCase()}-${issue.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)}`;
    if (vcs.gitBranchExists(branch)) {
      requireInteractive(ctx.noInput, "what to do with the existing branch", "--branch with a new name");
      process.stderr.write(`Branch ${branch} already exists.\n`);
      const choice = await select("Existing branch:", [
        { label: "Switch to it", value: "switch" },
        { label: "Create a new branch with a suffix", value: "suffix" },
      ]);
      output = choice === "switch" ? vcs.gitSwitch(branch) : vcs.gitCreate(vcs.freeSuffix(branch), o.fromRef);
    } else {
      output = vcs.gitCreate(branch, o.fromRef);
    }
  }
  print(output);
  try {
    const teamRef = issue.team.id ?? issue.team.key ?? teamKeyOf(identifier);
    const state = await startedState(ctx, teamRef);
    await ctx.linear().mcp.call(TOOLS.updateIssue, { id: identifier, state });
    print(`✓ Issue state updated to '${state}'\n`);
  } catch (error) {
    error.message = `Could not move the issue to a started state: ${error.message}`;
    error.hint = `The ${ctx.config.vcs === "jj" ? "jj change" : "branch"} is ready; set the state with \`linear issue update ${identifier} --state <state>\`.`;
    throw error;
  }
}

function issueFields(o) {
  const fields = {};
  if (o.title !== undefined) fields.title = o.title;
  if (o.description !== undefined) fields.description = o.description;
  if (o.descriptionFile !== undefined) fields.description = readText(o.descriptionFile);
  if (o.assignee !== undefined) fields.assignee = userParam(o.assignee);
  if (o.delegate !== undefined) fields.delegate = userParam(o.delegate);
  if (o.state !== undefined) fields.state = o.state;
  if (o.priority !== undefined) {
    try {
      fields.priority = parsePriority(o.priority);
    } catch (error) {
      throw usage(error.message);
    }
  }
  if (o.estimate !== undefined) {
    if (!/^-?\d+$/.test(o.estimate)) throw usage(`invalid estimate '${o.estimate}': use a whole number`);
    fields.estimate = Number(o.estimate);
  }
  if (o.dueDate !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(o.dueDate)) throw usage(`invalid due date '${o.dueDate}': use YYYY-MM-DD`);
    fields.dueDate = o.dueDate;
  }
  if (o.parent !== undefined) fields.parentId = parseIssueRef(o.parent);
  if (o.project !== undefined) fields.project = o.project;
  if (o.milestone !== undefined) fields.milestone = o.milestone;
  if (o.cycle !== undefined) fields.cycle = cycleParam(o.cycle);
  if (o.template !== undefined) fields.template = o.template;
  return fields;
}

function savedIssue(result, fallbackId) {
  const raw = one(result, "issue");
  return {
    identifier: raw?.identifier ?? fallbackId ?? raw?.id ?? "",
    title: raw?.title ?? "",
    url: raw?.url ?? "",
    id: raw?.id,
  };
}

async function create(ctx, o) {
  const fields = issueFields(o);
  if (o.label.length) fields.labels = o.label;
  let team = o.team ?? ctx.config.team_id;
  const canAsk = interactive(ctx.noInput);
  if (o.interactive) {
    requireInteractive(ctx.noInput, "a terminal for --interactive");
    if (!team) {
      const teams = await ctx.linear().teams();
      team = await select("Team:", teams.map((t) => ({ label: `${t.key} ${t.name}`, value: t.key || t.id })));
    }
    fields.title = await input("Title:", { initial: fields.title, required: true });
    fields.description = (await input("Description (Markdown, one line):", { initial: fields.description ?? "" })) || undefined;
    const statuses = await ctx.linear().statuses(team);
    if (statuses.length) {
      fields.state = await select("State:", statuses.map((s) => ({ label: `${s.name}${s.type ? ` (${s.type})` : ""}`, value: s.name })));
    }
    fields.priority = await select("Priority:", ["No priority", "Urgent", "High", "Medium", "Low"].map((label, value) => ({ label, value })));
    if (await confirm("Assign to yourself?", true)) fields.assignee = "me";
    const labels = (await input("Labels (comma separated):")).split(",").map((s) => s.trim()).filter(Boolean);
    if (labels.length) fields.labels = labels;
  }
  if (!team) {
    if (!canAsk) throw usage("No team given", "Pass --team, set LINEAR_TEAM_ID, or run `linear config`.");
    const teams = await ctx.linear().teams();
    team = await select("Team:", teams.map((t) => ({ label: `${t.key} ${t.name}`, value: t.key || t.id })));
  }
  if (!fields.title && !fields.template) {
    if (!canAsk) throw usage("No title given", "Pass --title.");
    fields.title = await input("Title:", { required: true });
  }
  const assignSelf = ctx.config.issue_create_assign_self ?? "auto";
  if (fields.assignee === undefined && assignSelf === "always") fields.assignee = "me";
  const result = await ctx.linear().mcp.call(TOOLS.createIssue, { team, ...fields });
  const issue = savedIssue(result);
  print(done("Created", "issue", `${issue.identifier}: ${issue.title || fields.title}`, issue.url));
  if (o.start) await start(ctx, { ...o, branch: undefined }, { issue: issue.identifier });
}

async function update(ctx, o, a) {
  const identifier = resolveIssueId(ctx, a.issue);
  const fields = issueFields(o);
  if (o.team !== undefined) fields.team = o.team;
  if (o.unassign) fields.assignee = null;
  if (o.clearDelegate) fields.delegate = null;
  if (o.clearEstimate) fields.estimate = null;
  if (o.clearDueDate) fields.dueDate = null;
  if (o.clearParent) fields.parentId = null;
  if (o.clearProject) fields.project = null;
  if (o.clearMilestone) fields.milestone = null;
  if (o.clearCycle) fields.cycle = null;
  if (o.label.length) fields.labels = o.label;
  if (o.addLabel.length || o.removeLabel.length) {
    if (o.label.length) throw usage("--label cannot be combined with --add-label or --remove-label");
    const current = await ctx.linear().issue(identifier);
    const names = new Set(current.labels.nodes.map((l) => l.name));
    for (const l of o.addLabel) names.add(l);
    for (const l of o.removeLabel) {
      for (const n of [...names]) if (n.toLowerCase() === l.toLowerCase()) names.delete(n);
    }
    fields.labels = [...names];
  }
  if (Object.keys(fields).length === 0) throw usage("No changes given", "Pass the fields to change, like --state or --title.");
  const result = await ctx.linear().mcp.call(TOOLS.updateIssue, { id: identifier, ...fields });
  let issue = savedIssue(result, identifier);
  if (!issue.url || !issue.title) issue = { ...issue, ...(await ctx.linear().issue(identifier)) };
  print(done("Updated", "issue", `${issue.identifier}: ${issue.title}`, issue.url));
}

function bulkIds(o) {
  let ids = [...(o.bulk ?? [])];
  if (o.bulkFile) ids.push(...fs.readFileSync(o.bulkFile, "utf8").split(/\r?\n/));
  if (o.bulkStdin) ids.push(...fs.readFileSync(0, "utf8").split(/\r?\n/));
  ids = ids.map((s) => s.trim()).filter(Boolean);
  return ids;
}

function archiveOrDelete(verb, tool) {
  return async (ctx, o, a) => {
    const bulk = bulkIds(o);
    const ids = (bulk.length ? bulk : [a.issue]).map((r) => resolveIssueId(ctx, r));
    if (!o.yes) {
      requireInteractive(ctx.noInput, "confirmation", "--yes");
      const ok = await confirm(`${verb === "Deleted" ? "Delete" : "Archive"} ${ids.join(", ")}?`);
      if (!ok) {
        process.stderr.write("Canceled.\n");
        return;
      }
    }
    const failures = [];
    for (const identifier of ids) {
      try {
        await ctx.linear().mcp.call(tool, { id: identifier });
        print(done(verb, "issue", identifier));
      } catch (error) {
        if (/unknown tool|not found.*tool|no such tool|-32601/i.test(error.message)) {
          throw new CliError(
            `The Linear MCP server has no ${tool.join("/")} tool, so issues cannot be ${verb.toLowerCase()} over MCP`,
            EXIT.failure,
            verb === "Deleted" ? "Move the issue to a canceled state instead: `linear issue update <ID> --state canceled`." : undefined,
          );
        }
        failures.push(error);
        process.stderr.write(`✗ ${identifier}: ${error.message}\n`);
      }
    }
    if (failures.length) {
      const order = [EXIT.auth, EXIT.unavailable, EXIT.failure, EXIT.notFound];
      const code = order.find((c) => failures.some((f) => f.code === c)) ?? EXIT.failure;
      throw new CliError(`${failures.length} of ${ids.length} failed`, code);
    }
  };
}

async function pullRequest(ctx, o, a) {
  const identifier = resolveIssueId(ctx, a.issue);
  const issue = await ctx.linear().issue(identifier);
  const prTitle = `${identifier} ${o.title ?? issue.title}`;
  let body = "";
  const templateFile = o.noTemplate ? null : (o.template ?? ctx.config.pr_template);
  if (templateFile) body = `${fs.readFileSync(templateFile, "utf8").trimEnd()}\n\n`;
  body += `${issue.url}\n`;
  const args = ["pr", "create", "--title", prTitle, "--body", body];
  if (o.base) args.push("--base", o.base);
  if (o.head) args.push("--head", o.head);
  if (o.draft) args.push("--draft");
  if (o.web) args.push("--web");
  const result = spawnSync("gh", args, { stdio: "inherit" });
  if (result.error) throw new CliError(`Could not run gh: ${result.error.message}`, EXIT.failure, "Install the GitHub CLI: https://cli.github.com");
  if (result.status !== 0) throw new CliError(`gh pr create exited with status ${result.status}`);
}

// ---------------------------------------------------------------- comments

function commentText(comments) {
  const roots = comments.filter((c) => !c.parent || !comments.some((p) => p.id === c.parent.id));
  let out = "";
  for (const root of roots.filter((c) => !c.parent)) {
    out += `${bold(`@${singleLine(userName(root.user) ?? "unknown")}`)} commented ${ago(root.createdAt)} [${root.id}]${root.resolvedAt ? " [resolved]" : ""}\n`;
    if (root.quotedText) out += `> ${root.quotedText}\n`;
    out += `${root.body}\n`;
    const replies = comments.filter((c) => c.parent?.id === root.id);
    if (replies.length) {
      out += "\n";
      for (const reply of replies) {
        out += `  ${bold(`@${singleLine(userName(reply.user) ?? "unknown")}`)} replied ${ago(reply.createdAt)} [${reply.id}]\n`;
        out += `  ${reply.body.replace(/\n/g, "\n  ")}\n`;
      }
    }
    out += "\n";
  }
  for (const orphan of roots.filter((c) => c.parent)) {
    out += `  ${bold(`@${userName(orphan.user) ?? "unknown"}`)} replied to [${orphan.parent.id}] ${ago(orphan.createdAt)} [${orphan.id}]\n`;
    out += `  ${orphan.body.replace(/\n/g, "\n  ")}\n\n`;
  }
  return out;
}

async function commentList(ctx, o, a) {
  const identifier = resolveIssueId(ctx, a.issue);
  const comments = await ctx.linear().comments(identifier);
  if (o.json) return printJson(comments);
  if (comments.length === 0) return print("No comments found for this issue\n");
  page(commentText(comments), !o.noPager);
}

async function commentAdd(ctx, o, a) {
  const identifier = resolveIssueId(ctx, a.issue);
  if (o.attach.length) throw usage("--attach is not supported over MCP: Linear's MCP server cannot upload files");
  let body = o.body ?? (o.bodyFile ? readText(o.bodyFile) : undefined);
  if (body === undefined && !process.stdin.isTTY && !ctx.noInput) body = fs.readFileSync(0, "utf8");
  if (body === undefined || !body.trim()) {
    if (!interactive(ctx.noInput)) throw usage("No comment body given", "Pass --body or --body-file.");
    body = await input("Comment:", { required: true });
  }
  const parentId = o.replyTo;
  const result = await ctx.linear().mcp.call(TOOLS.createComment, { issueId: identifier, body, ...(parentId ? { parentId } : {}) });
  const comment = normComment(one(result, "comment") ?? {});
  print(done("Added", parentId ? "reply to" : "comment to", `issue ${a.issue ?? identifier}`, comment.url));
}

async function commentUpdate(ctx, o, a) {
  let body = o.body ?? (o.bodyFile ? readText(o.bodyFile) : undefined);
  if (body === undefined) {
    if (!interactive(ctx.noInput)) throw usage("No comment body given", "Pass --body or --body-file.");
    body = await input("New comment text:", { required: true });
  }
  const result = await ctx.linear().mcp.call(TOOLS.updateComment, { id: a.commentId, body });
  const comment = normComment(one(result, "comment") ?? {});
  print(done("Updated", "comment", a.commentId, comment.url));
}

async function commentDelete(ctx, o, a) {
  if (!o.yes) {
    requireInteractive(ctx.noInput, "confirmation", "--yes");
    if (!(await confirm(`Delete comment ${a.commentId}?`))) return process.stderr.write("Canceled.\n");
  }
  await ctx.linear().mcp.call(TOOLS.deleteComment, { id: a.commentId });
  print(done("Deleted", "comment", a.commentId));
}

async function link(ctx, o, a) {
  const identifier = resolveIssueId(ctx, a.issue);
  const links = [{ url: a.url, title: o.title ?? a.url }];
  await ctx.linear().mcp.call(TOOLS.updateIssue, { id: identifier, links });
  print(done("Linked", "URL to issue", identifier, a.url));
}

async function relation(ctx, o, a) {
  const identifier = resolveIssueId(ctx, a.issue);
  const map = { blocks: "blocks", "blocked-by": "blockedBy", related: "relatedTo", duplicate: "duplicateOf" };
  const key = map[a.type];
  if (!key) throw usage(`Unknown relation type '${a.type}': use ${Object.keys(map).join(", ")}`);
  const other = parseIssueRef(a.other, configuredTeamKey(ctx));
  await ctx.linear().mcp.call(TOOLS.updateIssue, { id: identifier, [key]: key === "duplicateOf" ? other : [other] });
  print(done("Added", "relation", `${identifier} ${a.type} ${other}`));
}

// ---------------------------------------------------------------- grammar

const filterOptions = [
  { name: "assignee", type: "string", value: "USER", desc: "Show only issues assigned to this user: a username, email, name, or @me" },
  { name: "all-assignees", short: "A", type: "boolean", desc: "Show issues of every assignee" },
  { name: "unassigned", short: "U", type: "boolean", desc: "Show only unassigned issues" },
  { name: "project", type: "string", desc: "Show only this project's issues (ID, slug, or name)" },
  { name: "project-label", type: "string", value: "LABEL", desc: "Show only issues in projects with this project label" },
  { name: "cycle", type: "string", desc: "Show only this cycle's issues: a name, number, `active`, `next`, `previous`" },
  { name: "milestone", type: "string", desc: "Show only this milestone's issues (ID, or name with --project)" },
  { name: "label", short: "l", type: "multi", desc: "Show only issues with this label; repeat to require several" },
  { name: "created-after", type: "string", value: "DATE", desc: "Show only issues created after this date (YYYY-MM-DD or RFC 3339)" },
  { name: "updated-after", type: "string", value: "DATE", desc: "Show only issues updated after this date (YYYY-MM-DD or RFC 3339)" },
  issueLimitOption,
];
const filterConflicts = [["assignee", "all-assignees"], ["assignee", "unassigned"], ["all-assignees", "unassigned"], ["project-label", "project"], ["project-label", "milestone"]];

const issueArg = { name: "issue", desc: "Issue ID like ENG-123, or a URL; defaults to the current branch's issue" };

const writeOptions = [
  { name: "title", short: "t", type: "string", desc: "Issue title" },
  { name: "description", short: "d", type: "string", desc: "Issue description, in Markdown" },
  { name: "description-file", type: "string", value: "FILE", desc: "Read the description from a Markdown file (- for stdin)" },
  { name: "assignee", short: "a", type: "string", value: "USER", desc: "Assignee: a username, email, name, or @me" },
  { name: "delegate", type: "string", value: "AGENT", desc: "Delegate the issue to an agent" },
  { name: "state", short: "s", type: "string", desc: "Workflow state, by name or type" },
  { name: "priority", short: "p", type: "string", desc: "Priority, by name or number (0 none, 1 urgent to 4 low)" },
  { name: "estimate", type: "string", value: "POINTS", desc: "Estimate, in points" },
  { name: "label", short: "l", type: "multi", desc: "Label; repeat for several labels" },
  { name: "due-date", type: "string", value: "DATE", desc: "Due date (YYYY-MM-DD)" },
  { name: "parent", type: "string", value: "ISSUE", desc: "Parent issue, like ENG-123" },
  { name: "project", type: "string", desc: "Project (ID, slug, or name)" },
  { name: "milestone", type: "string", desc: "Project milestone (ID, or name with --project)" },
  { name: "cycle", type: "string", desc: "Cycle: a name, number, `active`, `next`, `previous`" },
];

const confirmOption = { name: "yes", short: "y", aliases: ["force", "confirm"], shortAliases: ["f"], type: "boolean", desc: "Do not ask for confirmation" };
const bulkOptions = [
  { name: "bulk", type: "multi", value: "IDS", desc: "Act on several at once instead of one" },
  { name: "bulk-file", type: "string", value: "FILE", desc: "Read the IDs from a file, one per line" },
  { name: "bulk-stdin", type: "boolean", desc: "Read the IDs from stdin, one per line" },
];

export const issueCommand = {
  name: "issue",
  aliases: ["i"],
  summary: "Manage issues",
  commands: [
    {
      name: "list", aliases: ["mine", "l"], summary: "List issues, assigned to you by default", run: list,
      options: [
        { name: "state", short: "s", type: "multi", default: ["unstarted"], desc: "Show issues in this state: a type (triage, backlog, unstarted, started, completed, canceled), name, or ID; repeatable" },
        { name: "all-states", type: "boolean", desc: "Show issues in every state" },
        { name: "sort", type: "string", desc: "Sort order: priority or manual [default: the issue_sort setting, or priority]" },
        { name: "team", type: "string", desc: "Show this team's issues (key, name, or ID); defaults to the configured team" },
        ...filterOptions,
        { name: "include-archived", type: "boolean", desc: "Include archived issues" },
        { name: "web", short: "w", type: "boolean", desc: "Open the list in the browser" },
        { name: "app", short: "a", type: "boolean", desc: "Open the list in the Linear app" },
        { name: "no-pager", type: "boolean", desc: "Do not page long output" },
        { name: "json", short: "j", type: "boolean", desc: "Print JSON" },
      ],
      conflicts: [...filterConflicts, ["state", "all-states"], ["json", "web"], ["json", "app"]],
    },
    {
      name: "query", aliases: ["q"], summary: "Find issues by filters or full-text search", run: query,
      options: [
        { name: "search", type: "string", value: "TEXT", desc: "Search issue titles and descriptions for this text" },
        { name: "search-comments", type: "boolean", desc: "Also search comments (with --search)" },
        { name: "team", type: "multi", desc: "Show this team's issues (key, name, or ID); repeatable [default: the configured team]" },
        { name: "all-teams", type: "boolean", desc: "Show every team's issues" },
        { name: "state", short: "s", type: "multi", desc: "Show issues in this state: a type, name, or ID; repeatable" },
        { name: "all-states", type: "boolean", desc: "Show issues in every state" },
        { name: "sort", type: "string", desc: "Sort order, except with --search" },
        ...filterOptions,
        { name: "include-archived", type: "boolean", desc: "Include archived issues" },
        { name: "json", short: "j", type: "boolean", desc: "Print JSON" },
        { name: "no-pager", type: "boolean", desc: "Do not page long output" },
      ],
      conflicts: [...filterConflicts, ["team", "all-teams"], ["state", "all-states"], ["search", "milestone"]],
    },
    {
      name: "view", aliases: ["v"], summary: "Show one or more issues", run: view,
      args: [{ name: "issue-ids", variadic: true, desc: "Issue IDs like ENG-123, or URLs; defaults to the current branch's issue" }],
      options: [
        { name: "web", short: "w", type: "boolean", desc: "Open the issues in the browser" },
        { name: "app", short: "a", type: "boolean", desc: "Open the issues in the Linear app" },
        { name: "no-comments", type: "boolean", desc: "Leave out comments" },
        { name: "show-resolved-threads", type: "boolean", desc: "Include resolved comment threads" },
        { name: "no-pager", type: "boolean", desc: "Do not page long output" },
        { name: "json", short: "j", type: "boolean", desc: "Print JSON: an object for one issue, an array for multiple issues" },
        { name: "no-download", type: "boolean", desc: "Keep remote image and file URLs (images are never downloaded over MCP)" },
      ],
    },
    {
      name: "create", summary: "Create an issue", run: create,
      options: [
        ...writeOptions,
        { name: "team", type: "string", desc: "Team (key, name, or ID); defaults to the configured team" },
        { name: "template", type: "string", desc: "Start from this issue template (name or ID)" },
        { name: "no-use-default-template", type: "boolean", desc: "Do not apply the team's default template" },
        { name: "start", type: "boolean", desc: "Start the issue after creating it" },
        { name: "interactive", short: "i", type: "boolean", desc: "Ask for every field instead of taking them as flags" },
        confirmOption,
      ],
      conflicts: [["description", "description-file"]],
    },
    {
      name: "update", summary: "Update an issue", run: update, args: [issueArg],
      options: [
        ...writeOptions.filter((o) => o.name !== "label"),
        { name: "team", type: "string", desc: "Move the issue to this team (key, name, or ID)" },
        { name: "unassign", type: "boolean", desc: "Remove the assignee" },
        { name: "clear-delegate", aliases: ["undelegate"], type: "boolean", desc: "Remove the delegate" },
        { name: "clear-estimate", type: "boolean", desc: "Remove the estimate" },
        { name: "label", short: "l", type: "multi", desc: "Set the labels, replacing the current ones; repeatable" },
        { name: "add-label", type: "multi", value: "LABEL", desc: "Add a label, keeping the others; repeatable" },
        { name: "remove-label", type: "multi", value: "LABEL", desc: "Remove a label, keeping the others; repeatable" },
        { name: "clear-due-date", type: "boolean", desc: "Remove the due date" },
        { name: "clear-parent", type: "boolean", desc: "Remove the parent" },
        { name: "clear-project", type: "boolean", desc: "Remove the project" },
        { name: "clear-milestone", type: "boolean", desc: "Remove the milestone" },
        { name: "clear-cycle", type: "boolean", desc: "Remove the cycle" },
      ],
      conflicts: [["assignee", "unassign"], ["delegate", "clear-delegate"], ["estimate", "clear-estimate"], ["due-date", "clear-due-date"], ["parent", "clear-parent"], ["project", "clear-project"], ["milestone", "clear-milestone"], ["cycle", "clear-cycle"], ["description", "description-file"]],
    },
    {
      name: "delete", aliases: ["d"], summary: "Delete an issue (moves it to the trash)", run: archiveOrDelete("Deleted", TOOLS.deleteIssue),
      args: [issueArg], options: [confirmOption, ...bulkOptions],
    },
    {
      name: "archive", summary: "Archive an issue", run: archiveOrDelete("Archived", TOOLS.archiveIssue),
      args: [issueArg], options: [confirmOption, ...bulkOptions],
    },
    {
      name: "start", summary: "Start an issue: check out its git branch or jj change, then mark it started", run: start,
      args: [{ name: "issue", desc: "Issue ID like ENG-123, or a URL; asked for when omitted" }],
      options: [
        { name: "team", type: "string", desc: "Team to pick from, and the team of a bare issue number" },
        { name: "all-assignees", short: "A", type: "boolean", desc: "Offer issues of every assignee in the picker" },
        { name: "unassigned", short: "U", type: "boolean", desc: "Offer only unassigned issues in the picker" },
        { name: "from-ref", short: "f", type: "string", value: "REF", desc: "Git ref to create the branch from (git only)" },
        { name: "branch", short: "b", type: "string", desc: "Branch name to use instead of the issue's (git only)" },
      ],
      conflicts: [["all-assignees", "unassigned"]],
    },
    { name: "id", summary: "Print the issue ID of the current branch or jj change", run: id },
    { name: "title", summary: "Print an issue's title", run: title, args: [issueArg] },
    { name: "url", summary: "Print an issue's URL", run: url, args: [issueArg] },
    {
      name: "describe", summary: "Print an issue's title and a Linear-issue trailer, for commit messages", run: describe, args: [issueArg],
      options: [{ name: "references", short: "r", aliases: ["ref"], type: "boolean", desc: "Write \"References\" instead of \"Fixes\" in the trailer" }],
    },
    {
      name: "pull-request", aliases: ["pr"], summary: "Open a GitHub pull request for an issue", run: pullRequest, args: [issueArg],
      options: [
        { name: "base", type: "string", value: "BRANCH", desc: "Branch to merge into" },
        { name: "draft", type: "boolean", desc: "Open the pull request as a draft" },
        { name: "title", short: "t", type: "string", desc: "Pull request title, after the issue ID [default: the issue title]" },
        { name: "web", type: "boolean", desc: "Open the pull request in the browser" },
        { name: "head", type: "string", value: "BRANCH", desc: "Branch that holds the commits" },
        { name: "template", short: "T", type: "string", value: "FILE", desc: "Start the body from this template file; the issue URL is appended" },
        { name: "no-template", type: "boolean", desc: "Ignore the pr_template setting" },
      ],
    },
    {
      name: "comment", summary: "Add, list, edit, and delete comments on an issue",
      commands: [
        {
          name: "list", summary: "List comments on an issue", run: commentList, args: [issueArg],
          options: [
            { name: "json", short: "j", type: "boolean", desc: "Print JSON" },
            { name: "no-pager", type: "boolean", desc: "Do not page long output" },
          ],
        },
        {
          name: "add", summary: "Add a comment to an issue", run: commentAdd, args: [issueArg],
          options: [
            { name: "body", short: "b", type: "string", desc: "Comment body, in Markdown" },
            { name: "body-file", type: "string", value: "FILE", desc: "Read the body from a file (- for stdin)" },
            { name: "reply-to", short: "p", aliases: ["parent"], type: "string", value: "ID", desc: "Reply to this comment" },
            { name: "attach", short: "a", type: "multi", value: "FILE", desc: "Attach a file (not supported over MCP)" },
            { name: "public", type: "boolean", desc: "Upload images publicly (not supported over MCP)" },
          ],
        },
        {
          name: "update", summary: "Update a comment", run: commentUpdate,
          args: [{ name: "comment-id", required: true, desc: "The comment's ID" }],
          options: [
            { name: "body", short: "b", type: "string", desc: "New comment body, in Markdown" },
            { name: "body-file", type: "string", value: "FILE", desc: "Read the body from a file (- for stdin)" },
          ],
        },
        {
          name: "delete", summary: "Delete a comment", run: commentDelete,
          args: [{ name: "comment-id", required: true, desc: "The comment's ID" }], options: [confirmOption],
        },
      ],
    },
    {
      name: "link", summary: "Link a URL to an issue", run: link,
      args: [{ name: "issue", required: true, desc: "Issue ID like ENG-123" }, { name: "url", required: true, desc: "URL to link" }],
      options: [{ name: "title", short: "t", type: "string", desc: "Link title" }],
    },
    {
      name: "relation", summary: "Manage relations between issues, like blocks and duplicates",
      commands: [{
        name: "add", summary: "Relate two issues", run: relation,
        args: [
          { name: "issue", required: true, desc: "Issue ID like ENG-123" },
          { name: "type", required: true, desc: "blocks, blocked-by, related, or duplicate" },
          { name: "other", required: true, desc: "The other issue" },
        ],
      }],
    },
  ],
};

export { commentText };
