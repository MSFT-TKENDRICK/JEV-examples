/**
 * Fails if a committed recording is older than the thing it depicts.
 *
 * This repository's worst defect was a committed GIF. It showed pages a rebuild
 * had deleted and carried a caption describing behaviour the same rebuild had
 * removed, on the first screen of the README, for as long as it took someone to
 * pull an unrelated thread. Nothing caught it because nothing could: prose in
 * `docs/fragments/` is re-derived on every assembly and drifts loudly, while a
 * binary is inert and no check in this repository had any opinion about it.
 *
 * That is the general shape — the artefact's audience is human and the
 * verification is mechanical, and a media file *renders perfectly* while being
 * wrong, which is precisely what stops anyone looking at it again.
 *
 * There is no mechanical check for "does this still depict the product". There
 * is a cheap proxy: a recording must not be older than its subject. If the site
 * changed after the recording was made, the recording is describing a previous
 * version of it and needs remaking. That is a weaker claim than correctness and
 * it is stated as such — it catches the neglected case, not the wrong one.
 *
 * Usage:
 *   node scripts/media-check.ts
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

/**
 * What each committed recording depicts. Explicit rather than inferred: a
 * recording's subject is a judgement about content, and guessing it from
 * imports would quietly go wrong the first time an example was renamed.
 */
const SUBJECTS: ReadonlyArray<{ asset: string; depicts: readonly string[] }> = [
  {
    asset: 'docs/media/browser-use.mp4',
    depicts: ['src/site', 'src/browser-policy.ts', 'src/frontier.ts', 'examples/05-browser-live.ts'],
  },
];

function git(args: readonly string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

/** Commit timestamp of the last change to a path, or null if it has no history. */
function lastTouched(path: string): number | null {
  const out = git(['log', '-1', '--format=%ct', '--', path]);
  return out === '' ? null : Number(out);
}

function main(): void {
  // A skip is reported loudly. A check that silently passes when it cannot run
  // is the failure this repository has now hit five times.
  try {
    git(['rev-parse', '--is-inside-work-tree']);
  } catch {
    console.log('SKIP  media-check needs git history and found none. 0/0 recordings checked.');
    return;
  }

  let checked = 0;
  let failed = 0;

  for (const { asset, depicts } of SUBJECTS) {
    if (!existsSync(join(ROOT, asset))) {
      console.error(
        `FAIL  ${asset} is listed as a committed recording but is not present. ` +
          `Either restore it or drop it from SUBJECTS in scripts/media-check.ts.`,
      );
      failed += 1;
      continue;
    }

    const recorded = lastTouched(asset);
    if (recorded === null) {
      console.error(`FAIL  ${asset} has no commit history, so its age cannot be compared.`);
      failed += 1;
      continue;
    }

    for (const subject of depicts) {
      const changed = lastTouched(subject);
      checked += 1;
      if (changed !== null && changed > recorded) {
        console.error(
          `FAIL  ${asset} was last committed before ${subject} last changed, so it ` +
            `depicts a previous version of it. Re-record it, or if the change did ` +
            `not alter what the recording shows, touch the asset in the same commit ` +
            `to say so deliberately.`,
        );
        failed += 1;
      } else {
        console.log(`PASS  ${asset} is not older than ${subject}`);
      }
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} media check(s) failed.`);
    process.exit(1);
  }
  console.log(`${checked}/${checked} checks passed.`);
}

main();
