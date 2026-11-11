// Teams: groups of agents and skills for a domain (social media, mobile apps, websites, software...), split into roles
// (research, planning, execution...). Kept in teams.json (versioned). An agent or skill can belong to multiple teams and roles.
// Code validates structure; doctor checks member existence (a member can be missing on a machine not yet
// synced, without preventing the rest of the team from being saved).
import path from 'node:path';
import { readJson, writeJson } from './util.mjs';
import { searchIndex } from './search.mjs';
import { tFor } from './i18n.mjs';

export const TEAMS_FILE = 'teams.json';

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MEMBER_RE = /^(agent|skill):[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
export const LIMITS = { name: 60, description: 500, roles: 20, roleName: 40, roleDescription: 200, members: 200, teams: 50 };

export class TeamError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Reads teams.json ({version, teams}); if missing, returns empty teams list. */
export function loadTeams(root) {
  const data = readJson(path.join(root, TEAMS_FILE), { version: 1, teams: [] });
  return { version: 1, ...data, teams: Array.isArray(data.teams) ? data.teams : [] };
}

const text = (v, max, what, t = tFor()) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (s.length > max) throw new TeamError(t('teams.maxChars', { what, max }));
  return s;
};

function members(list, what, t = tFor()) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new TeamError(t('teams.membersNeedList', { what }));
  const out = [...new Set(list.map(String))];
  const bad = out.find((m) => !MEMBER_RE.test(m));
  if (bad !== undefined) throw new TeamError(t('teams.badMember', { what, bad: bad.slice(0, 60) }));
  if (out.length > LIMITS.members) throw new TeamError(t('teams.tooManyMembers', { what }));
  return out;
}

/**
 * Validates and normalizes a team. Skills placed in "agents" or agents in "skills" are an error.
 * @param {object} raw {id, name, description, categories, roles: [{id, name, description, agents, skills}]}
 * @param {{categories?: string[]}} opt valid categories (hub.config.json)
 */
export function checkTeam(raw, { categories = null, t = tFor() } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TeamError(t('teams.invalidTeam'));
  const id = String(raw.id ?? '');
  if (!ID_RE.test(id)) throw new TeamError(t('teams.invalidTeamId'));
  const name = text(raw.name, LIMITS.name, 'Name', t);
  if (!name) throw new TeamError(t('teams.nameRequired'));
  const cats = Array.isArray(raw.categories) ? [...new Set(raw.categories.map(String))] : [];
  if (categories) {
    const unknown = cats.filter((c) => !categories.includes(c));
    if (unknown.length) throw new TeamError(t('teams.unknownCategories', { list: unknown.join(', ') }));
  }
  if (!Array.isArray(raw.roles)) throw new TeamError(t('teams.rolesRequired'));
  if (raw.roles.length > LIMITS.roles) throw new TeamError(t('teams.tooManyRoles', { max: LIMITS.roles }));
  const seen = new Set();
  const roles = raw.roles.map((r, i) => {
    if (!r || typeof r !== 'object') throw new TeamError(t('teams.invalidRole', { num: i + 1 }));
    const rid = String(r.id ?? '');
    if (!ID_RE.test(rid)) throw new TeamError(t('teams.invalidRoleId', { num: i + 1 }));
    if (seen.has(rid)) throw new TeamError(t('teams.roleRepeated', { rid }));
    seen.add(rid);
    const rname = text(r.name, LIMITS.roleName, `Role ${rid}`, t);
    if (!rname) throw new TeamError(t('teams.roleNameRequired', { rid }));
    const agents = members(r.agents, `Role ${rname}, agents`, t);
    const skills = members(r.skills, `Role ${rname}, skills`, t);
    if (agents.some((m) => !m.startsWith('agent:'))) throw new TeamError(t('teams.agentHasSkill', { rname }));
    if (skills.some((m) => !m.startsWith('skill:'))) throw new TeamError(t('teams.skillHasAgent', { rname }));
    return { id: rid, name: rname, description: text(r.description, LIMITS.roleDescription, `Role ${rname}, description`, t), agents, skills };
  });
  return { id, name, description: text(raw.description, LIMITS.description, 'Description', t), categories: cats, roles };
}

/** Creates or updates a team (same id). Returns saved team. */
export function saveTeam(root, raw, opt = {}) {
  const t = tFor(root);
  const team = checkTeam(raw, { ...opt, t });
  const data = loadTeams(root);
  const i = data.teams.findIndex((tm) => tm.id === team.id);
  if (i < 0 && data.teams.length >= LIMITS.teams) throw new TeamError(t('teams.tooManyTeams', { max: LIMITS.teams }));
  if (opt.createOnly && i >= 0) throw new TeamError(t('teams.teamAlreadyExists', { id: team.id }), 409);
  if (i >= 0) data.teams[i] = team;
  else data.teams.push(team);
  writeJson(path.join(root, TEAMS_FILE), data);
  return team;
}

export function deleteTeam(root, id) {
  const t = tFor(root);
  const data = loadTeams(root);
  const i = data.teams.findIndex((tm) => tm.id === id);
  if (i < 0) throw new TeamError(t('teams.teamNotFound', { id: String(id).slice(0, 40) }), 404);
  data.teams.splice(i, 1);
  writeJson(path.join(root, TEAMS_FILE), data);
}

/** Removes a category from all teams (when deleted). Returns count of modified teams. */
export function dropCategoryFromTeams(root, category) {
  const data = loadTeams(root);
  let n = 0;
  for (const tm of data.teams) {
    if (Array.isArray(tm.categories) && tm.categories.includes(category)) {
      tm.categories = tm.categories.filter((c) => c !== category);
      n++;
    }
  }
  if (n) writeJson(path.join(root, TEAMS_FILE), data);
  return n;
}

/** All team members: {agents, skills} (unique ids). */
export function teamMembers(team) {
  const agents = new Set();
  const skills = new Set();
  for (const r of team.roles ?? []) {
    for (const a of r.agents ?? []) agents.add(a);
    for (const s of r.skills ?? []) skills.add(s);
  }
  return { agents: [...agents], skills: [...skills] };
}

/** Doctor diagnostics: invalid teams, members not in hub, empty roles. */
export function teamProblems(root, index) {
  const t = tFor(root);
  let data;
  try {
    data = loadTeams(root);
  } catch (e) {
    return [{ level: 'error', message: `${TEAMS_FILE}: ${e.message}` }];
  }
  const ids = new Set([...index.skills, ...index.agents].map((e) => e.id));
  const out = [];
  const seen = new Set();
  for (const raw of data.teams) {
    let tm;
    try {
      tm = checkTeam(raw, { t });
    } catch (e) {
      out.push({ level: 'error', message: t('teams.teamProblem', { file: TEAMS_FILE, id: String(raw?.id ?? '?').slice(0, 40), message: e.message }) });
      continue;
    }
    if (seen.has(tm.id)) out.push({ level: 'error', message: t('teams.duplicateTeamInFile', { file: TEAMS_FILE, id: tm.id }) });
    seen.add(tm.id);
    for (const r of tm.roles) {
      for (const m of [...r.agents, ...r.skills]) if (!ids.has(m)) out.push({ level: 'warn', message: t('teams.memberNotInHub', { name: tm.name, role: r.name, member: m }) });
      if (!r.agents.length && !r.skills.length) out.push({ level: 'info', message: t('teams.emptyRole', { name: tm.name, role: r.name }) });
    }
  }
  return out;
}

/** Minimum score for a team to be suggested for a request. */
export const TEAM_MIN_SCORE = 2;

/**
 * Teams matching a request: searched together with catalog (stable term weights).
 * @returns {{team: object, score: number}[]}
 */
export function matchTeams(index, config, teams, request) {
  if (!teams.length) return [];
  const entries = teams.map((tm) => ({
    id: `team:${tm.id}`,
    kind: 'team',
    name: tm.name,
    // roles indicate what the team does (e.g. "Research", "Security"): count as much as description
    description: [tm.description, ...tm.roles.map((r) => `${r.name} ${r.description ?? ''}`)].join(' '),
    categories: tm.categories ?? [],
    inferredCategories: [],
    capabilities: [],
    team: tm,
  }));
  const pool = { ...index, workflows: [...(index.workflows ?? []), ...entries] };
  return searchIndex(pool, config, request, { kind: 'any', limit: 60 })
    // a team is a domain: either the request mentions it (word in name or category evoked), or
    // it shares at least two words with its description
    .filter((h) => h.e.kind === 'team' && h.score >= TEAM_MIN_SCORE && (h.inScope || h.matched.length >= 2))
    .map((h) => ({ team: h.e.team, score: h.score }));
}

/** Team members by role, with display names (for route and CLI). */
export function describeTeam(team, index, t = tFor()) {
  const byId = new Map([...index.skills, ...index.agents].map((e) => [e.id, e]));
  const name = (id) => byId.get(id)?.name ?? `${id.replace(/^(agent|skill):/, '')}${t('teams.missingMemberLabel')}`;
  return {
    id: team.id,
    name: team.name,
    description: team.description,
    roles: team.roles.map((r) => ({ id: r.id, name: r.name, description: r.description, agents: r.agents.map(name), skills: r.skills.map(name) })),
  };
}

/** Method skills: orchestrator uses them across all teams, so they are not suggested as members. */
export const METHOD_SKILLS = new Set(['orchestrator', 'hub-manager', 'task-intake', 'acceptance-criteria', 'quality-gate', 'structured-handoff', 'decision-record', 'self-critique', 'memory'].map((n) => `skill:${n}`));

/**
 * Guided creation: for each role suggests best-matching skills and agents from catalog, searching role name
 * and description alongside team domain. Suggests only: choice remains with the user.
 * @param {{name?: string, description?: string, roles: {id: string, name: string, description?: string}[]}} draft
 * @returns {{roleId: string, agents: {id, name, score}[], skills: {id, name, score}[]}[]}
 */
export function suggestMembers(index, config, draft, { perRole = 5 } = {}) {
  const scope = `${draft.name ?? ''} ${draft.description ?? ''}`.trim();
  // team domain is only used to break ties between similar candidates (e.g. "security" in an app vs a site)
  const scopeScore = new Map(scope ? searchIndex(index, config, scope, { limit: 200 }).map((h) => [h.e.id, h.score]) : []);
  return (draft.roles ?? []).map((r) => {
    const q = `${r.name ?? ''} ${r.description ?? ''}`.trim();
    // role decides: an item is suggested only if it matches what the role does
    const ranked = (q ? searchIndex(index, config, q, { limit: 200 }) : [])
      .filter((h) => !h.e.duplicate && !METHOD_SKILLS.has(h.e.id))
      .map((h) => ({ e: h.e, score: h.score + 0.3 * (scopeScore.get(h.e.id) ?? 0), role: h.score }));
    const pick = (kind) => {
      const list = ranked.filter((x) => x.e.kind === kind).sort((a, b) => b.score - a.score);
      const top = list[0]?.role ?? 0; // below a third of the best match the relevance is coincidental
      return list.filter((x) => x.role >= top / 3).slice(0, perRole).map((x) => ({ id: x.e.id, name: x.e.name, score: Math.round(x.score * 100) / 100 }));
    };
    return { roleId: r.id, agents: pick('agent'), skills: pick('skill') };
  });
}

/** Default roles suggested for a new team when user does not specify any: applicable across domains. */
export const DEFAULT_ROLES = [
  { id: 'research', name: 'Research', description: 'research, market and competitor analysis, sources' },
  { id: 'planning', name: 'Planning', description: 'strategy, planning, architecture, design' },
  { id: 'execution', name: 'Execution', description: 'core work production and implementation' },
  { id: 'quality', name: 'Quality and security', description: 'review, testing, security' },
  { id: 'release', name: 'Release', description: 'publishing, deployment, delivery' },
];
