#!/usr/bin/env node
// Agent and skill teams by domain (teams.json): listing, role breakdown, members, suggestions for a new team.
//   node scripts/team.mjs list [--json]
//   node scripts/team.mjs show <team> [--json]
//   node scripts/team.mjs add <team> <role> agent:<name>|skill:<name>
//   node scripts/team.mjs remove <team> <role> agent:<name>|skill:<name>
//   node scripts/team.mjs suggest "<name or domain>" [--roles research,dev,security] [--json]
import path from 'node:path';
import { HUB_ROOT, csv, parseArgs, readJson } from './lib/util.mjs';
import { ensureIndex } from './lib/scan.mjs';
import { DEFAULT_ROLES, TeamError, describeTeam, loadTeams, saveTeam, suggestMembers } from './lib/teams.mjs';
import { tFor } from './lib/i18n.mjs';

const t = tFor(HUB_ROOT);
const { flags, positional } = parseArgs(process.argv.slice(2), { boolean: ['json'] });
const [cmd, ...rest] = positional;
const index = ensureIndex(HUB_ROOT);
const config = readJson(path.join(HUB_ROOT, 'hub.config.json'), { categories: {}, synonymGroups: [] });
const out = (data, lines) => console.log(flags.json ? JSON.stringify(data, null, 2) : lines.join('\n'));

function find(id) {
  const tItem = loadTeams(HUB_ROOT).teams.find((x) => x.id === id);
  if (!tItem) throw new TeamError(t('team.notFound', { id, list: loadTeams(HUB_ROOT).teams.map((x) => x.id).join(', ') || t('team.none') }), 404);
  return tItem;
}

try {
  if (cmd === 'list') {
    const teams = loadTeams(HUB_ROOT).teams;
    out(teams.map((tm) => describeTeam(tm, index)), teams.length ? teams.map((tm) => `${tm.id} — ${tm.name}: ${tm.roles.map((r) => r.name).join(', ')}`) : [t('team.emptyList')]);
  } else if (cmd === 'show') {
    const d = describeTeam(find(rest[0]), index);
    out(d, [`${d.name}${d.description ? ` — ${d.description}` : ''}`, ...d.roles.flatMap((r) => [`  ${r.name}:`, `    agents: ${r.agents.join(', ') || '—'}`, `    skills: ${r.skills.join(', ') || '—'}`])]);
  } else if (cmd === 'add' || cmd === 'remove') {
    const [teamId, roleId, ref] = rest;
    if (!teamId || !roleId || !/^(agent|skill):/.test(ref ?? '')) throw new TeamError(t('team.usageAddRemove'));
    const tm = structuredClone(find(teamId));
    const role = tm.roles.find((r) => r.id === roleId);
    if (!role) throw new TeamError(t('team.roleNotFound', { roleId, list: tm.roles.map((r) => r.id).join(', ') }), 404);
    const key = ref.startsWith('agent:') ? 'agents' : 'skills';
    if (cmd === 'add') {
      if (![...index.skills, ...index.agents].some((e) => e.id === ref)) throw new TeamError(t('team.itemNotInHub', { ref }), 404);
      role[key] = [...new Set([...role[key], ref])];
    } else role[key] = role[key].filter((m) => m !== ref);
    saveTeam(HUB_ROOT, tm);
    console.log(t('team.itemActionDone', { name: tm.name, role: role.name, action: cmd === 'add' ? t('team.added') : t('team.removed'), ref }));
  } else if (cmd === 'suggest') {
    const name = rest.join(' ').trim();
    if (!name) throw new TeamError(t('team.usageSuggest'));
    const roles = flags.roles && flags.roles !== true ? csv(flags.roles).map((r) => ({ id: r.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name: r })) : DEFAULT_ROLES;
    const s = suggestMembers(index, config, { name, roles });
    out(s, roles.map((r, i) => `${r.name}: agents ${s[i].agents.map((a) => a.name).join(', ') || '—'} · skills ${s[i].skills.map((x) => x.name).join(', ') || '—'}`));
  } else {
    console.error(t('team.unknownCommand'));
    process.exit(2);
  }
} catch (e) {
  if (!(e instanceof TeamError)) throw e;
  console.error(`✖ ${e.message}`);
  process.exit(e.status === 404 ? 1 : 2);
}
