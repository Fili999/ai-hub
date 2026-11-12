// Security scanning with NVIDIA SkillSpector (https://github.com/NVIDIA/SkillSpector) before installing
// or updating skills and agents from GitHub. Policy (block / warn / off) is set in settings.json.
//
// Only executes the "skillspector" program with arguments configured here: target is always an
// absolute path to the temporary copy (never an option), output is JSON read from stdout. Exit contract:
// 0 = risk <= 50, 1 = risk > 50, 2 = error. An error or unreadable response is never treated as "safe".
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { commandPath } from './util.mjs';
import { readSettings } from './settings.mjs';
import { tFor } from './i18n.mjs';

const t = tFor();

const MAX_ISSUES = 8;
const ORDER = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, INFO: 0 };
const KNOWN_RECOMMENDATIONS = new Set(['SAFE', 'CAUTION', 'DO_NOT_INSTALL']);

/**
 * How to launch the scanner. AI_HUB_SKILLSPECTOR_SCRIPT (a .mjs/.js file executed with Node) overrides the
 * real program: used by tests for reproducible output across platforms.
 */
export function resolveScanner(env = process.env) {
  const script = env.AI_HUB_SKILLSPECTOR_SCRIPT;
  if (script) return fs.existsSync(script) ? { cmd: process.execPath, pre: [path.resolve(script)] } : null;
  const exe = commandPath('skillspector', env);
  return exe ? { cmd: exe, pre: [] } : null;
}

/** Current policy: {mode: 'block'|'warn'|'off', llm, scanner|null}. */
export function securityPolicy(root, env = process.env) {
  const s = readSettings(root);
  const mode = s['security.skillspector'];
  return { mode, llm: s['security.skillspectorLlm'], scanner: mode === 'off' ? null : resolveScanner(env) };
}

export function scannerVersion(scanner) {
  if (!scanner) return null;
  const r = spawnSync(scanner.cmd, [...scanner.pre, '--version'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  const m = /(\d+\.\d+(?:\.\d+)?)/.exec(`${r.stdout ?? ''} ${r.stderr ?? ''}`);
  return m ? m[1] : null;
}

/**
 * Scans a skill folder or agent .md file.
 * @returns {{ok:boolean, error?:string, score?:number, severity?:string, recommendation?:string, issueCount?:number,
 *            issues?:{id,severity,pattern,file,line,finding}[], complete?:boolean, llm?:boolean}}
 */
export function scanTarget(scanner, target, { llm = false, timeout = 180000, env = process.env } = {}) {
  if (!scanner) return { ok: false, error: t('spector.error.notInstalled') };
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) return { ok: false, error: t('spector.error.pathNotFound') };
  const args = [...scanner.pre, 'scan', abs, '--format', 'json', ...(llm ? [] : ['--no-llm'])];
  const r = spawnSync(scanner.cmd, args, { encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: { ...env, NO_COLOR: '1' } });
  if (r.error) return { ok: false, error: r.error.code === 'ETIMEDOUT' ? t('spector.error.timedOut') : r.error.message };
  if (r.status !== 0 && r.status !== 1) {
    const last = String(r.stderr || r.stdout || '').trim().split('\n').filter(Boolean).pop() ?? '';
    const detail = last ? `: ${last.slice(0, 200)}` : '';
    return { ok: false, error: t('spector.error.statusCode', { code: r.status, detail }) };
  }
  // A signal (killed by timeout or OOM) leaves status null: the output cannot be trusted either.
  if (r.signal) return { ok: false, error: t('spector.error.statusCode', { code: r.signal, detail: '' }) };
  let data;
  try {
    data = JSON.parse(r.stdout);
  } catch {
    return { ok: false, error: t('spector.error.unreadableResponse') };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: t('spector.error.unreadableResponse') };
  const ra = data.risk_assessment;
  if (!ra || typeof ra.recommendation !== 'string') return { ok: false, error: t('spector.error.missingAssessment') };
  // Fail-closed: a missing, non-numeric or out-of-range score is "unknown", never 0 (= no risk).
  const score = ra.score;
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100) return { ok: false, error: t('spector.error.invalidScore') };
  if (!KNOWN_RECOMMENDATIONS.has(ra.recommendation)) return { ok: false, error: t('spector.error.unknownRecommendation', { value: ra.recommendation.slice(0, 40) }) };
  // Exit code 1 means "risk > 50": a response of "SAFE" with that exit code is contradictory, so not trustworthy.
  if (r.status === 1 && ra.recommendation === 'SAFE') return { ok: false, error: t('spector.error.inconsistent') };
  const issues = (Array.isArray(data.issues) ? data.issues : [])
    .map((i) => ({
      id: String(i.id ?? ''),
      severity: String(i.severity ?? ''),
      pattern: String(i.pattern ?? i.category ?? ''),
      file: String(i.location?.file ?? ''),
      line: Number.isInteger(i.location?.start_line) ? i.location.start_line : null,
      finding: String(i.finding ?? '').slice(0, 160),
    }))
    .sort((a, b) => (ORDER[b.severity] ?? 0) - (ORDER[a.severity] ?? 0));
  return {
    ok: true,
    score,
    severity: String(ra.severity ?? ''),
    recommendation: ra.recommendation,
    issueCount: issues.length,
    issues: issues.slice(0, MAX_ISSUES),
    // Strict: only an explicit `true` counts. Missing, null or malformed completeness is "not verified".
    complete: data.analysis_completeness?.is_complete === true && data.execution_successful !== false && data.analysis_completeness?.execution_successful !== false,
    llm: Boolean(data.metadata?.llm_available ?? llm),
  };
}

/**
 * What to do with a result according to policy: 'pass' (install), 'warn' (install with warning),
 * 'block' (do not install). In "block" mode, a missing, failed, malformed or INCOMPLETE scan blocks
 * installation (fail-closed). Only a complete scan with recommendation SAFE can ever 'pass'; even then
 * it means "the scanner found nothing", not "this content is harmless" (SkillSpector is not a sandbox).
 */
export function verdict(scan, mode) {
  if (mode === 'off') return 'pass';
  if (!scan?.ok) return mode === 'block' ? 'block' : 'warn';
  if (scan.complete !== true) return mode === 'block' ? 'block' : 'warn';
  if (scan.recommendation === 'DO_NOT_INSTALL') return mode === 'block' ? 'block' : 'warn';
  if (scan.recommendation === 'SAFE') return 'pass';
  return 'warn'; // CAUTION or new values: always warn
}

/** Human-readable line for terminal and UI. */
export function describeScan(scan) {
  if (!scan) return t('spector.describe.notAnalyzed');
  if (!scan.ok) return t('spector.describe.failed', { error: scan.error });
  const recMap = {
    SAFE: t('spector.rec.safe'),
    CAUTION: t('spector.rec.caution'),
    DO_NOT_INSTALL: t('spector.rec.doNotInstall'),
  };
  const rec = recMap[scan.recommendation] ?? scan.recommendation;
  const partial = scan.complete === true ? '' : t('spector.describe.partial');
  return t('spector.describe.summary', { rec, score: scan.score, issues: scan.issueCount, partial });
}

export const missingScannerHelp = Object.assign(
  () => t('spector.missingScannerHelp'),
  {
    toString: () => t('spector.missingScannerHelp'),
    [Symbol.toPrimitive]: () => t('spector.missingScannerHelp'),
  }
);
