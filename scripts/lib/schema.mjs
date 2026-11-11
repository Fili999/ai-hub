// Frontmatter contract for skills and agents (see docs/contracts.md): which fields exist, who reads them,
// and validation on values. Pure (no file system), used by scan.mjs and tested.
// Checks produce only warnings or info: an existing file never becomes invalid due to an unrecognized field.
import { tFor } from './i18n.mjs';

const t = tFor();

/** Fields read by hub scripts (for both kinds, unless otherwise noted). */
export const HUB_FIELDS = ['name', 'description', 'categories', 'capabilities', 'requires-commands', 'requires-mcp', 'depends', 'conflicts', 'model', 'effort', 'model-tier', 'effort-tier', 'codex-model', 'codex-effort', 'antigravity-model', 'gemini-model', 'opencode-model', 'opencode-effort'];

/** Claude Code native fields: hub passes them through as-is (sync links without converting). */
export const NATIVE_FIELDS = {
  skill: ['allowed-tools', 'license', 'metadata', 'version', 'argument-hint', 'disable-model-invocation', 'user-invocable', 'context', 'agent', 'hooks', 'paths', 'when_to_use'],
  agent: ['tools', 'disallowedTools', 'skills', 'permissionMode', 'hooks', 'color', 'mcpServers', 'memory', 'maxTurns', 'background', 'isolation', 'initialPrompt'],
};

/** Workflows (workflows/<name>.md): read only by the hub (routing), not by Claude Code. */
export const WORKFLOW_FIELDS = ['name', 'description', 'categories', 'capabilities', 'optional-capabilities', 'sizes'];
/** Job sizes: small, medium, large. The old Italian names (piccolo, medio, grande) are still accepted as input. */
export const SIZES = ['small', 'medium', 'large'];
const SIZE_ALIASES = { piccolo: 'small', medio: 'medium', grande: 'large' };
/** 'medium' / 'medio' → 'medium'; null when it is not a size. */
export const normalizeSize = (v) => {
  const s = String(v ?? '').trim().toLowerCase();
  return SIZES.includes(s) ? s : (SIZE_ALIASES[s] ?? null);
};

export const knownFields = (kind) => new Set(kind === 'workflow' ? WORKFLOW_FIELDS : [...HUB_FIELDS, ...(NATIVE_FIELDS[kind] ?? [])]);

/** Recommended identifier format for new own items and capabilities (docs/naming.md). */
export const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function distance(a, b) {
  const m = a.length;
  const n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[m][n];
}

/** The closest known field (probable typo), or null. */
export function closestField(key, kind) {
  const k = key.toLowerCase().replace(/_/g, '-');
  let best = null;
  let bestD = Infinity;
  for (const f of knownFields(kind)) {
    const d = distance(k, f.toLowerCase().replace(/_/g, '-'));
    if (d < bestD) [best, bestD] = [f, d];
  }
  const limit = key.length <= 5 ? 1 : 2;
  return best !== key && bestD <= limit ? best : null;
}

/**
 * Checks an item's frontmatter. Returns warnings {level, type, message} without id (caller prepends it).
 * External third-party items are not judged on field names: only values consumed by the hub are verified.
 */
export function checkFrontmatter(kind, data, { origin = 'own', name = '' } = {}) {
  const out = [];
  const own = origin === 'own';
  const known = knownFields(kind);
  if (own) {
    for (const key of Object.keys(data)) {
      if (known.has(key)) continue;
      const near = closestField(key, kind);
      if (near) out.push({ level: 'warn', type: 'field-typo', message: t('schema.warning.fieldTypo', { key, near }) });
      else out.push({ level: 'info', type: 'unknown-field', message: t('schema.warning.unknownField', { key }) });
    }
    if (name && !KEBAB_RE.test(name)) out.push({ level: 'info', type: 'naming', message: t('schema.warning.naming', { name, example: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') }) });
  }
  if (data.description != null && typeof data.description !== 'string') out.push({ level: 'warn', type: 'invalid-field', message: t('schema.warning.descriptionNotString') });
  if (data.name != null && typeof data.name !== 'string') out.push({ level: 'warn', type: 'invalid-field', message: t('schema.warning.nameNotString') });
  const listOf = (v) => (v == null ? [] : Array.isArray(v) ? v : String(v).split(',')).map((x) => String(x).trim()).filter(Boolean);
  for (const c of [...listOf(data.capabilities), ...listOf(data['optional-capabilities'])]) {
    if (!KEBAB_RE.test(c)) out.push({ level: 'warn', type: 'invalid-capability', message: t('schema.warning.invalidCapability', { capability: c }) });
  }
  if (kind === 'workflow') {
    for (const s of listOf(data.sizes)) if (!normalizeSize(s)) out.push({ level: 'warn', type: 'invalid-field', message: t('schema.warning.invalidSize', { size: s, valid: SIZES.join(', ') }) });
  }
  return out;
}

/** Valid capabilities (kebab-case, deduplicated) from frontmatter value. */
export function parseCapabilities(value) {
  const list = value == null ? [] : Array.isArray(value) ? value : String(value).split(',');
  return [...new Set(list.map((x) => String(x).trim()).filter((c) => KEBAB_RE.test(c)))];
}

/** Dependency cycles: lists of ids [a, b, ..., a]. `deps` is a Map of id → ids it depends on. */
export function findCycles(deps) {
  const cycles = [];
  const seen = new Set();
  const state = new Map(); // 1 = visiting, 2 = done
  const stack = [];
  const visit = (id) => {
    state.set(id, 1);
    stack.push(id);
    for (const d of deps.get(id) ?? []) {
      if (!deps.has(d)) continue;
      if (state.get(d) === 1) {
        const cyc = stack.slice(stack.indexOf(d)).concat(d);
        const key = [...cyc.slice(0, -1)].sort().join('|');
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(cyc);
        }
      } else if (!state.has(d)) visit(d);
    }
    stack.pop();
    state.set(id, 2);
  };
  for (const id of deps.keys()) if (!state.has(id)) visit(id);
  return cycles;
}
