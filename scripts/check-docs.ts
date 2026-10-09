/**
 * Checks the relative links and anchors in README.md, local-jev/README.md and docs/.
 *
 * Every document here is Markdown that GitHub renders in place, so a moved file
 * or a renamed heading breaks its links silently: nothing fails until a reader
 * clicks. This check resolves each relative link against the file that contains
 * it, requires the target to exist, and requires each `#anchor` into a Markdown
 * file to name a heading there, using GitHub's slug rule. Anchors on source
 * files (`#L10`) and external URLs are not checked.
 *
 * It refuses to pass over nothing. If it parsed no links or no headings, the
 * pattern has stopped matching, and a clean run would say nothing about the docs.
 *
 * Usage: node scripts/check-docs.ts
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const FENCE = /^\s*```/;
const EXTERNAL = /^[a-z][a-z0-9+.-]*:/i;
const LINK = /\]\(([^)\s]+)\)/g;

interface Doc {
  readonly slugs: ReadonlySet<string>;
  readonly links: readonly { readonly line: number; readonly target: string }[];
}

function rel(path: string): string {
  return relative(ROOT, path).split(sep).join('/');
}

/** GitHub's heading slug: drop anything but letters, digits, marks, spaces, hyphens and underscores; spaces become hyphens. */
function slugify(heading: string): string {
  return heading
    .replace(/`/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, '')
    .replace(/ /g, '-');
}

const parsed = new Map<string, Doc>();

function parse(path: string): Doc {
  const cached = parsed.get(path);
  if (cached) return cached;

  const lines = readFileSync(path, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const slugs = new Set<string>();
  const seen = new Map<string, number>();
  const links: { line: number; target: string }[] = [];
  let fenced = false;

  lines.forEach((raw, index) => {
    if (FENCE.test(raw)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;

    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(raw);
    if (heading) {
      // GitHub suffixes repeated headings with -1, -2, ... in document order.
      const base = slugify(heading[1] ?? '');
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      slugs.add(count === 0 ? base : `${base}-${count}`);
    }

    // Inline code is removed first so an example like `[a](b)` is not a link.
    const prose = raw.replace(/`[^`]*`/g, '');
    for (const match of prose.matchAll(LINK)) {
      links.push({ line: index + 1, target: match[1] ?? '' });
    }
  });

  const doc: Doc = { slugs, links };
  parsed.set(path, doc);
  return doc;
}

function markdownUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return markdownUnder(full);
    return entry.name.endsWith('.md') ? [full] : [];
  });
}

function fail(message: string): never {
  console.error(`check-docs: ${message}`);
  process.exit(1);
}

function main(): void {
  const scoped = [
    join(ROOT, 'README.md'),
    join(ROOT, 'local-jev', 'README.md'),
    ...markdownUnder(join(ROOT, 'docs')),
  ];

  const failures: string[] = [];
  let internal = 0;
  let anchors = 0;
  let external = 0;
  let otherAnchors = 0;

  for (const file of scoped) {
    for (const { line, target } of parse(file).links) {
      const where = `${rel(file)}:${line}`;
      if (EXTERNAL.test(target)) {
        external += 1;
        continue;
      }
      internal += 1;

      const hash = target.indexOf('#');
      const pathPart = decodeURIComponent(hash === -1 ? target : target.slice(0, hash));
      const anchor = hash === -1 ? '' : decodeURIComponent(target.slice(hash + 1));
      const base = pathPart.startsWith('/') ? ROOT : dirname(file);
      const resolved = pathPart === '' ? file : resolve(base, pathPart.replace(/^\//, ''));

      if (!existsSync(resolved)) {
        failures.push(`${where} links to ${target}, which does not exist.`);
        continue;
      }
      if (anchor === '') continue;

      if (!resolved.endsWith('.md') || !statSync(resolved).isFile()) {
        otherAnchors += 1;
        continue;
      }
      anchors += 1;
      if (!parse(resolved).slugs.has(anchor)) {
        failures.push(`${where} links to #${anchor} in ${rel(resolved)}, which has no heading with that slug.`);
      }
    }
  }

  // A pattern that matched nothing would pass every link it never looked at.
  if (internal === 0) {
    fail('parsed no relative links, so it would report the docs as sound without checking one. The link pattern has stopped matching.');
  }
  const headings = scoped.reduce((total, file) => total + parse(file).slugs.size, 0);
  if (headings === 0) {
    fail('parsed no headings, so no anchor could have been checked. The heading pattern has stopped matching.');
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`check-docs: ${failure}`);
    fail(`${failures.length} broken link(s).`);
  }

  console.log(
    `PASS  ${internal} relative link(s) in ${scoped.length} file(s) resolve; ` +
      `${anchors} anchor(s) match ${headings} heading(s). ` +
      `Not checked: ${external} external URL(s), ${otherAnchors} anchor(s) on non-Markdown files.`,
  );
}

main();
