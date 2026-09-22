/**
 * Renders `graph.ts` into the static site under `examples/site/`.
 *
 * Examples 05 and 06 drive real Chrome against these files. Example 04 walks
 * the graph object directly. Generating one from the other is the only way the
 * repeated claim — "same site, same policy, different driver" — is literally
 * true rather than true-ish until someone edits one copy.
 *
 * The output is committed, so `npm run record` needs no build step. Re-run this
 * after changing the graph:
 *
 *     node src/site/render.ts
 *
 * ON THE `data-peek` ATTRIBUTE
 *
 * Every probe in the graph corresponds to evidence that is genuinely rendered
 * into the page: the count badges beside each link, the `title` breadcrumbs,
 * the per-row VAT markers, the enabled/disabled state of the download controls,
 * the collapsible footer legend. A driver could read each of those directly.
 *
 * `data-peek` on `<body>` is a JSON index over exactly that evidence, so a peek
 * costs one `Runtime.evaluate` instead of four. It adds no information the page
 * does not already show. It is a convenience, and calling it anything grander
 * would be overselling it.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { SiteElement, SitePage } from './graph.ts';
import { SITE, page as pageById } from './graph.ts';

const OUT = resolve(import.meta.dirname, '..', '..', 'examples', 'site');

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** The breadcrumb the `breadcrumb` peek reads, surfaced as a real title attribute. */
function breadcrumbFor(element: SiteElement): string {
  if (element.to === undefined) return 'Stays on this page';
  const destination = pageById(element.to);
  return destination.title.replace(/^Meridian - /, 'Meridian / ');
}

function renderElement(element: SiteElement): string {
  const label = escapeHtml(element.label);
  const title = escapeHtml(breadcrumbFor(element));
  const badge =
    element.badge === undefined
      ? ''
      : `<span class="badge">${escapeHtml(element.badge)}</span>`;

  if (element.role === 'input') {
    return (
      `<li><input type="text" aria-label="${label}" placeholder="${label}" ` +
      `data-field="${escapeHtml(element.id)}" />${badge}</li>`
    );
  }

  const destructive = element.irreversible === true ? ' data-destructive="true"' : '';

  if (element.role === 'button') {
    const onclick =
      element.to === undefined
        ? ''
        : ` onclick="location.href='${escapeHtml(pageById(element.to).file)}'"`;
    return `<li><button title="${title}"${destructive}${onclick}>${label}</button>${badge}</li>`;
  }

  const href = element.to === undefined ? '#' : escapeHtml(pageById(element.to).file);
  // `data-enabled` is what the `disabled-state` peek reads. Download controls
  // are the enabled ones on this account type; everything else is a section
  // link and is not a download control at all.
  const enabled = /^Download/.test(element.label) ? 'true' : 'false';
  return (
    `<li><a href="${href}" title="${title}" data-enabled="${enabled}"${destructive}>` +
    `${label}</a>${badge}</li>`
  );
}

function renderPage(site: SitePage): string {
  // The driver's describe step numbers elements e1..eN in document order, so
  // the graph's ids only mean anything if they match that order exactly.
  site.elements.forEach((element, index) => {
    const expected = `e${index + 1}`;
    if (element.id !== expected) {
      throw new Error(
        `${site.id}: element ${index} has id "${element.id}" but the driver will call it ` +
          `"${expected}". Graph ids must be e1..eN in document order.`,
      );
    }
  });

  const peeks = Object.fromEntries(
    (site.probes ?? []).map((probe) => [probe.id, probe.observation]),
  );

  const deadEnd =
    site.deadEnd === undefined
      ? ''
      : `\n      <p class="dead-end">This route ends here: ${escapeHtml(site.deadEnd)}.</p>`;

  const legend =
    site.probes?.some((probe) => probe.id === 'footer-legend') === true
      ? '\n      <details class="legend"><summary>Where documents live</summary>' +
        '<p>Statements and correspondence are filed under Account documents. ' +
        'VAT invoices are issued against charges and are filed under Billing.</p></details>'
      : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(site.title)}</title>
    <link rel="stylesheet" href="style.css" />
  </head>
  <body data-peek='${JSON.stringify(peeks)}'>
    <header><span class="logo">Meridian</span></header>

    <main>
      <h1>${escapeHtml(site.title.replace(/^Meridian - /, ''))}</h1>
      <p class="lede">${escapeHtml(site.text)}</p>${deadEnd}

      <ul class="affordances">
        ${site.elements.map(renderElement).join('\n        ')}
      </ul>
    </main>

    <footer><span class="muted">Meridian Software Ltd</span>${legend}</footer>
  </body>
</html>
`;
}

await mkdir(OUT, { recursive: true });

let written = 0;
for (const site of Object.values(SITE)) {
  await writeFile(resolve(OUT, site.file), renderPage(site), 'utf8');
  written++;
}

console.log(`rendered ${written} pages into ${OUT}`);
