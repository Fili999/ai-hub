// Test utilities shared across test files (not a test file itself).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// All tests check output in English.
process.env.AI_HUB_LANG ??= 'en';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDirs = [];

export function mktmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-test-'));
  tmpDirs.push(d);
  return d;
}
export function cleanupAfter() {
  test.after(() => tmpDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
}

export function write(root, rel, content) {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
}

/** Test hub with skills, agents, dependencies and a conflict. */
export function makeHub({ deps = true } = {}) {
  const root = mktmp();
  fs.copyFileSync(path.join(REPO, 'hub.config.json'), path.join(root, 'hub.config.json'));
  if (deps) fs.copyFileSync(path.join(REPO, 'dependencies.json'), path.join(root, 'dependencies.json'));
  write(root, 'registry.json', '{"version":1,"overrides":{},"links":[]}\n');
  write(root, 'manifest.lock.json', '{"version":1,"entries":[]}\n');
  // these tests do not depend on SkillSpector: policy has dedicated tests
  write(root, 'settings.json', '{"version":1,"security":{"skillspector":"off"}}\n');
  write(root, 'package.json', JSON.stringify({ name: 'fixture', scripts: { doctor: 'node scripts/doctor.mjs', test: 'node --test' } }));
  write(root, 'skills/own/montaggio-video/SKILL.md', '---\nname: montaggio-video\ndescription: Video editing with ffmpeg for YouTube.\ncategories: video\nrequires-commands: comando-che-non-esiste-xyz\n---\n# Editing\n');
  write(root, 'skills/own/sottotitoli/SKILL.md', '---\nname: sottotitoli\ndescription: Subtitles for a video.\ndepends: montaggio-video\nrequires-mcp: gmail\n---\n# Subtitles\n');
  write(root, 'skills/own/seo-audit/SKILL.md', '---\nname: seo-audit\ndescription: SEO audit for a website.\n---\n# SEO\n');
  write(root, 'agents/own/producer.md', '---\nname: producer\ndescription: Produces videos for YouTube.\nskills: montaggio-video\n---\nYou are a producer.\n');
  return root;
}

/** Local git repository serving as "GitHub" fixture for installation tests. */
export function makeGitFixture(files) {
  const dir = mktmp();
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  const git = (...a) => spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return { dir, git, head: () => git('rev-parse', 'HEAD').stdout.trim() };
}

/**
 * Two "machines" (a = hub under test, b = another machine) sharing a fake GitHub bare repository.
 */
export function makeSyncPair() {
  const base = mktmp();
  const git = (dir, ...args) => {
    const r = spawnSync('git', ['-C', dir, '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} → ${r.stderr || r.stdout}`);
    return r.stdout.trim();
  };
  const ident = (dir) => {
    git(dir, 'config', 'user.name', 'Test');
    git(dir, 'config', 'user.email', 'test@example.com');
  };
  const remote = path.join(base, 'github.git');
  fs.mkdirSync(remote);
  git(remote, 'init', '-q', '--bare');
  git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  const a = makeHub();
  write(a, '.gitignore', 'index/*.json\n');
  git(a, 'init', '-q');
  git(a, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  ident(a);
  git(a, 'remote', 'add', 'origin', remote);
  git(a, 'add', '-A');
  git(a, 'commit', '-q', '-m', 'init');
  git(a, 'push', '-q', '-u', 'origin', 'main');
  const b = path.join(base, 'b');
  git(base, 'clone', '-q', remote, b);
  ident(b);
  return { remote, a, b, git, base };
}

export function run(script, args, { root, env = {} } = {}) {
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', script), ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...(root ? { AI_HUB_ROOT: root } : {}), CLAUDE_CONFIG_DIR: path.join(os.tmpdir(), 'ai-hub-test-claude-none'), ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
