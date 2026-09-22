/**
 * The synthetic site, as data.
 *
 * One maze, three consumers. Example 04 walks this object directly, so it runs
 * with no browser. `render.ts` turns it into the HTML under `examples/site/`,
 * which examples 05 and 06 drive with real Chrome. Writing the maze once and
 * rendering it is the only way "same site, different driver" is literally true
 * rather than approximately true.
 *
 * WHAT THIS FILE IS AND IS NOT
 *
 * It is the world: which pages exist, which affordances they carry, where each
 * one leads, which pages terminate, and what a cheap read-only peek at a page
 * actually returns. All of it is fact, resolved by code.
 *
 * It is *not* the model's beliefs. No probability appears in this file. The
 * distribution over candidates comes from Jev (scripted offline, via
 * `src/mock-fetch.ts`); the arithmetic over that distribution lives in
 * `src/information-gain.ts` and `src/frontier.ts`. Keeping the world and the
 * belief in separate files is what stops the demo quietly grading its own
 * homework.
 *
 * And the honest part: the confusable labels, the dead ends, the probe costs
 * and the depth of the trap are all authored, by hand, right here. The maze is
 * hard because it was built hard. Nothing downstream is entitled to claim that
 * Jev found it hard.
 */

/** The task every browser example is pointed at. */
export const TASK =
  'Obtain a re-issued VAT invoice for the September 2025 Business subscription ' +
  'charge, and submit the re-issue request.';

/**
 * What one navigation costs, against a peek costing 1-3.
 *
 * Authored, like everything else here, but not arbitrary: a wrong navigation on
 * this site is a page load plus the unwinding needed to get back to the branch
 * point, and the trap branch is three pages deep. The contract requires probes
 * to be genuinely cheaper than the action they inform, and this is the number
 * that has to hold for that to be true.
 */
export const NAVIGATE_COST = 6;

export interface SiteElement {
  id: string;
  role: 'button' | 'link' | 'tab' | 'input';
  label: string;
  /** Page id this navigates to. Absent means the control does not navigate. */
  to?: string;
  /**
   * A point of no return. Enforced by the driver against every arm, so no
   * decision model gets a vote on it.
   */
  irreversible?: boolean;
  /** Rendered next to the label. Read by the `badge-counts` peek. */
  badge?: string;
}

/**
 * A read-only peek at the current page.
 *
 * `buckets` maps an observation to the candidate elements that would produce
 * it, which is exactly the shape `partitionProbe()` wants. `observation` is
 * what this page actually returns when peeked - the fact, not a belief.
 *
 * The likelihood model is authored. What is computed is the expected entropy
 * reduction over it, and the posterior once the observation lands.
 */
export interface SiteProbe {
  id: string;
  cost: number;
  description: string;
  buckets: Record<string, string[]>;
  observation: string;
}

export interface SitePage {
  id: string;
  file: string;
  title: string;
  /** The page's visible prose, as the driver would compact it. */
  text: string;
  /**
   * Set when the page proves the path ends here. The string is the proof, and
   * it is shown to the reader as well as to the agent - a dead end the example
   * merely asserts would be worthless.
   */
  deadEnd?: string;
  elements: SiteElement[];
  probes?: SiteProbe[];
}

/**
 * The maze.
 *
 * Six affordances at `home` with genuinely close labels, of which one leads to
 * the goal. The trap is `Account documents`, which reads correctly, stays
 * plausible for three pages, and then proves it cannot work. Getting out of it
 * requires going back to `home` and taking a different branch - which requires
 * having kept one.
 */
export const SITE: Record<string, SitePage> = {
  home: {
    id: 'home',
    file: 'home.html',
    title: 'Meridian - Account',
    text:
      'Account overview. Meridian Software Ltd, Business plan. ' +
      'Documents, billing and exports are filed separately.',
    elements: [
      { id: 'e1', role: 'link', label: 'Account documents', to: 'documents', badge: '41 files' },
      { id: 'e2', role: 'link', label: 'Download statement', to: 'statement', badge: 'PDF' },
      { id: 'e3', role: 'link', label: 'Download statements', to: 'statements', badge: 'ZIP' },
      { id: 'e4', role: 'link', label: 'Export activity', to: 'export', badge: 'CSV' },
      { id: 'e5', role: 'link', label: 'Billing history', to: 'billing', badge: '18 charges' },
      { id: 'e6', role: 'link', label: 'Invoices & receipts', to: 'uploads', badge: '7 uploads' },
    ],
    probes: [
      {
        id: 'badge-counts',
        cost: 1,
        description: 'read the item-count badges already rendered beside each link',
        buckets: {
          documents: ['e1', 'e2', 'e3'],
          billing: ['e5', 'e6'],
          exports: ['e4'],
        },
        observation: 'billing',
      },
      {
        id: 'disabled-state',
        cost: 1,
        description: 'check which download controls this account type has enabled',
        buckets: {
          enabled: ['e2', 'e3'],
          disabled: ['e1', 'e4', 'e5', 'e6'],
        },
        observation: 'disabled',
      },
      {
        id: 'breadcrumb',
        cost: 2,
        description: "read each link's destination breadcrumb from its title attribute",
        buckets: {
          'billing/charges': ['e5'],
          'documents/statements': ['e1', 'e2', 'e3'],
          'documents/uploads': ['e6'],
          exports: ['e4'],
        },
        observation: 'billing/charges',
      },
      {
        id: 'footer-legend',
        cost: 3,
        description: 'expand the "where documents live" legend in the footer and read it',
        buckets: {
          'under-billing': ['e5', 'e6'],
          'under-documents': ['e1', 'e2', 'e3', 'e4'],
        },
        observation: 'under-billing',
      },
    ],
  },

  // --- the trap: reads correctly, stays plausible, then proves it cannot work
  documents: {
    id: 'documents',
    file: 'documents.html',
    title: 'Meridian - Account documents',
    text:
      'Account documents. Statements, tax documents and correspondence, filed by year. ' +
      'Archived material is held for seven years.',
    elements: [
      { id: 'e1', role: 'link', label: 'Statement archive', to: 'archive' },
      { id: 'e2', role: 'link', label: 'Tax documents', to: 'archive' },
      { id: 'e3', role: 'link', label: 'Back to account', to: 'home' },
    ],
  },
  archive: {
    id: 'archive',
    file: 'archive.html',
    title: 'Meridian - Statement archive',
    text: 'Statement archive. Select a year. Holdings: 2019 through 2025.',
    elements: [
      { id: 'e1', role: 'link', label: '2025 documents', to: 'archive2025' },
      { id: 'e2', role: 'link', label: 'Back to account documents', to: 'documents' },
    ],
  },
  archive2025: {
    id: 'archive2025',
    file: 'archive-2025.html',
    title: 'Meridian - Statement archive 2025',
    text:
      'Statement archive, 2025. This archive holds account statements only. ' +
      'VAT invoices and other tax documents were moved to Billing in 2024 and ' +
      'are not filed here. There is no route from this archive to an invoice.',
    deadEnd:
      'the archive states outright that it holds statements only and that tax documents ' +
      'moved to Billing in 2024 - the branch is proven, not guessed, to be finished',
    elements: [{ id: 'e1', role: 'link', label: 'Back to statement archive', to: 'archive' }],
  },

  // --- the shallow decoys
  statement: {
    id: 'statement',
    file: 'statement.html',
    title: 'Meridian - Download statement',
    text:
      'Download statement. Generates a single account statement PDF for a chosen month. ' +
      'A statement is not a VAT invoice and carries no VAT breakdown.',
    deadEnd: 'a statement is not a VAT invoice, and this page produces nothing else',
    elements: [{ id: 'e1', role: 'link', label: 'Back to account', to: 'home' }],
  },
  statements: {
    id: 'statements',
    file: 'statements.html',
    title: 'Meridian - Download statements',
    text:
      'Download statements. Bulk export of account statements as a ZIP archive. ' +
      'Statements only; invoices are not included in the bundle.',
    deadEnd: 'the bulk bundle is statements only and explicitly excludes invoices',
    elements: [{ id: 'e1', role: 'link', label: 'Back to account', to: 'home' }],
  },
  export: {
    id: 'export',
    file: 'export.html',
    title: 'Meridian - Export activity',
    text:
      'Export activity. Produces a CSV of account activity lines for accounting import. ' +
      'Line items only, with no document attached.',
    deadEnd: 'an activity CSV has no document attached and cannot be re-issued',
    elements: [{ id: 'e1', role: 'link', label: 'Back to account', to: 'home' }],
  },
  uploads: {
    id: 'uploads',
    file: 'uploads.html',
    title: 'Meridian - Invoices & receipts',
    text:
      'Invoices & receipts. Supplier invoices and receipts you have uploaded for expense ' +
      "matching. Meridian's own VAT invoices are issued against charges and are not held here.",
    deadEnd:
      'this section holds invoices you uploaded, not invoices Meridian issued - the label ' +
      'is the closest match on the page and the content is the wrong direction entirely',
    elements: [{ id: 'e1', role: 'link', label: 'Back to account', to: 'home' }],
  },

  // --- the route that works
  billing: {
    id: 'billing',
    file: 'billing.html',
    title: 'Meridian - Billing history',
    text:
      'Billing history. Charges raised against this account, most recent first. ' +
      'A VAT invoice is issued per charge and can be re-issued from the charge.',
    elements: [
      { id: 'e1', role: 'link', label: 'August 2025', to: 'chargeAug', badge: 'GBP 240.00' },
      { id: 'e2', role: 'link', label: 'September 2025', to: 'chargeSep', badge: 'GBP 240.00' },
      {
        id: 'e3',
        role: 'link',
        label: 'September 2025 (adjusted)',
        to: 'chargeSepAdjusted',
        badge: 'GBP 12.00',
      },
      { id: 'e4', role: 'link', label: 'Back to account', to: 'home' },
    ],
    probes: [
      {
        id: 'charge-amount',
        cost: 1,
        description: 'read the amount column already rendered against each period',
        buckets: {
          // Both subscription charges are GBP 240.00 and the adjustment is
          // GBP 12.00, so the amount separates adjustments from charges and
          // nothing else. A probe that happened to be a perfect oracle would
          // make the example worthless.
          'subscription-amount': ['e1', 'e2'],
          'adjustment-amount': ['e3'],
        },
        observation: 'subscription-amount',
      },
      {
        id: 'period-marker',
        cost: 2,
        description: 'read the period marker in each row heading',
        buckets: {
          august: ['e1'],
          september: ['e2', 'e3'],
        },
        observation: 'september',
      },
    ],
  },
  chargeAug: {
    id: 'chargeAug',
    file: 'charge-aug-2025.html',
    title: 'Meridian - August 2025 charge',
    text:
      'Business subscription, GBP 240.00 charged 2 August 2025. ' +
      'VAT invoice INV-2025-08-4402 was issued. This is the August period.',
    deadEnd: 'the right control on the wrong period - August is not the requested charge',
    elements: [{ id: 'e1', role: 'link', label: 'Back to billing history', to: 'billing' }],
  },
  chargeSepAdjusted: {
    id: 'chargeSepAdjusted',
    file: 'charge-sep-2025-adjusted.html',
    title: 'Meridian - September 2025 adjustment',
    text:
      'Seat adjustment, GBP 12.00 credited 19 September 2025. ' +
      'Adjustments are recorded as credit notes. No VAT invoice is issued for an adjustment ' +
      'and none can be re-issued.',
    deadEnd:
      'an adjustment carries a credit note, not a VAT invoice, so there is nothing to re-issue',
    elements: [{ id: 'e1', role: 'link', label: 'Back to billing history', to: 'billing' }],
  },
  chargeSep: {
    id: 'chargeSep',
    file: 'charge-sep-2025.html',
    title: 'Meridian - September 2025 charge',
    text:
      'Business subscription, GBP 240.00 charged 2 September 2025. ' +
      'VAT invoice INV-2025-09-4471 was issued to the account owner and may be re-issued.',
    elements: [
      { id: 'e1', role: 'link', label: 'Request re-issue', to: 'reissue' },
      // Irreversible, and not the goal. The driver refuses it whatever any
      // decision model thinks, which is the point of enforcing this in code.
      { id: 'e2', role: 'button', label: 'Dispute this charge', irreversible: true },
      { id: 'e3', role: 'link', label: 'Back to billing history', to: 'billing' },
    ],
  },

  // --- the goal, and the one point of no return on the happy path
  reissue: {
    id: 'reissue',
    file: 'reissue.html',
    title: 'Meridian - Re-issue VAT invoice',
    text:
      'Re-issue VAT invoice INV-2025-09-4471. Set the invoice period and a delivery address, ' +
      'then submit. Submitting sends the request to the billing provider and cannot be undone.',
    elements: [
      { id: 'e1', role: 'input', label: 'Invoice period' },
      { id: 'e2', role: 'input', label: 'Delivery email' },
      {
        id: 'e3',
        role: 'button',
        label: 'Submit re-issue request',
        to: 'submitted',
        irreversible: true,
      },
      { id: 'e4', role: 'link', label: 'Back to charge', to: 'chargeSep' },
    ],
  },
  submitted: {
    id: 'submitted',
    file: 'submitted.html',
    title: 'Meridian - Request received',
    text:
      'Re-issue request REQ-88213 received. INV-2025-09-4471 will be re-sent to the delivery ' +
      'address within one business day.',
    elements: [{ id: 'e1', role: 'link', label: 'Back to account', to: 'home' }],
  },
};

/** The page every run starts on. */
export const ENTRY = 'home';

/** The page whose arrival means the task was completed. */
export const GOAL = 'submitted';

export function page(id: string): SitePage {
  const found = SITE[id];
  if (found === undefined) throw new Error(`No such page: ${id}`);
  return found;
}

/** The page reached by actioning `elementId` on `pageId`, or null if it does not navigate. */
export function follow(pageId: string, elementId: string): SitePage | null {
  const element = page(pageId).elements.find((candidate) => candidate.id === elementId);
  if (element?.to === undefined) return null;
  return page(element.to);
}

/** Maps a rendered file name back to its page, for drivers that only see a URL. */
export function pageByFile(file: string): SitePage {
  const found = Object.values(SITE).find((candidate) => candidate.file === file);
  if (found === undefined) throw new Error(`No page rendered as ${file}`);
  return found;
}
