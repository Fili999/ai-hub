// Installation sources: GitHub link parsing, shallow clone, skill and agent discovery.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseFrontmatter, toList } from './frontmatter.mjs';
import { commandPath, hashPath, isSafeName, toPosix } from './util.mjs';
import { tFor } from './i18n.mjs';

const t = tFor();

const CLONE_TIMEOUT_MS = 10 * 60 * 1000;

function cleanSub(sub) {
  const s = String(sub ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (s.split('/').includes('..')) throw new Error(t('source.error.badPath'));
  return s;
}

function cleanRef(ref) {
  if (ref == null || ref === true) return null;
  const r = String(ref);
  if (!/^[\w./@+-]+$/.test(r) || r.startsWith('-')) throw new Error(t('source.error.invalidRef', { ref: r }));
  return r;
}

function asLocalDir(s) {
  try {
    const p = /^file:\/\//i.test(s) ? fileURLToPath(s) : s;
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return path.resolve(p);
  } catch {
    /* not a local path */
  }
  return null;
}

/**
 * Recognizes: GitHub links (including /tree/<ref>/<folder> and /blob/<ref>/<file>), git@github.com:..., "owner/repo",
 * or a local folder with a git repo (useful for testing and pre-cloned private repos).
 */
export function parseSource(input, { ref, path: subpath } = {}) {
  const raw = String(input ?? '').trim();
  if (!raw || raw.startsWith('-')) throw new Error(t('source.error.invalidSource'));

  const local = asLocalDir(raw);
  if (local) {
    return { type: 'local', url: pathToFileURL(local).href, display: local, repo: path.basename(local), ref: cleanRef(ref), subpath: cleanSub(subpath) };
  }

  const s = raw.replace(/[?#].*$/, '');
  let owner;
  let repo;
  let r = ref;
  let sub = subpath;
  let m;
  if ((m = s.match(/^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/))) {
    [owner, repo] = [m[1], m[2]];
  } else if ((m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/]+)(?:\/(.+?))?)?\/?$/i))) {
    [owner, repo] = [m[1], m[2]];
    r = ref ?? m[3];
    sub = subpath ?? (m[4] ? decodeURIComponent(m[4]) : '');
  } else if ((m = s.match(/^([\w.-]+)\/([\w.-]+)$/))) {
    [owner, repo] = [m[1], m[2]];
  } else {
    throw new Error(t('source.error.unrecognizedSource', { raw }));
  }
  if ([owner, repo].some((x) => x === '.' || x === '..')) throw new Error(t('source.error.invalidGitHubLink'));
  return { type: 'github', url: `https://github.com/${owner}/${repo}`, display: `${owner}/${repo}`, repo: `${owner}/${repo}`, ref: cleanRef(r), subpath: cleanSub(sub) };
}

/** Clones (shallow) into destDir and returns commit SHA. */
export function cloneSource(src, destDir) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  // absolute path of git when found in PATH (never a relative PATH entry), no shell, bounded time and output
  const gitExe = commandPath('git') ?? 'git';
  const git = (args) => spawnSync(gitExe, args, { encoding: 'utf8', env, timeout: CLONE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  const isSha = src.ref && /^[0-9a-f]{7,40}$/i.test(src.ref);
  // core.autocrlf=false: files arrive as they are in the repository, without newline conversions on this machine
  // only https (GitHub) and, for a local folder given on purpose, file: every other transport (ext::, ssh, git, http) is off
  const args = ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', ...(src.type === 'local' ? ['-c', 'protocol.file.allow=always'] : []), '-c', 'protocol.ext.allow=never', '-c', 'core.autocrlf=false', 'clone', '--quiet', '--no-recurse-submodules'];
  if (!isSha) args.push('--depth', '1');
  if (src.ref && !isSha) args.push('--branch', src.ref);
  args.push('--', src.url, destDir);

  let r = git(args);
  if (r.error?.code === 'ENOENT') throw new Error(t('source.error.noGit'));
  if (r.error?.code === 'ETIMEDOUT') throw new Error(t('source.error.cloneTimedOut', { display: src.display }));
  if (r.status !== 0) {
    const last = (r.stderr || '').trim().split('\n').pop();
    throw new Error(t('source.error.cloneFailed', { display: src.display, last }));
  }
  if (isSha) {
    r = git(['-C', destDir, 'checkout', '--quiet', src.ref, '--']);
    if (r.status !== 0) throw new Error(t('source.error.commitNotFound', { ref: src.ref, display: src.display }));
  }
  const head = git(['-C', destDir, 'rev-parse', 'HEAD']);
  return head.stdout.trim();
}

// folders that contain agents (including .claude/agents, as hidden folders are traversed)
const AGENT_DIRS = new Set(['agents', 'subagents']);

/**
 * Finds skills (folders with SKILL.md) and agents (.md files with name+description inside an "agents" folder).
 * @returns {{kind:'skill'|'agent', name:string, description:string, tools:string[]|null, srcPath:string, repoPath:string, validName:boolean}[]}
 */
/** Plugin folders for other assistants (e.g. Codex): we don't use them and they often duplicate skills. */
export const OTHER_ASSISTANT_DIRS = new Set(['codex-plugin', '.codex']);

export function discoverItems(cloneDir, subpath, fallbackName) {
  const root = path.resolve(cloneDir);
  const base = path.resolve(root, subpath || '.');
  if (base !== root && !base.startsWith(root + path.sep)) throw new Error(t('source.error.pathOutsideRepo'));
  if (!fs.existsSync(base)) throw new Error(t('source.error.subpathNotFound', { subpath }));

  const items = [];
  const seen = new Set();
  const rel = (p) => toPosix(path.relative(root, p)) || '.';
  const push = (it) => {
    const key = `${it.kind}:${it.srcPath}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ ...it, repoPath: rel(it.srcPath), validName: isSafeName(it.name) });
  };

  const addSkill = (dir) => {
    const text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    const { data } = parseFrontmatter(text);
    const dirName = dir === root ? fallbackName : path.basename(dir);
    push({
      kind: 'skill',
      name: data.name ? String(data.name).trim() : dirName,
      description: String(data.description ?? '').replace(/\s+/g, ' ').trim(),
      tools: data['allowed-tools'] != null ? toList(data['allowed-tools']) : null,
      // references paths outside own folder ("../"): likely requires the full package
      sharedFiles: /(^|[\s("'`=])\.\.[\\/]/m.test(text),
      srcPath: dir,
    });
  };
  const addAgent = (file) => {
    const { data } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    if (!data.name || !data.description) return;
    push({
      kind: 'agent',
      name: String(data.name).trim(),
      description: String(data.description).replace(/\s+/g, ' ').trim(),
      tools: data.tools != null ? toList(data.tools) : null,
      srcPath: file,
    });
  };

  if (fs.statSync(base).isFile()) {
    if (/(^|[\\/])SKILL\.md$/i.test(base)) addSkill(path.dirname(base));
    else if (/\.md$/i.test(base)) addAgent(base);
    return items;
  }

  (function walk(dir, depth, inAgents) {
    if (fs.existsSync(path.join(dir, 'SKILL.md'))) {
      addSkill(dir);
      return;
    }
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.isSymbolicLink() || ent.name === '.git' || ent.name === 'node_modules' || OTHER_ASSISTANT_DIRS.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (depth < 8) walk(full, depth + 1, inAgents || AGENT_DIRS.has(ent.name));
      } else if (inAgents && ent.isFile() && /\.md$/i.test(ent.name) && !/^readme/i.test(ent.name)) addAgent(full);
    }
  })(base, 0, AGENT_DIRS.has(path.basename(base)));

  return collapseMirrors(items, root);
}

/**
 * Same name and identical content (a repo publishing the same skills in two folders): keep the copy
 * with the shorter path. Same name but different content: both are kept, flagged with "nameClash".
 */
function collapseMirrors(items, root) {
  const groups = new Map();
  for (const it of items) (groups.get(`${it.kind}:${it.name}`) ?? groups.set(`${it.kind}:${it.name}`, []).get(`${it.kind}:${it.name}`)).push(it);
  const out = [];
  for (const list of groups.values()) {
    if (list.length === 1) {
      out.push(list[0]);
      continue;
    }
    const byHash = new Map();
    for (const it of list) {
      const h = hashPath(it.srcPath);
      (byHash.get(h) ?? byHash.set(h, []).get(h)).push(it);
    }
    for (const copies of byHash.values()) {
      copies.sort((a, b) => a.repoPath.split('/').length - b.repoPath.split('/').length || a.repoPath.localeCompare(b.repoPath));
      out.push({ ...copies[0], ...(copies.length > 1 ? { mirrors: copies.slice(1).map((c) => c.repoPath) } : {}), ...(byHash.size > 1 ? { nameClash: true } : {}) });
    }
  }
  // retain discovery order
  const order = new Map(items.map((x, i) => [x.srcPath, i]));
  return out.sort((a, b) => order.get(a.srcPath) - order.get(b.srcPath));
}
