// Linear operations on top of the MCP server's tools, and normalizers that
// turn the MCP's loosely shaped results into the shapes schpet/linear-cli
// prints (and emits with --json), so scripts work with either tool.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { CliError, EXIT, notFound } from "./errors.js";
import { PRIORITY_NAMES } from "./format.js";

// Tool names, with older or alternative spellings as fallbacks.
export const TOOLS = {
  listIssues: ["list_issues"],
  getIssue: ["get_issue"],
  saveIssue: ["save_issue"],
  createIssue: ["save_issue", "create_issue"],
  updateIssue: ["save_issue", "update_issue"],
  deleteIssue: ["delete_issue"],
  archiveIssue: ["archive_issue"],
  listComments: ["list_comments"],
  createComment: ["save_comment", "create_comment"],
  updateComment: ["save_comment", "update_comment"],
  deleteComment: ["delete_comment"],
  listTeams: ["list_teams"],
  getTeam: ["get_team"],
  listUsers: ["list_users"],
  getUser: ["get_user"],
  listProjects: ["list_projects"],
  getProject: ["get_project"],
  listStatuses: ["list_issue_statuses"],
  listLabels: ["list_issue_labels"],
  listCycles: ["list_cycles"],
  listMilestones: ["list_milestones", "list_project_milestones"],
  getMilestone: ["get_milestone", "get_project_milestone"],
  listDocuments: ["list_documents"],
  getDocument: ["get_document"],
  listInitiatives: ["list_initiatives"],
  getInitiative: ["get_initiative"],
};

// ---------------------------------------------------------------- shapes

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** The array in a list result, whatever key the server put it under. */
export function items(result, ...keys) {
  if (Array.isArray(result)) return result;
  if (!isObj(result)) return [];
  for (const key of [...keys, "nodes", "items", "results", "data", "edges"]) {
    const value = result[key];
    if (Array.isArray(value)) return value.map((v) => (isObj(v) && isObj(v.node) ? v.node : v));
    if (isObj(value) && Array.isArray(value.nodes)) return value.nodes;
  }
  const arrays = Object.values(result).filter(Array.isArray);
  return arrays.length === 1 ? arrays[0] : [];
}

/** The cursor for the next page, if the result says there is one. */
export function nextCursor(result) {
  if (!isObj(result)) return null;
  const info = result.pageInfo ?? Object.values(result).find((v) => isObj(v) && isObj(v.pageInfo))?.pageInfo;
  if (info) return info.hasNextPage ? info.endCursor ?? null : null;
  if (result.hasNextPage === false) return null;
  return result.nextCursor ?? result.cursor ?? result.endCursor ?? null;
}

/** The single entity in a get result. */
export function one(result, ...keys) {
  if (!isObj(result)) return result;
  for (const key of keys) if (isObj(result[key])) return result[key];
  return result;
}

const displayName = (v) => (typeof v === "string" ? v : isObj(v) ? v.displayName || v.name || v.title || v.email || "" : "");

export function initials(name) {
  const words = String(name ?? "").trim().split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words.at(-1)[0]).toUpperCase();
}

export function normUser(v, id) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "string") return { id: id ?? null, name: v, displayName: v, initials: initials(v) };
  const name = v.name ?? v.displayName ?? "";
  return {
    id: v.id ?? id ?? null,
    name,
    displayName: v.displayName ?? name,
    email: v.email ?? undefined,
    initials: v.initials ?? initials(v.displayName || name),
    url: v.url ?? undefined,
  };
}

function normNamed(v, id) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "string") return { id: id ?? null, name: v };
  return { ...v, id: v.id ?? id ?? null, name: displayName(v) };
}

export function normPriority(raw) {
  let value = raw;
  let label;
  if (isObj(raw)) {
    value = raw.value ?? raw.priority;
    label = raw.name ?? raw.label;
  }
  if (typeof value === "string" && !/^\d+$/.test(value)) {
    const index = PRIORITY_NAMES.findIndex((n) => n.toLowerCase() === value.toLowerCase());
    label = value;
    value = index >= 0 ? index : 0;
  }
  value = Number(value ?? 0) || 0;
  return { priority: value, priorityLabel: label ?? PRIORITY_NAMES[value] ?? String(value) };
}

function normLabels(v) {
  const list = Array.isArray(v) ? v : items(v, "labels");
  return { nodes: list.map((l) => (typeof l === "string" ? { name: l } : { ...l, name: displayName(l) })) };
}

function normState(raw) {
  const state = raw.state ?? raw.status ?? raw.workflowState;
  if (state === undefined || state === null) return { name: "", type: raw.statusType ?? raw.stateType ?? "" };
  if (typeof state === "string") {
    return { id: raw.stateId ?? raw.statusId ?? null, name: state, type: raw.statusType ?? raw.stateType ?? "" };
  }
  return { ...state, name: displayName(state), type: state.type ?? raw.statusType ?? "" };
}

export function teamKeyOf(identifier) {
  const m = /^([A-Za-z0-9]+)-\d+$/.exec(identifier ?? "");
  return m ? m[1].toUpperCase() : null;
}

function normCycle(raw) {
  const c = raw.cycle;
  if (c === undefined || c === null || c === "") return null;
  if (typeof c === "number" || /^\d+$/.test(String(c))) return { id: raw.cycleId ?? null, number: Number(c), name: null };
  if (typeof c === "string") return { id: raw.cycleId ?? null, number: null, name: c };
  return { ...c };
}

export function normIssue(raw) {
  if (!isObj(raw)) return raw;
  const identifier = raw.identifier ?? raw.id;
  const team = raw.team;
  const teamObj = isObj(team)
    ? { ...team, key: team.key ?? teamKeyOf(identifier), name: displayName(team) }
    : { id: raw.teamId ?? null, key: teamKeyOf(identifier), name: team ?? null };
  const children = raw.children ?? raw.subIssues ?? raw.subissues;
  const comments = raw.comments;
  const issue = {
    id: raw.uuid ?? raw.id,
    identifier,
    title: raw.title ?? "",
    description: raw.description ?? null,
    url: raw.url ?? null,
    branchName: raw.branchName ?? raw.gitBranchName ?? null,
    ...normPriority(raw.priority),
    estimate: isObj(raw.estimate) ? raw.estimate.value ?? null : raw.estimate ?? null,
    dueDate: raw.dueDate ?? null,
    state: normState(raw),
    assignee: normUser(raw.assignee, raw.assigneeId),
    delegate: normUser(raw.delegate, raw.delegateId),
    creator: normUser(raw.creator ?? raw.createdBy, raw.creatorId ?? raw.createdById),
    team: teamObj,
    project: normNamed(raw.project, raw.projectId),
    projectMilestone: normNamed(raw.projectMilestone ?? raw.milestone, raw.projectMilestoneId ?? raw.milestoneId),
    cycle: normCycle(raw),
    labels: normLabels(raw.labels ?? []),
    parent: raw.parent
      ? (typeof raw.parent === "string" ? { identifier: raw.parent } : { ...raw.parent })
      : raw.parentId ? { id: raw.parentId, identifier: raw.parentIdentifier ?? raw.parentId } : null,
    children: { nodes: (Array.isArray(children) ? children : items(children)).map((c) => (isObj(c) ? normIssue(c) : { identifier: c })) },
    attachments: { nodes: Array.isArray(raw.attachments) ? raw.attachments : items(raw.attachments) },
    documents: { nodes: Array.isArray(raw.documents) ? raw.documents : items(raw.documents) },
    createdAt: raw.createdAt ?? null,
    updatedAt: raw.updatedAt ?? null,
    completedAt: raw.completedAt ?? null,
    archivedAt: raw.archivedAt ?? null,
  };
  if (comments !== undefined) issue.comments = { nodes: (Array.isArray(comments) ? comments : items(comments)).map(normComment) };
  // Keep the identity fields straight when the server only gives one id.
  if (issue.id === issue.identifier && raw.uuid === undefined && raw.identifier === undefined) issue.id = null;
  return issue;
}

export function normComment(raw) {
  if (!isObj(raw)) return raw;
  const parent = raw.parent ?? (raw.parentId ? { id: raw.parentId } : null);
  return {
    id: raw.id,
    body: raw.body ?? raw.text ?? "",
    quotedText: raw.quotedText ?? null,
    createdAt: raw.createdAt ?? null,
    updatedAt: raw.updatedAt ?? raw.createdAt ?? null,
    editedAt: raw.editedAt ?? null,
    url: raw.url ?? null,
    resolvedAt: raw.resolvedAt ?? null,
    resolvingCommentId: raw.resolvingCommentId ?? null,
    resolvingUser: normUser(raw.resolvingUser),
    user: normUser(raw.user ?? raw.author ?? raw.createdBy, raw.userId ?? raw.authorId),
    externalUser: raw.externalUser ?? null,
    botActor: raw.botActor ?? null,
    parent: parent ? (typeof parent === "string" ? { id: parent } : parent) : null,
  };
}

export function normTeam(raw) {
  if (!isObj(raw)) return { id: null, key: String(raw), name: String(raw) };
  return {
    ...raw,
    id: raw.id ?? null,
    key: raw.key ?? raw.identifier ?? "",
    name: raw.name ?? "",
    cyclesEnabled: Boolean(raw.cyclesEnabled ?? raw.cycles_enabled ?? (raw.activeCycle !== undefined && raw.activeCycle !== null)),
    updatedAt: raw.updatedAt ?? raw.createdAt ?? null,
  };
}

export function normProject(raw) {
  if (!isObj(raw)) return raw;
  const status = raw.status ?? raw.state;
  const teams = raw.teams ?? (raw.team ? [raw.team] : []);
  return {
    ...raw,
    id: raw.id ?? null,
    slugId: raw.slugId ?? raw.slug ?? (raw.url ? String(raw.url).split("/").filter(Boolean).at(-1)?.match(/([0-9a-f]{12})$/)?.[1] : null) ?? null,
    name: raw.name ?? "",
    status: isObj(status) ? { ...status, name: displayName(status) } : { name: status ?? "" },
    ...normPriority(raw.priority),
    health: raw.health ?? null,
    lead: normUser(raw.lead, raw.leadId),
    teams: { nodes: (Array.isArray(teams) ? teams : items(teams)).map((t) => (isObj(t) ? normTeam(t) : { key: t, name: t })) },
    startDate: raw.startDate ?? null,
    targetDate: raw.targetDate ?? null,
    url: raw.url ?? null,
    updatedAt: raw.updatedAt ?? null,
  };
}

// ---------------------------------------------------------------- disk cache

function cacheFile(server) {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  const hash = crypto.createHash("sha1").update(server).digest("hex").slice(0, 10);
  return path.join(base, "linear-mcp-cli", `teams-${hash}.json`);
}

function readCache(file, maxAgeMs) {
  if (process.env.LINEAR_NO_CACHE) return null;
  try {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs > maxAgeMs) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeCache(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  } catch {
    /* caching is best effort */
  }
}

// ---------------------------------------------------------------- API

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class Linear {
  constructor(client, { server = "" } = {}) {
    this.mcp = client;
    this.server = server;
  }

  /** Every page of a list tool, up to `limit` items (Infinity for all). */
  async paginate(tool, params, limit, ...keys) {
    const out = [];
    let cursor;
    const pageSize = 250;
    for (;;) {
      const want = Number.isFinite(limit) ? Math.min(pageSize, limit - out.length) : pageSize;
      const result = await this.mcp.call(tool, { ...params, limit: want, ...(cursor ? { cursor } : {}) });
      const page = items(result, ...keys);
      out.push(...page);
      cursor = nextCursor(result);
      if (!cursor || page.length === 0 || out.length >= limit) break;
    }
    return Number.isFinite(limit) ? out.slice(0, limit) : out;
  }

  async teams({ refresh = false } = {}) {
    const file = cacheFile(this.server);
    if (!refresh) {
      const cached = readCache(file, 24 * 3600 * 1000);
      if (cached) return cached;
    }
    const teams = (await this.paginate(TOOLS.listTeams, {}, Infinity, "teams")).map(normTeam);
    writeCache(file, teams);
    return teams;
  }

  /** A team by key, name, or ID. */
  async team(ref) {
    const match = (teams) => teams.find((t) => t.id === ref)
      ?? teams.find((t) => t.key && t.key.toLowerCase() === ref.toLowerCase())
      ?? teams.find((t) => t.name && t.name.toLowerCase() === ref.toLowerCase());
    let found = match(await this.teams());
    if (!found) found = match(await this.teams({ refresh: true }));
    if (!found) {
      if (UUID.test(ref)) return { id: ref, key: ref, name: ref };
      throw notFound(`Team not found: ${ref}`, "Run `linear team list` to see the teams.");
    }
    return found;
  }

  async issues(params, limit) {
    return (await this.paginate(TOOLS.listIssues, params, limit, "issues")).map(normIssue);
  }

  async issue(id, { withRelations = false } = {}) {
    let result;
    try {
      result = await this.mcp.call(TOOLS.getIssue, withRelations ? { id, includeRelations: true } : { id });
    } catch (error) {
      if (error.code === EXIT.notFound || /not found/i.test(error.message)) {
        throw notFound(`Issue not found: ${id}`);
      }
      throw error;
    }
    if (result === null || result === undefined || (typeof result === "string" && /not found/i.test(result))) {
      throw notFound(`Issue not found: ${id}`);
    }
    if (typeof result === "string") throw new CliError(result);
    return normIssue(one(result, "issue"));
  }

  async comments(issueId) {
    return (await this.paginate(TOOLS.listComments, { issueId }, Infinity, "comments")).map(normComment);
  }

  async statuses(team) {
    const list = items(await this.mcp.cached(TOOLS.listStatuses, { team }), "statuses", "states", "issueStatuses");
    return list.map((s) => (typeof s === "string" ? { name: s, type: "" } : { ...s, name: displayName(s) }));
  }

  async me() {
    return normUser(one(await this.mcp.cached(TOOLS.getUser, { query: "me" }), "user"));
  }
}

export { UUID };
