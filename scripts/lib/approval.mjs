// Approvals for external skills and agents (docs/external-skills.md, docs/decisions.md).
// Stored in manifest.lock.json entries (version 2, backwards compatible with format 1):
//   package:  { path, hash }  — directory copied to the hub (skill or full package) and its SHA-256
//   approval: { status, hash, at, via, platform } — user decision tied to exact hash
// An approval is valid only for that hash: if content changes (or differs on another machine) it is invalidated.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { listFiles } from './util.mjs';
import { isInside } from './safefs.mjs';
import { platformLabel } from './machine.mjs';
import { tFor } from './i18n.mjs';

const t = tFor();

export const LOCK_VERSION = 2;
export const POLICY_VERSION = 1;

/**
 * SHA-256 of a file or directory: sorted relative paths (with "/") and exact file bytes,
 * without normalization. Skips items not copied by installer (.git, node_modules, symlinks).
 */
export function packageHash(p) {
  const h = crypto.createHash('sha256');
  const st = fs.statSync(p);
  if (st.isFile()) h.update(fs.readFileSync(p));
  else {
    for (const rel of listFiles(p, { maxFiles: 200000, maxDepth: 40 })) {
      h.update(`${rel}\0`);
      h.update(fs.readFileSync(path.join(p, rel)));
      h.update('\0');
    }
  }
  return `sha256:${h.digest('hex')}`;
}

/** Directory (or file) covered by approval: package path if present, otherwise entry path. */
export const packagePath = (entry) => entry.package?.path ?? entry.path;

/** Approval record for given hash. `via`: 'ui' or 'cli'. */
export function approvalRecord(hash, { via = 'cli', now = new Date() } = {}) {
  return { status: 'approved', hash, at: now.toISOString(), via, platform: platformLabel(), policy: POLICY_VERSION };
}

/**
 * Status of a lock entry on THIS computer:
 *  - approved: approved and content is identical to approved hash;
 *  - review-pending: not approved under current system (e.g. legacy install): active with warning;
 *  - hash-mismatch: approved, but content differs from approved version: not activated;
 *  - missing: directory or file does not exist.
 * `cache` (Map path → hash) avoids recalculating hashes for shared packages.
 */
export function verifyEntry(root, entry, cache = new Map()) {
  const rel = packagePath(entry);
  const abs = path.resolve(root, rel ?? '');
  // the lock file can come from GitHub: a path outside the hub is never hashed, approved or activated
  if (!rel || !isInside(path.resolve(root), abs) || !fs.existsSync(abs)) return { status: 'missing', reason: t('approval.missingPath', { path: rel }) };
  const a = entry.approval;
  if (!a || a.status !== 'approved' || !a.hash) return { status: 'review-pending', reason: t('approval.reviewPending') };
  if (!cache.has(rel)) cache.set(rel, packageHash(abs));
  const actual = cache.get(rel);
  if (actual !== a.hash) return { status: 'hash-mismatch', reason: t('approval.hashMismatch', { path: rel }), actual };
  return { status: 'approved', reason: t('approval.approvedOn', { date: String(a.at).slice(0, 10), platform: a.platform ?? '?' }) };
}

export const statusLabel = (s) => {
  const labels = {
    approved: t('approval.status.approved'),
    'review-pending': t('approval.status.reviewPending'),
    'hash-mismatch': t('approval.status.hashMismatch'),
    missing: t('approval.status.missing'),
  };
  return labels[s] ?? s;
};

export const STATUS_LABEL = new Proxy({}, {
  get: (_, prop) => statusLabel(prop),
});
