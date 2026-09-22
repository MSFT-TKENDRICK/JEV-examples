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
 * Every path where this check cannot measure refuses rather than passes. A
 * comparison it could not make is not evidence that the recording is current,
 * and a zero denominator cannot distinguish "nothing to check" from "stopped
 * looking" — which is the same argument this repository makes about a
 * degenerate distribution: the honest output is a refusal, not the answer you
 * happened to be holding.
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
  // A check that cannot run must refuse, not pass. Its denominator would be
  // zero, and a zero denominator cannot distinguish "nothing to check" from
  // "stopped looking" — the same reason a degenerate distribution is not a
  // decision. Every silent-pass failure on this project took the other branch.
  try {
    git(['rev-parse', '--is-inside-work-tree']);
  } catch {
    console.error(
      'REFUSE  media-check compares commit dates and found no git repository, so ' +
        'it cannot tell whether the recordings are current. Run it from a clone.',
    );
    process.exit(1);
  }

  if (git(['rev-parse', '--is-shallow-repository']) === 'true') {
    console.error(
      'REFUSE  this is a shallow clone, so commit dates for most paths are ' +
        'unreachable and every comparison would silently look current. ' +
        'Fetch full history (actions/checkout: fetch-depth: 0).',
    );
    process.exit(1);
  }

  if (SUBJECTS.length === 0) {
    console.error(
      'REFUSE  no recordings are declared in SUBJECTS, so this check would report ' +
        'success having compared nothing. If the last committed asset was removed, ' +
        'delete this script rather than leaving it passing vacuously.',
    );
    process.exit(1);
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
      if (changed === null) {
        // Not a pass. An unreachable history is a failure to measure, and
        // treating it as "not newer" is how this check would have reported
        // every recording current on a clone that could not see the dates.
        console.error(
          `FAIL  ${subject} has no reachable commit history, so ${asset} cannot be ` +
            `compared against it. If the path was renamed or deleted, update ` +
            `SUBJECTS in scripts/media-check.ts.`,
        );
        failed += 1;
      } else if (changed > recorded) {
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
  if (checked === 0) {
    console.error(
      'REFUSE  compared nothing. SUBJECTS declares recordings but no subjects to ' +
        'compare them against, so a pass here would measure nothing.',
    );
    process.exit(1);
  }
  console.log(`${checked}/${checked} checks passed.`);
}

main();
