// Minimal routing (Phase E): request → working mode → workflow → capabilities → skills/agents.
// Deterministic and LLM-free: suggests, does not decide. Size is determined by intake (skill task-intake);
// used here to avoid launching heavy processes on small tasks. Quality over savings: even in direct mode,
// tasks end with proportionate verification.
import { searchIndex } from './search.mjs';
import { SIZES, normalizeSize } from './schema.mjs';
import { savingRules } from './budget.mjs';
import { workflowHint } from './evaluation.mjs';
import { describeTeam, matchTeams } from './teams.mjs';
import { tFor } from './i18n.mjs';

/** Skills and agents providing a capability, sorted by reliability: own, then approved external, then others. */
export function providers(index, capability) {
  const rank = (e) => (e.origin === 'own' ? 0 : e.approval === 'approved' ? 1 : e.approval === 'review-pending' ? 2 : 3);
  return [...index.skills, ...index.agents]
    .filter((e) => (e.capabilities ?? []).includes(capability) && !e.duplicate && e.approval !== 'hash-mismatch')
    .sort((a, b) => rank(a) - rank(b) || (a.kind === b.kind ? 0 : a.kind === 'skill' ? -1 : 1) || a.name.localeCompare(b.name))
    .map((e) => ({ id: e.id, name: e.name, kind: e.kind, origin: e.origin, approval: e.approval ?? null, file: e.file, tokens: e.tokens ?? null }));
}

// Working method capabilities (core skills): suggested when no specific workflow matches.
const CORE_FLOW = { small: ['quality-gate'], medium: ['task-intake', 'acceptance-criteria', 'quality-gate'], large: ['task-intake', 'acceptance-criteria', 'quality-gate', 'structured-handoff', 'decision-record'] };

/** Minimum score for a workflow to be considered relevant (below this, matches are coincidental). */
export const WORKFLOW_MIN_SCORE = 2;

/**
 * @param {object} index  hub index (ensureIndex)
 * @param {object} config hub.config.json
 * @param {string} request request text
 * @param {{size?: 'small'|'medium'|'large', saving?: string, critique?: string, improvements?: string}} opt size determined by intake (optional) and
 *   token saving level from Settings (optional, default "off")
 * @returns {{request, size, mode: 'direct'|'workflow'|'general', workflow, alternatives, capabilities, related, notes}}
 */
export function route(index, config, request, { size: rawSize, saving = 'off', critique = 'final', improvements = 'propose', memory = 'propose', history = [], teams = [], team: forcedTeam = null, t = tFor() } = {}) {
  const size = rawSize ? normalizeSize(rawSize) : undefined; // accepts small|medium|large and the old Italian names
  if (rawSize && !size) throw new Error(t('route.badSize', { sizes: SIZES.join(', ') }));
  const notes = [];
  const budget = savingRules(saving, t);
  // self-critique (Settings): never on small tasks; "phases" = after the gate of each phase
  const selfCritique = { mode: size === 'small' ? 'off' : ['final', 'phases', 'off'].includes(critique) ? critique : 'final', improvements: improvements === 'apply-own' ? 'apply-own' : 'propose' };
  // memory (Settings): never on small tasks
  const memoryMode = size === 'small' ? 'off' : ['propose', 'auto', 'off'].includes(memory) ? memory : 'propose';
  // team (teams.json): requested by user, or best match for request; never on small tasks
  let team = null;
  if (forcedTeam) {
    const tr = teams.find((x) => x.id === forcedTeam);
    if (!tr) throw new Error(t('route.teamNotFound', { team: forcedTeam, list: teams.map((x) => x.id).join(', ') || '(none)' }));
    team = describeTeam(tr, index);
  } else if (size !== 'small') {
    const m = matchTeams(index, config, teams, request);
    if (m.length) team = { ...describeTeam(m[0].team, index), alternatives: m.slice(1, 3).map((x) => x.team.id) };
  }
  if (team) notes.push(t('route.teamNote', { name: team.name, id: team.id }));
  const withCritique = (caps) => (selfCritique.mode === 'off' ? caps : [...caps, ...resolve(['self-critique'])]);
  const resolve = (ids, optional = false) =>
    ids.map((id) => {
      const list = providers(index, id);
      return { id, optional, chosen: list[0] ?? null, alternatives: list.slice(1) };
    });

  // term weights are computed across the entire catalog: with few workflows scores would be unstable.
  // Requires at least one common word plus scope (word in name or category) or a second word:
  // neither category alone ("social" for a post) nor a stop word ("plan" in "business plan") suffices.
  const wfHits = searchIndex(index, config, request, { kind: 'any', limit: 50 })
    .filter((h) => h.e.kind === 'workflow' && h.score >= WORKFLOW_MIN_SCORE && h.matched.length && (h.inScope || h.matched.length >= 2))
    .slice(0, 3);
  const fitting = wfHits.filter((h) => !size || !h.e.sizes.length || h.e.sizes.includes(size));
  const found = searchIndex(index, config, request, { limit: 8 }).map(({ e, score }) => ({ id: e.id, name: e.name, kind: e.kind, origin: e.origin, score, file: e.file }));
  // skills already selected for capabilities are not repeated in related skills
  const relatedTo = (caps, n = 5) => found.filter((s) => !caps.some((c) => c.chosen?.id === s.id)).slice(0, n);

  // small task: no workflow or agent, but proportionate final verification
  if (size === 'small') {
    notes.push(t('route.noteSmall'));
    if (wfHits.length && !fitting.length) notes.push(t('route.noteWorkflowTooBig', { name: wfHits[0].e.name }));
    const caps = resolve(CORE_FLOW.small);
    return { request, size, budget, selfCritique, memory: memoryMode, team, mode: 'direct', workflow: null, alternatives: [], capabilities: caps, related: relatedTo(caps, 3), notes };
  }

  if (fitting.length) {
    const wf = fitting[0].e;
    const hint = workflowHint(history, wf.name);
    if (hint) notes.push(hint);
    if (!size) notes.push(t('route.noteNoSize'));
    const caps = withCritique([...resolve(wf.capabilities), ...resolve(wf.optionalCapabilities, true)]);
    for (const c of caps) {
      if (!c.chosen) notes.push(c.optional ? t('route.noteOptionalCapMissing', { id: c.id }) : t('route.noteCapMissing', { id: c.id }));
    }
    return {
      request,
      size: size ?? null,
      budget,
      selfCritique,
      memory: memoryMode,
      team,
      mode: 'workflow',
      workflow: { id: wf.id, name: wf.name, description: wf.description, file: wf.file, score: fitting[0].score },
      alternatives: fitting.slice(1).map((h) => ({ id: h.e.id, name: h.e.name, score: h.score })),
      capabilities: caps,
      related: relatedTo(caps),
      notes,
    };
  }

  notes.push(t('route.noteGeneralMethod'));
  const hint = workflowHint(history, null);
  if (hint) notes.push(hint);
  const caps = withCritique(resolve(CORE_FLOW[size ?? 'medium']));
  const related = relatedTo(caps);
  if (!related.length) notes.push(t('route.noteNoRelated'));
  return { request, size: size ?? null, budget, selfCritique, memory: memoryMode, team, mode: 'general', workflow: null, alternatives: [], capabilities: caps, related, notes };
}
