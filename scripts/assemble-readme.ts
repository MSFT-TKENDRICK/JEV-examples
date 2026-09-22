/**
 * Assembles `README.md` from the per-example fragments in `docs/fragments/`.
 *
 * The examples are built in parallel worktrees by separate sessions. If each
 * edited `README.md` directly the conflicts would be guaranteed, so each writes
 * `docs/fragments/<nn>.md` and this script splices them in once they land.
 *
 * Marker scheme
 * -------------
 * A fragment region opens with `<!-- fragment:07 -->` and runs until the next
 * marker of any kind — the next `<!-- fragment:NN -->` or a `<!-- fragments:end -->`
 * terminator. Only region *starts* are marked, so the README carries ten marker
 * lines rather than sixteen, and a fragment can never be silently appended to
 * the section below it.
 *
 * Failure behaviour
 * -----------------
 * This script refuses rather than guessing. A missing marker, a missing
 * fragment file, an unknown fragment, a fragment that does not begin at
 * `###`, or a `##` heading anywhere inside one all abort the run with a
 * message naming the problem. A README assembled
 * from a partial set of fragments would look finished while describing examples
 * that no longer exist, which is worse than not assembling at all.
 *
 * Usage:
 *   node scripts/assemble-readme.ts          # rewrites README.md
 *   node scripts/assemble-readme.ts --check  # verifies, writes nothing
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const README = join(ROOT, 'README.md');
const FRAGMENTS = join(ROOT, 'docs', 'fragments');

const START = /^<!-- fragment:([0-9]{2}) -->$/;
const END = /^<!-- fragments:end -->$/;

interface Region {
  id: string;
  /** Index of the marker line itself. */
  marker: number;
  /** Exclusive end: the index of the next marker line. */
  end: number;
}

function fail(message: string): never {
  console.error(`assemble-readme: ${message}`);
  process.exit(1);
}

/** Fragment ids present on disk, so an unexpected file is an error not a no-op. */
function fragmentIds(): string[] {
  return readdirSync(FRAGMENTS)
    .filter((name) => /^[0-9]{2}\.md$/.test(name))
    .map((name) => name.slice(0, 2))
    .sort();
}

function regions(lines: readonly string[]): Region[] {
  const markers: { id: string | null; line: number }[] = [];
  lines.forEach((line, index) => {
    const start = START.exec(line.trim());
    if (start?.[1]) markers.push({ id: start[1], line: index });
    else if (END.test(line.trim())) markers.push({ id: null, line: index });
  });

  const found: Region[] = [];
  markers.forEach((marker, i) => {
    if (marker.id === null) return;
    const next = markers[i + 1];
    if (!next) {
      fail(
        `fragment:${marker.id} has no following marker. Every region must be ` +
          `closed by the next fragment marker or by <!-- fragments:end -->.`,
      );
    }
    found.push({ id: marker.id, marker: marker.line, end: next.line });
  });
  return found;
}

function main(): void {
  const checkOnly = process.argv.includes('--check');
  const original = readFileSync(README, 'utf8');
  const lines = original.split('\n');

  const found = regions(lines);
  const onDisk = fragmentIds();

  const marked = found.map((r) => r.id).sort();
  const duplicated = marked.filter((id, i) => marked.indexOf(id) !== i);
  if (duplicated.length > 0) {
    fail(`duplicate fragment marker(s): ${[...new Set(duplicated)].join(', ')}`);
  }

  const missingFile = marked.filter((id) => !onDisk.includes(id));
  if (missingFile.length > 0) {
    fail(
      `README marks fragment(s) ${missingFile.join(', ')} but ` +
        `docs/fragments/ has no file for them. The owning example has not landed yet.`,
    );
  }

  const unmarked = onDisk.filter((id) => !marked.includes(id));
  if (unmarked.length > 0) {
    fail(
      `docs/fragments/ contains ${unmarked.join(', ')} with no matching marker ` +
        `in README.md. Add <!-- fragment:${unmarked[0]} --> where the section belongs.`,
    );
  }

  // Splice from the bottom up so earlier indices stay valid.
  const out = [...lines];
  for (const region of [...found].sort((a, b) => b.marker - a.marker)) {
    const body = readFileSync(join(FRAGMENTS, `${region.id}.md`), 'utf8').trim();
    if (!/^### /.test(body)) {
      fail(
        `docs/fragments/${region.id}.md must start at heading level ### to match ` +
          `the per-example sections it is spliced into.`,
      );
    }
    // A ## anywhere inside would outrank the section the fragment lives in, so
    // the title check alone is not enough. Headings inside fenced blocks are
    // sample output, not structure, and are skipped.
    let fenced = false;
    body.split('\n').forEach((line, i) => {
      if (/^\s*```/.test(line)) {
        fenced = !fenced;
        return;
      }
      if (!fenced && /^##(?!#)\s/.test(line)) {
        fail(
          `docs/fragments/${region.id}.md line ${i + 1} is a ## heading. A fragment ` +
            `titles at ### and uses #### for its subsections; a ## would outrank ` +
            `the section it is spliced into. Line: ${line.trim()}`,
        );
      }
    });
    out.splice(region.marker + 1, region.end - region.marker - 1, '', body, '');
  }

  const assembled = `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;

  if (checkOnly) {
    if (assembled !== original) {
      fail('README.md is out of date with docs/fragments/. Run: npm run readme');
    }
    console.log(`README.md is up to date with ${found.length} fragment(s).`);
    return;
  }

  writeFileSync(README, assembled, 'utf8');
  console.log(
    assembled === original
      ? `README.md already up to date with ${found.length} fragment(s).`
      : `README.md assembled from ${found.length} fragment(s): ${marked.join(', ')}.`,
  );
}

main();
