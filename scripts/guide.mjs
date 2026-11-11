#!/usr/bin/env node
// Regenerate GUIDE.md with current hub state.
//   node scripts/guide.mjs [--check] [--stdout] [--machine] [--quiet]
//   --check    dry run: exits with 1 if guide is outdated
//   --stdout   prints guide instead of writing to disk (with --machine includes this computer's state)
import fs from 'node:fs';
import { HUB_ROOT, parseArgs } from './lib/util.mjs';
import { GUIDE_FILE, guideFilePath, refreshGuide, renderGuide } from './lib/guide.mjs';
import { tFor } from './lib/i18n.mjs';

const t = tFor(HUB_ROOT);
const { flags } = parseArgs(process.argv.slice(2), {
  boolean: ['check', 'stdout', 'machine', 'quiet'],
  string: ['lang'],
});

if (flags.stdout) {
  process.stdout.write(renderGuide(HUB_ROOT, { machine: Boolean(flags.machine) }));
} else if (flags.check) {
  const file = guideFilePath(HUB_ROOT);
  const fresh = renderGuide(HUB_ROOT);
  const same = fs.existsSync(file) && fs.readFileSync(file, 'utf8') === fresh;
  if (!flags.quiet) console.log(same ? t('guide.upToDate', { file: GUIDE_FILE }) : t('guide.outdated', { file: GUIDE_FILE }));
  process.exit(same ? 0 : 1);
} else {
  const { changed } = refreshGuide(HUB_ROOT);
  if (!flags.quiet) console.log(changed ? t('guide.updated', { file: GUIDE_FILE }) : t('guide.alreadyUpToDate', { file: GUIDE_FILE }));
}
