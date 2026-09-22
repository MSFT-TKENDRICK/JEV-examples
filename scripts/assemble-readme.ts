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

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';

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

/**
 * Rewrites a fragment's relative links so they resolve from the repository root.
 *
 * A fragment lives in `docs/fragments/` and links out with `../../examples/x.ts`,
 * which is correct where the file sits. Spliced verbatim into `README.md` at the
 * root, that same path points outside the repository. The links were copied
 * unchanged for the whole life of this script, so every such link in the
 * published README was broken.
 *
 * Each target is also required to exist. A fragment that references a deleted
 * file aborts the run, because a dangling reference is how a rebuild leaves the
 * documentation describing something that is no longer there — and it is the one
 * failure a reader finds immediately and the authors never do.
 *
 * Anchors, absolute URLs and links inside fenced blocks are left alone; the
 * fenced ones are sample output rather than navigation.
 *
 * Returns how many links it rewrote, so the caller can report a denominator.
 * A guard that only ever says "no failures" reads identically whether it
 * checked everything or matched nothing — which is how this repository shipped
 * four checkers that passed while measuring nothing.
 */
function rebaseLinks(body: string, id: string): { text: string; rebased: number } {
  let fenced = false;
  let rebasedCount = 0;
  const text = body
    .split('\n')
    .map((line, index) => {
      if (/^\s*```/.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      return line.replace(/\]\(([^)]+)\)/g, (whole, target: string) => {
        if (/^(?:[a-z]+:|#|\/)/i.test(target)) return whole;
        const [path, anchor] = target.split('#') as [string, string | undefined];
        if (path === '') return whole;
        const absolute = resolve(FRAGMENTS, path);
        if (!existsSync(absolute)) {
          fail(
            `docs/fragments/${id}.md line ${index + 1} links to ${path}, which does ` +
              `not exist. Relative links in a fragment are resolved from ` +
              `docs/fragments/. If the target moved or was deleted, update the link; ` +
              `a README assembled from it would ship a dead link.`,
          );
        }
        rebasedCount += 1;
        const rebased = relative(ROOT, absolute).split('\\').join('/');
        return `](${anchor === undefined ? rebased : `${rebased}#${anchor}`})`;
      });
    })
    .join('\n');
  return { text, rebased: rebasedCount };
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

/**
 * Refuses if a `](#anchor)` link in the assembled README names no heading.
 *
 * Renaming a heading in a fragment silently breaks any link to it, and the
 * broken link lives in the static part of the README that no fragment owns — so
 * nothing else in this pipeline would notice. That is exactly how the one
 * internal link in this file came to point at a heading the rebuild had
 * renamed.
 *
 * The slug rule is GitHub's: lowercase, drop anything that is not a word
 * character, hyphen or space, then turn each remaining space into a hyphen.
 * Runs of spaces are *not* collapsed, so `06 — The same maze` slugs with a
 * double hyphen once the em dash is dropped.
 *
 * Refuses outright if it parsed no headings. That is not a README this script
 * could ever produce, so it means the heading pattern stopped matching rather
 * than that the document is clean — the failure that made an earlier version of
 * this check report a clean sweep over zero parsed headings, because README.md
 * is CRLF and JavaScript's `.` excludes `\r`.
 */
function checkAnchors(markdown: string): { headings: number; anchors: number } {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const slugs = new Set<string>();
  let fenced = false;
  for (const line of normalized.split('\n')) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading?.[1] !== undefined) {
      slugs.add(
        heading[1]
          .trim()
          .toLowerCase()
          .replace(/[^\w\- ]/g, '')
          .replace(/ /g, '-'),
      );
    }
  }
  if (slugs.size === 0) {
    fail(
      'anchor check parsed no headings from the assembled README, so it was ' +
        'about to report every anchor as valid without having looked at one. ' +
        'The heading pattern has stopped matching.',
    );
  }
  let anchors = 0;
  for (const link of normalized.matchAll(/\]\(#([^)]+)\)/g)) {
    const anchor = link[1];
    anchors += 1;
    if (anchor !== undefined && !slugs.has(anchor)) {
      fail(
        `README.md links to #${anchor}, which matches no heading. If a fragment ` +
          `heading was renamed, update the link in the static part of README.md ` +
          `to the new slug.`,
      );
    }
  }
  return { headings: slugs.size, anchors };
}

/**
 * Verifies the expected-files table in `docs/fragments/README.md` against the
 * fragments actually on disk.
 *
 * That table described what each fragment was about in prose written when the
 * fragments were first planned. Four of the eight descriptions had since stopped
 * matching their fragment's own title — 06 was still listed as "Jev versus a
 * point-estimate control" after the rebuild retitled it, and 07 as "bounded
 * next-step recommendation". Nothing read the table, so nothing disagreed with it.
 *
 * Holding the title verbatim is what makes the drift mechanical to detect. A
 * prose summary would be undecidable; an exact string is a comparison.
 */
function checkFragmentIndex(titles: ReadonlyMap<string, string>): number {
  const indexPath = join(FRAGMENTS, 'README.md');
  const rows = new Map<string, string>();
  for (const line of readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n').split('\n')) {
    const row = line.match(/^\|\s*`([0-9]{2})\.md`\s*\|\s*(.+?)\s*\|$/);
    if (row?.[1] !== undefined && row[2] !== undefined) rows.set(row[1], row[2]);
  }

  // A table that parsed to nothing would agree with every fragment, which is the
  // same clean sweep over zero rows the anchor check refuses on.
  if (rows.size === 0) {
    fail(
      `docs/fragments/README.md: parsed no rows from the expected-files table, so ` +
        `it was about to report the table as current without having compared one. ` +
        `The row pattern has stopped matching.`,
    );
  }

  for (const [id, title] of titles) {
    const listed = rows.get(id);
    if (listed === undefined) {
      fail(
        `docs/fragments/README.md: the expected-files table has no row for ` +
          `${id}.md. Add: | \`${id}.md\` | ${title} |`,
      );
    }
    if (listed !== title) {
      fail(
        `docs/fragments/README.md: the row for ${id}.md reads "${listed}" but the ` +
          `fragment titles itself "${title}". Update the row; a description that ` +
          `has stopped matching is worse than none.`,
      );
    }
  }

  for (const id of rows.keys()) {
    if (!titles.has(id)) {
      fail(
        `docs/fragments/README.md: the expected-files table lists ${id}.md, which ` +
          `does not exist in docs/fragments/.`,
      );
    }
  }

  return rows.size;
}

function main(): void {
  const checkOnly = process.argv.includes('--check');
  // Normalize once, here, rather than at each consumer. The original version
  // read the file raw, so `assembled` inherited whatever line endings the
  // checkout happened to have: on Windows with core.autocrlf=true a fresh
  // clone yields an all-CRLF README, while splicing produced a mixed file, and
  // the exact-string comparison below reported drift that did not exist.
  //
  // checkAnchors() already normalized for its own regex and said why in its
  // doc comment. The lesson was learned at one call site and not carried to
  // this one, 116 lines away, which was never edited and so never re-read.
  const original = readFileSync(README, 'utf8').replace(/\r\n/g, '\n');
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
  let links = 0;
  const titles = new Map<string, string>();
  for (const region of [...found].sort((a, b) => b.marker - a.marker)) {
    const body = readFileSync(join(FRAGMENTS, `${region.id}.md`), 'utf8')
      .replace(/\r\n/g, '\n')
      .trim();
    if (!/^### /.test(body)) {
      fail(
        `docs/fragments/${region.id}.md must start at heading level ### to match ` +
          `the per-example sections it is spliced into.`,
      );
    }
    titles.set(region.id, body.split('\n')[0]!.replace(/^###\s+/, '').trim());
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
    const rewritten = rebaseLinks(body, region.id);
    links += rewritten.rebased;
    out.splice(region.marker + 1, region.end - region.marker - 1, '', rewritten.text, '');
  }

  const assembled = `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;

  const { headings, anchors } = checkAnchors(assembled);
  const indexRows = checkFragmentIndex(titles);
  // State the denominators. "No failures" is identical whether the guard checked
  // everything or matched nothing, so the counts are the part that makes a clean
  // run falsifiable.
  const measured =
    `${found.length} fragment(s), ${links} link(s) rebased, ` +
    `${anchors} anchor(s) against ${headings} heading(s), ` +
    `${indexRows} index row(s)`;

  if (checkOnly) {
    if (assembled !== original) {
      fail('README.md is out of date with docs/fragments/. Run: npm run readme');
    }
    console.log(`README.md is up to date: ${measured}.`);
    return;
  }

  writeFileSync(README, assembled, 'utf8');
  console.log(
    assembled === original
      ? `README.md already up to date: ${measured}.`
      : `README.md assembled from ${measured}: ${marked.join(', ')}.`,
  );
}

main();
