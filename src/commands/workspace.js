// team, user, project, cycle, milestone, document, label, initiative
import { usage, notFound } from "../errors.js";
import {
  ago, day, done, gray, green, hex, page, print, printJson, renderMarkdown, table, tty, PRIORITY_NAMES,
} from "../format.js";
import { TOOLS, items, one, normIssue, normProject, normUser, normComment } from "../linear.js";
import { issueTable, sortIssues, parseIssueRef } from "./issue.js";
import { jsonOption, openUrl, readText } from "./common.js";
import { interactive, select } from "../prompt.js";

const noPager = { name: "no-pager", type: "boolean", desc: "Do not page long output" };

function show(text, o) {
  if (tty()) page(renderMarkdown(text), !o.noPager);
  else print(text);
}

function requireTeam(ctx, o) {
  const team = o.team ?? ctx.config.team_id;
  if (!team) throw usage("No team given", "Pass --team, set LINEAR_TEAM_ID, or run `linear config`.");
  return team;
}

// ---------------------------------------------------------------- team

async function teamList(ctx, o) {
  const teams = (await ctx.linear().teams({ refresh: true }))
    .filter((t) => !t.archivedAt)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (o.json) return printJson(teams);
  if (!teams.length) return print("No teams found.\n");
  print(table(
    [{ header: "KEY" }, { header: "NAME", flexible: true }, { header: "CYCLES", drop: 3 }, { header: "UPDATED", drop: 1 }, { header: "ID", drop: 2 }],
    teams.map((t) => [
      { text: t.key, paint: (s) => hex(s, t.color) }, t.name, t.cyclesEnabled ? "Yes" : "No",
      { text: ago(t.updatedAt), paint: gray }, { text: t.id ?? "", paint: gray },
    ]),
  ));
}

async function teamId(ctx) {
  const team = ctx.config.team_id;
  if (!team) throw notFound("No team configured", "Set LINEAR_TEAM_ID or run `linear config`.");
  print(`${team}\n`);
}

function userRows(users) {
  return table(
    [{ header: "NAME", flexible: true }, { header: "USERNAME", drop: 3 }, { header: "EMAIL", flexible: true },
      { header: "ROLE", drop: 2 }, { header: "LAST SEEN", drop: 1 }],
    users.map((u) => [
      u.name || u.displayName, u.displayName ?? "", u.email ?? "",
      (u.admin ?? u.isAdmin) ? "Admin" : (u.guest ?? u.isGuest) ? "Guest" : u.role ?? (u.isBot ? "App" : "Member"),
      { text: u.lastSeen ? ago(u.lastSeen) : "-", paint: gray },
    ]),
  );
}

function normUsers(result) {
  return items(result, "users", "members").map((u) => ({ ...u, ...normUser(u) }));
}

async function teamMembers(ctx, o, a) {
  const team = a.team ?? requireTeam(ctx, o);
  let users = normUsers(await ctx.linear().mcp.call(TOOLS.listUsers, { team }));
  if (!o.all) users = users.filter((u) => u.active !== false);
  if (o.json) return printJson(users);
  if (!users.length) return print("No members found.\n");
  print(userRows(users));
}

async function teamStates(ctx, o, a) {
  const team = a.team ?? requireTeam(ctx, o);
  const statuses = await ctx.linear().statuses(team);
  if (o.json) return printJson(statuses);
  print(table([{ header: "NAME" }, { header: "TYPE" }], statuses.map((s) => [{ text: s.name, paint: (t) => hex(t, s.color) }, s.type ?? ""])));
}

// ---------------------------------------------------------------- user

async function userList(ctx, o) {
  let users = normUsers(await ctx.linear().mcp.call(TOOLS.listUsers, {}));
  if (!o.all) users = users.filter((u) => u.active !== false);
  users.sort((x, y) => (x.name || "").localeCompare(y.name || ""));
  if (o.json) return printJson(users);
  if (!users.length) return print("No users found.\n");
  print(userRows(users));
}

// ---------------------------------------------------------------- project

async function projectList(ctx, o) {
  const params = {};
  if (o.team) params.team = o.team;
  else if (!o.allTeams && ctx.config.team_id) params.team = ctx.config.team_id;
  if (o.status) params.state = o.status;
  if (o.includeArchived) params.includeArchived = true;
  const projects = (await ctx.linear().paginate(TOOLS.listProjects, params, Infinity, "projects")).map(normProject);
  if (o.json) return printJson(projects);
  if (!projects.length) return print("No projects found.\n");
  print(table(
    [{ header: "SLUG" }, { header: "NAME", flexible: true }, { header: "STATUS" }, { header: "PRIORITY", drop: 4 },
      { header: "HEALTH", drop: 5 }, { header: "LEAD", drop: 3 }, { header: "TEAMS", drop: 1 }, { header: "DATE", drop: 2 }],
    projects.map((p) => [
      p.slugId ?? "", p.name, { text: p.status.name, paint: (t) => hex(t, p.status.color) },
      p.priority ? PRIORITY_NAMES[p.priority] : "-", p.health ?? "-", p.lead?.displayName ?? "-",
      p.teams.nodes.map((t) => t.key || t.name).join(", ") || "-",
      p.targetDate ? day(p.targetDate) : p.startDate ? day(p.startDate) : "-",
    ]),
  ));
}

function projectRef(value) {
  const m = /linear\.app\/[^/]+\/project\/([^/?#]+)/.exec(value ?? "");
  if (!m) return value;
  const slug = m[1].match(/([0-9a-f]{12})$/);
  return slug ? slug[1] : m[1];
}

async function pickProject(ctx) {
  if (!interactive(ctx.noInput)) throw usage("No project given", "Pass a project ID, slug, or name.");
  const projects = (await ctx.linear().paginate(TOOLS.listProjects, {}, Infinity, "projects")).map(normProject);
  return select("Project:", projects.map((p) => ({ label: p.name, value: p.id ?? p.name })));
}

async function projectView(ctx, o, a) {
  const query = a.project ? projectRef(a.project) : await pickProject(ctx);
  if (o.web && /^https?:/.test(a.project ?? "")) return openUrl(a.project);
  const result = await ctx.linear().mcp.call(TOOLS.getProject, { query, includeMilestones: true, includeResources: true });
  if (!result || typeof result === "string") throw notFound(`Project not found: ${a.project ?? query}`);
  const p = normProject(one(result, "project"));
  if (o.web) return openUrl(p.url);
  if (o.json) return printJson(p);
  const lines = [`# ${p.name}`, ""];
  lines.push(`**Status:** ${p.status.name || "-"}`);
  if (p.priority) lines.push(`**Priority:** ${PRIORITY_NAMES[p.priority]}`);
  if (p.health) lines.push(`**Health:** ${p.health}`);
  if (p.lead) lines.push(`**Lead:** @${p.lead.displayName}`);
  if (p.teams.nodes.length) lines.push(`**Teams:** ${p.teams.nodes.map((t) => t.key || t.name).join(", ")}`);
  if (p.startDate) lines.push(`**Start date:** ${day(p.startDate)}`);
  if (p.targetDate) lines.push(`**Target date:** ${day(p.targetDate)}`);
  if (p.url) lines.push(`**URL:** ${p.url}`);
  if (p.summary) lines.push("", p.summary);
  const content = p.content ?? p.description;
  if (content) lines.push("", content);
  const milestones = items(p.milestones ?? p.projectMilestones ?? []);
  if (milestones.length) {
    lines.push("", "## Milestones", "");
    for (const m of milestones) lines.push(`- **${m.name}**${m.targetDate ? ` _(${day(m.targetDate)})_` : ""}`);
  }
  const resources = items(p.resources ?? p.links ?? p.externalLinks ?? []);
  if (resources.length) {
    lines.push("", "## Resources", "");
    for (const r of resources) lines.push(`- **${r.label ?? r.title ?? r.url}**: ${r.url}`);
  }
  const documents = items(p.documents ?? []);
  if (documents.length) {
    lines.push("", "## Documents", "");
    for (const d of documents) lines.push(`- **${d.title}**${d.url ? `: ${d.url}` : ""}`);
  }
  show(`${lines.join("\n")}\n`, o);
}

function projectFields(o) {
  const f = {};
  if (o.name !== undefined) f.name = o.name;
  if (o.description !== undefined) f.summary = o.description;
  if (o.content !== undefined) f.description = o.content;
  if (o.contentFile !== undefined) f.description = readText(o.contentFile);
  if (o.lead !== undefined) f.lead = o.lead.replace(/^@/, "");
  if (o.status !== undefined) f.state = o.status;
  if (o.startDate !== undefined) f.startDate = o.startDate;
  if (o.targetDate !== undefined) f.targetDate = o.targetDate;
  if (o.priority !== undefined) f.priority = o.priority;
  if (o.label?.length) f.labels = o.label;
  return f;
}

async function projectCreate(ctx, o) {
  if (!o.name) throw usage("No project name given", "Pass --name.");
  const teams = o.team.length ? o.team : ctx.config.team_id ? [ctx.config.team_id] : [];
  if (!teams.length) throw usage("No team given", "Pass --team.");
  const result = await ctx.linear().mcp.call(["save_project", "create_project"], { ...projectFields(o), team: teams[0], teams });
  const p = normProject(one(result, "project"));
  print(done("Created", "project", p.name || o.name, p.url));
}

async function projectUpdate(ctx, o, a) {
  const fields = projectFields(o);
  if (o.clearLead) fields.lead = null;
  if (o.clearStartDate) fields.startDate = null;
  if (o.clearTargetDate) fields.targetDate = null;
  if (!Object.keys(fields).length) throw usage("No changes given");
  const result = await ctx.linear().mcp.call(["save_project", "update_project"], { id: projectRef(a.project), ...fields });
  const p = normProject(one(result, "project"));
  print(done("Updated", "project", p.name || a.project, p.url));
}

// ---------------------------------------------------------------- cycle

function cycleStatus(c, now = new Date()) {
  if (c.isActive || (c.startsAt && c.endsAt && new Date(c.startsAt) <= now && now < new Date(c.endsAt))) return "Active";
  if (c.completedAt || (c.endsAt && new Date(c.endsAt) <= now)) return "Completed";
  return "Upcoming";
}

async function cycles(ctx, team) {
  const t = await ctx.linear().team(team);
  return items(await ctx.linear().mcp.call(TOOLS.listCycles, { teamId: t.id ?? team }), "cycles");
}

async function cycleList(ctx, o) {
  const list = (await cycles(ctx, requireTeam(ctx, o))).sort((x, y) => (y.number ?? 0) - (x.number ?? 0));
  if (o.json) return printJson(list);
  if (!list.length) return print("No cycles found.\n");
  print(table(
    [{ header: "#" }, { header: "NAME", flexible: true }, { header: "START", drop: 1 }, { header: "END" }, { header: "STATUS" }],
    list.map((c) => {
      const status = cycleStatus(c);
      return [String(c.number ?? ""), c.name ?? "-", day(c.startsAt), day(c.endsAt),
        { text: status, paint: status === "Active" ? green : status === "Completed" ? gray : undefined }];
    }),
  ));
}

async function cycleView(ctx, o, a) {
  const team = requireTeam(ctx, o);
  const list = await cycles(ctx, team);
  const ref = String(a.cycle).toLowerCase();
  const now = new Date();
  const cycle = ref === "active" || ref === "current"
    ? list.find((c) => cycleStatus(c, now) === "Active")
    : list.find((c) => String(c.number) === ref || c.id === a.cycle || (c.name ?? "").toLowerCase() === ref);
  if (!cycle) throw notFound(`Cycle not found: ${a.cycle}`, `Run \`linear cycle list --team ${team}\` to see the cycles.`);
  const issues = sortIssues(await ctx.linear().issues({ team, cycle: String(cycle.number ?? cycle.id) }, Infinity));
  if (o.json) return printJson({ ...cycle, issues: { nodes: issues } });
  let text = `# Cycle #${cycle.number}${cycle.name ? ` ${cycle.name}` : ""}\n\n`
    + `**Status:** ${cycleStatus(cycle)}\n**Start:** ${day(cycle.startsAt)}\n**End:** ${day(cycle.endsAt)}\n`;
  if (cycle.description) text += `\n${cycle.description}\n`;
  if (!tty()) {
    text += issues.length ? `\n## Issues\n\n${issues.map((i) => `- **${i.identifier}**: ${i.title} _[${i.state.name}]_`).join("\n")}\n` : "\n_No issues in this cycle yet._\n";
    return print(text);
  }
  page(`${renderMarkdown(text)}\n${issues.length ? issueTable(issues, { assignee: true }) : "No issues in this cycle yet.\n"}`, !o.noPager);
}

// ---------------------------------------------------------------- milestone

function normMilestones(result) {
  return items(result, "milestones", "projectMilestones");
}

async function milestoneList(ctx, o) {
  if (!o.project) throw usage("No project given", "Pass --project.");
  const list = normMilestones(await ctx.linear().mcp.call(TOOLS.listMilestones, { project: projectRef(o.project) }));
  if (o.json) return printJson(list);
  if (!list.length) return print("No milestones found.\n");
  print(table(
    [{ header: "NAME", flexible: true }, { header: "ID" }, { header: "TARGET DATE", drop: 2 }, { header: "PROJECT", flexible: true, drop: 1 }],
    list.map((m) => [m.name, m.id ?? "", m.targetDate ? day(m.targetDate) : "-", typeof m.project === "string" ? m.project : m.project?.name ?? o.project]),
  ));
}

async function milestoneView(ctx, o, a) {
  const params = { query: a.milestone, id: a.milestone };
  if (o.project) params.project = projectRef(o.project);
  const m = one(await ctx.linear().mcp.call(TOOLS.getMilestone, params), "milestone", "projectMilestone");
  if (!m || typeof m !== "object") throw notFound(`Milestone not found: ${a.milestone}`);
  const projectName = typeof m.project === "string" ? m.project : m.project?.name;
  let issues = items(m.issues ?? []).map(normIssue);
  if (!issues.length && m.id) {
    issues = await ctx.linear().issues({ milestone: m.id, ...(m.projectId || m.project?.id ? { project: m.projectId ?? m.project.id } : {}) }, o.all || o.json ? Infinity : 10);
  }
  if (o.json) return printJson({ ...m, issues: { nodes: issues } });
  let text = `# ${m.name}\n\n`;
  if (projectName) text += `**Project:** ${projectName}\n`;
  if (m.targetDate) text += `**Target date:** ${day(m.targetDate)}\n`;
  if (m.progress !== undefined) text += `**Progress:** ${Math.round(Number(m.progress) * (m.progress <= 1 ? 100 : 1))}%\n`;
  if (m.description) text += `\n${m.description}\n`;
  const shown = o.all ? issues : issues.slice(0, 10);
  text += shown.length ? `\n## Issues\n\n${shown.map((i) => `- **${i.identifier}**: ${i.title} _[${i.state.name}]_`).join("\n")}\n` : "\n_No issues in this milestone yet._\n";
  if (!o.all && issues.length > 10) text += `\n${issues.length - 10} more; use --all to list every issue.\n`;
  show(text, o);
}

async function milestoneCreate(ctx, o) {
  if (!o.project) throw usage("No project given", "Pass --project.");
  if (!o.name) throw usage("No milestone name given", "Pass --name.");
  const result = await ctx.linear().mcp.call(["save_milestone", "create_milestone", "create_project_milestone"], {
    project: projectRef(o.project), name: o.name, description: o.description, targetDate: o.targetDate,
  });
  const m = one(result, "milestone", "projectMilestone") ?? {};
  print(done("Created", "milestone", m.name ?? o.name));
}

async function milestoneUpdate(ctx, o, a) {
  const fields = { name: o.name, description: o.description, targetDate: o.targetDate };
  if (Object.values(fields).every((v) => v === undefined)) throw usage("No changes given");
  const result = await ctx.linear().mcp.call(["save_milestone", "update_milestone", "update_project_milestone"], { id: a.milestone, ...fields });
  const m = one(result, "milestone", "projectMilestone") ?? {};
  print(done("Updated", "milestone", m.name ?? a.milestone));
}

// ---------------------------------------------------------------- document

function docSlug(d) {
  if (d.slugId) return d.slugId;
  const m = /\/document\/(?:.*-)?([0-9a-f]{12})$/.exec(d.url ?? "");
  return m ? m[1] : d.id ?? "";
}

function docAttachment(d) {
  for (const key of ["project", "issue", "initiative", "team", "cycle"]) {
    const v = d[key];
    if (v) return `${key}: ${typeof v === "string" ? v : v.name ?? v.identifier ?? v.title ?? v.key ?? v.id}`;
  }
  return "-";
}

async function documentList(ctx, o) {
  const params = {};
  if (o.project) params.projectId = projectRef(o.project);
  if (o.issue) params.issueId = parseIssueRef(o.issue);
  if (o.initiative) params.initiativeId = o.initiative;
  if (o.team) params.teamId = o.team;
  if (o.creator) params.creatorId = o.creator;
  if (o.query) params.query = o.query;
  const docs = await ctx.linear().paginate(TOOLS.listDocuments, params, o.limit === "all" ? Infinity : Number(o.limit) || 50, "documents");
  if (o.json) return printJson(docs);
  if (!docs.length) return print("No documents found.\n");
  print(table(
    [{ header: "SLUG" }, { header: "TITLE", flexible: true }, { header: "ATTACHMENT", flexible: true, drop: 1 }, { header: "UPDATED", drop: 2 }],
    docs.map((d) => [docSlug(d), d.title ?? "", docAttachment(d), { text: ago(d.updatedAt), paint: gray }]),
  ));
}

function docRef(value) {
  const m = /linear\.app\/[^/]+\/document\/(?:.*-)?([0-9a-f]{12})/.exec(value);
  return m ? m[1] : value;
}

async function documentView(ctx, o, a) {
  const d = one(await ctx.linear().mcp.call(TOOLS.getDocument, { id: docRef(a.document) }), "document");
  if (!d || typeof d !== "object") throw notFound(`Document not found: ${a.document}`);
  if (o.web) return openUrl(d.url);
  if (o.json) {
    if (d.comments === undefined) {
      try {
        d.comments = items(await ctx.linear().mcp.call(TOOLS.listComments, { documentId: d.id ?? a.document }), "comments").map(normComment);
      } catch {
        /* the server may not list document comments */
      }
    }
    return printJson(d);
  }
  const content = d.content ?? d.body ?? "";
  if (o.raw) return print(`${content}${content.endsWith("\n") ? "" : "\n"}`);
  show(`# ${d.title}\n\n${content}\n`, o);
}

async function documentCreate(ctx, o) {
  if (!o.title) throw usage("No title given", "Pass --title.");
  let content = o.content ?? (o.contentFile ? readText(o.contentFile) : undefined);
  if (content === undefined && !process.stdin.isTTY) content = readText("-");
  const targets = ["project", "issue", "team", "initiative", "cycle"].filter((k) => o[k]);
  if (targets.length !== 1 && !(targets.length === 2 && o.team && o.cycle)) {
    throw usage("Pass exactly one of --project, --issue, --team, --initiative, or --cycle (with --team)");
  }
  const params = { title: o.title, content };
  if (o.project) params.project = projectRef(o.project);
  if (o.issue) params.issue = parseIssueRef(o.issue);
  if (o.team) params.team = o.team;
  if (o.initiative) params.initiative = o.initiative;
  if (o.cycle) params.cycle = o.cycle;
  const d = one(await ctx.linear().mcp.call(["create_document", "save_document"], params), "document") ?? {};
  print(done("Created", "document", d.title ?? o.title, d.url));
}

async function documentUpdate(ctx, o, a) {
  const params = { id: docRef(a.document) };
  if (o.title) params.title = o.title;
  if (o.content !== undefined) params.content = o.content;
  if (o.contentFile) params.content = readText(o.contentFile);
  if (Object.keys(params).length === 1) throw usage("No changes given", "Pass --title, --content, or --content-file.");
  const d = one(await ctx.linear().mcp.call(["update_document", "save_document"], params), "document") ?? {};
  print(done("Updated", "document", d.title ?? a.document, d.url));
}

// ---------------------------------------------------------------- label

async function labelList(ctx, o) {
  const params = {};
  if (o.team) params.team = o.team;
  else if (!o.all && ctx.config.team_id) params.team = ctx.config.team_id;
  const labels = items(await ctx.linear().mcp.call(TOOLS.listLabels, params), "labels");
  if (o.json) return printJson(labels);
  if (!labels.length) return print("No labels found.\n");
  print(table(
    [{ header: "ID" }, { header: "NAME", flexible: true }, { header: "COLOR", drop: 1 }, { header: "TEAM", drop: 2 }],
    labels.map((l) => [{ text: l.id ?? "", paint: gray }, { text: l.name, paint: (t) => hex(t, l.color) }, l.color ?? "",
      (typeof l.team === "string" ? l.team : l.team?.key ?? l.team?.name) ?? "-"]),
  ));
}

async function labelCreate(ctx, o) {
  if (!o.name) throw usage("No label name given", "Pass --name.");
  const params = { name: o.name, color: o.color, description: o.description, ...(o.team || ctx.config.team_id ? { teamId: o.team ?? ctx.config.team_id } : {}) };
  const l = one(await ctx.linear().mcp.call(["create_issue_label", "save_issue_label"], params), "label", "issueLabel") ?? {};
  print(done("Created", "label", l.name ?? o.name));
}

// ---------------------------------------------------------------- initiative

async function initiativeList(ctx, o) {
  const list = await ctx.linear().paginate(TOOLS.listInitiatives, o.status ? { status: o.status } : {}, Infinity, "initiatives");
  if (o.json) return printJson(list);
  if (!list.length) return print("No initiatives found.\n");
  print(table(
    [{ header: "SLUG" }, { header: "NAME", flexible: true }, { header: "STATUS" }, { header: "HEALTH", drop: 4 },
      { header: "OWNER", drop: 3 }, { header: "PROJ", drop: 1 }, { header: "TARGET", drop: 2 }],
    list.map((i) => [i.slugId ?? "", i.name, typeof i.status === "string" ? i.status : i.status?.name ?? "-", i.health ?? "-",
      normUser(i.owner)?.displayName ?? "-", String(items(i.projects ?? []).length || "-"), i.targetDate ? day(i.targetDate) : "-"]),
  ));
}

async function initiativeView(ctx, o, a) {
  const i = one(await ctx.linear().mcp.call(TOOLS.getInitiative, { query: a.initiative, id: a.initiative, includeProjects: true }), "initiative");
  if (!i || typeof i !== "object") throw notFound(`Initiative not found: ${a.initiative}`);
  if (o.json) return printJson(i);
  let text = `# ${i.name}\n\n`;
  const status = typeof i.status === "string" ? i.status : i.status?.name;
  if (status) text += `**Status:** ${status}\n`;
  if (i.owner) text += `**Owner:** @${normUser(i.owner).displayName}\n`;
  if (i.targetDate) text += `**Target date:** ${day(i.targetDate)}\n`;
  if (i.url) text += `**URL:** ${i.url}\n`;
  if (i.description || i.content) text += `\n${i.content ?? i.description}\n`;
  const projects = items(i.projects ?? []).map(normProject);
  text += "\n## Projects\n\n";
  text += projects.length ? `${projects.map((p) => `- **${p.name}**${p.status.name ? ` _[${p.status.name}]_` : ""}`).join("\n")}\n` : "*No projects linked to this initiative.*\n";
  show(text, o);
}

// ---------------------------------------------------------------- grammar

const teamOption = { name: "team", type: "string", desc: "Team (key, name, or ID); defaults to the configured team" };

export const teamCommand = {
  name: "team", aliases: ["t"], summary: "Manage teams",
  commands: [
    { name: "list", summary: "List teams", run: teamList, options: [jsonOption] },
    { name: "id", summary: "Print the configured team key", run: teamId },
    {
      name: "members", summary: "List team members", run: teamMembers,
      args: [{ name: "team", desc: "Team key, name, or ID; defaults to the configured team" }],
      options: [{ name: "all", type: "boolean", desc: "Include inactive members" }, jsonOption],
    },
    { name: "states", summary: "List the team's workflow states", run: teamStates, args: [{ name: "team", desc: "Team key, name, or ID" }], options: [jsonOption] },
  ],
};

export const userCommand = {
  name: "user", aliases: ["u"], summary: "List workspace members",
  commands: [{
    name: "list", summary: "List everyone in the workspace", run: userList,
    options: [{ name: "all", type: "boolean", desc: "Include deactivated members" }, jsonOption],
  }],
};

const projectWrite = [
  { name: "name", short: "n", type: "string", desc: "Project name" },
  { name: "description", short: "d", type: "string", desc: "Short summary" },
  { name: "content", type: "string", desc: "Overview body, in Markdown" },
  { name: "content-file", type: "string", value: "FILE", desc: "Read the overview from a file (- for stdin)" },
  { name: "lead", type: "string", value: "USER", desc: "Project lead" },
  { name: "status", short: "s", type: "string", desc: "Project status" },
  { name: "start-date", type: "string", value: "DATE", desc: "Start date (YYYY-MM-DD)" },
  { name: "target-date", type: "string", value: "DATE", desc: "Target date (YYYY-MM-DD)" },
  { name: "priority", type: "string", desc: "Priority" },
  { name: "label", type: "multi", desc: "Project label; repeatable" },
];

export const projectCommand = {
  name: "project", aliases: ["p"], summary: "Manage projects",
  commands: [
    {
      name: "list", summary: "List projects", run: projectList,
      options: [
        { name: "team", type: "string", desc: "Only this team's projects" },
        { name: "all-teams", type: "boolean", desc: "Projects of every team" },
        { name: "status", short: "s", type: "string", desc: "Only projects in this status" },
        { name: "include-archived", type: "boolean", desc: "Include archived projects" },
        jsonOption,
      ],
    },
    {
      name: "view", aliases: ["v"], summary: "View a project", run: projectView,
      args: [{ name: "project", desc: "A UUID, slug ID, exact name, or URL" }],
      options: [{ name: "web", short: "w", type: "boolean", desc: "Open in the browser" }, jsonOption, noPager],
    },
    {
      name: "create", summary: "Create a project", run: projectCreate,
      options: [...projectWrite, { name: "team", type: "multi", desc: "Team; repeatable" }],
    },
    {
      name: "update", summary: "Update a project", run: projectUpdate,
      args: [{ name: "project", required: true, desc: "Project ID, slug, or name" }],
      options: [
        ...projectWrite,
        { name: "clear-lead", type: "boolean", desc: "Remove the lead" },
        { name: "clear-start-date", type: "boolean", desc: "Remove the start date" },
        { name: "clear-target-date", type: "boolean", desc: "Remove the target date" },
      ],
    },
  ],
};

export const cycleCommand = {
  name: "cycle", aliases: ["cy"], summary: "View team cycles",
  commands: [
    { name: "list", summary: "List a team's cycles", run: cycleList, options: [teamOption, jsonOption] },
    {
      name: "view", summary: "View a cycle by number, name, or `active`", run: cycleView,
      args: [{ name: "cycle", required: true, desc: "Cycle number, name, or `active`" }],
      options: [teamOption, jsonOption, noPager],
    },
  ],
};

export const milestoneCommand = {
  name: "milestone", aliases: ["m"], summary: "Manage project milestones",
  commands: [
    { name: "list", summary: "List milestones for a project", run: milestoneList, options: [{ name: "project", type: "string", desc: "Project ID, slug, or name" }, jsonOption] },
    {
      name: "view", summary: "View milestone details", run: milestoneView,
      args: [{ name: "milestone", required: true, desc: "Milestone ID" }],
      options: [{ name: "project", type: "string", desc: "Project, to find a milestone by name" }, { name: "all", type: "boolean", desc: "List every issue, not just the first 10" }, jsonOption, noPager],
    },
    {
      name: "create", summary: "Create a milestone", run: milestoneCreate,
      options: [
        { name: "project", type: "string", desc: "Project ID, slug, or name" },
        { name: "name", short: "n", type: "string", desc: "Milestone name" },
        { name: "description", short: "d", type: "string", desc: "Description" },
        { name: "target-date", type: "string", value: "DATE", desc: "Target date (YYYY-MM-DD)" },
      ],
    },
    {
      name: "update", summary: "Update a milestone", run: milestoneUpdate,
      args: [{ name: "milestone", required: true, desc: "Milestone ID" }],
      options: [
        { name: "name", short: "n", type: "string", desc: "New name" },
        { name: "description", short: "d", type: "string", desc: "New description" },
        { name: "target-date", type: "string", value: "DATE", desc: "New target date (YYYY-MM-DD)" },
      ],
    },
  ],
};

export const documentCommand = {
  name: "document", aliases: ["docs", "doc"], summary: "Manage documents",
  commands: [
    {
      name: "list", summary: "List documents", run: documentList,
      options: [
        { name: "project", type: "string", desc: "Filter by project (UUID, slug ID, or name)" },
        { name: "issue", type: "string", desc: "Filter by issue" },
        { name: "team", type: "string", desc: "Filter by team" },
        { name: "initiative", type: "string", desc: "Filter by initiative" },
        { name: "creator", type: "string", desc: "Filter by creator" },
        { name: "query", short: "q", type: "string", desc: "Search document titles and content" },
        { name: "limit", type: "string", default: "50", desc: "Maximum number of documents (a number or `all`)" },
        jsonOption,
      ],
    },
    {
      name: "view", summary: "View a document", run: documentView,
      args: [{ name: "document", required: true, desc: "Document slug, ID, or URL" }],
      options: [
        { name: "raw", type: "boolean", desc: "Output raw markdown (for piping)" },
        { name: "web", short: "w", type: "boolean", desc: "Open in browser" },
        jsonOption, noPager,
      ],
    },
    {
      name: "create", summary: "Create a document", run: documentCreate,
      options: [
        { name: "title", short: "t", type: "string", desc: "Document title" },
        { name: "content", short: "c", type: "string", desc: "Content, in Markdown" },
        { name: "content-file", type: "string", value: "FILE", desc: "Read the content from a file" },
        { name: "project", type: "string", desc: "Attach to this project" },
        { name: "issue", type: "string", desc: "Attach to this issue" },
        { name: "team", type: "string", desc: "Attach to this team" },
        { name: "initiative", type: "string", desc: "Attach to this initiative" },
        { name: "cycle", type: "string", desc: "Attach to this cycle (with --team)" },
      ],
    },
    {
      name: "update", summary: "Update a document", run: documentUpdate,
      args: [{ name: "document", required: true, desc: "Document slug, ID, or URL" }],
      options: [
        { name: "title", short: "t", type: "string", desc: "New title" },
        { name: "content", short: "c", type: "string", desc: "New content, in Markdown" },
        { name: "content-file", type: "string", value: "FILE", desc: "Read the new content from a file" },
      ],
    },
  ],
};

export const labelCommand = {
  name: "label", aliases: ["l"], summary: "Manage issue labels",
  commands: [
    {
      name: "list", summary: "List issue labels", run: labelList,
      options: [
        { name: "team", type: "string", desc: "This team's labels and workspace labels" },
        { name: "all", type: "boolean", desc: "Labels of every team" },
        jsonOption,
      ],
    },
    {
      name: "create", summary: "Create an issue label", run: labelCreate,
      options: [
        { name: "name", short: "n", type: "string", desc: "Label name" },
        { name: "color", short: "c", type: "string", desc: "Color, like #ff0000" },
        { name: "description", short: "d", type: "string", desc: "Description" },
        { name: "team", type: "string", desc: "Team (omit for a workspace label)" },
      ],
    },
  ],
};

export const initiativeCommand = {
  name: "initiative", aliases: ["init"], summary: "Manage initiatives",
  commands: [
    { name: "list", summary: "List initiatives", run: initiativeList, options: [{ name: "status", short: "s", type: "string", desc: "Only initiatives in this status" }, jsonOption] },
    {
      name: "view", summary: "View an initiative", run: initiativeView,
      args: [{ name: "initiative", required: true, desc: "UUID, slug, or name" }],
      options: [jsonOption, noPager],
    },
  ],
};


