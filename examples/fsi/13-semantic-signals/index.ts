/**
 * 13 — Semantic signals: forecasting features and knowledge-graph annotation.
 *
 * Two uses of the same bounded decision. Customer inquiries are classified by intent,
 * with yes/no signals for urgency, supply concern and competitor mention. The result
 * is a feature row for a downstream forecasting model. Knowledge-graph edges are
 * classified by relation, and a contradiction signal stops a merge. Entity types are
 * refined in two steps: the second step runs only on an organisation, and a registry
 * probe settles its kind.
 *
 * Claims: the run writes features and staged graph edges, both reversible. It shows
 * that a flat intent buys a read of the product record, and that a contradiction
 * blocks a merge the model was confident about. Hierarchical classification runs in
 * steps, and the next step is gated on the one before.
 *
 * Must not claim: that these features forecast demand, that any relation is true, or
 * that any two records describe one entity. No forecast is produced here. Staged edges
 * are not written to a production graph. Jev's probabilities are not calibrated, and
 * the fixtures are authored.
 *
 * Run: npm run fsi:semantic-signals
 */

import { pathToFileURL } from 'node:url';
import { createClient, isLiveJev } from '../../../src/client.ts';
import { fixtureBanner } from '../../../src/fixture-label.ts';
import {
  decide,
  NONE,
  printSummary,
  scriptFor,
  setField,
  type Decision,
  type ProbeSpec,
  type Result,
  type Tally,
} from '../../../src/decision-loop.ts';

interface InquiryRecord {
  inquiryId: string;
  text: string;
  competitorListed: boolean;
  stock: 'in-stock' | 'backorder';
  intent: string | null;
  urgency: string | null;
  competitorFlag: boolean | null;
}

interface EdgeRecord {
  edgeId: string;
  left: string;
  right: string;
  staged: string | null;
}

interface EntityRecord {
  entityId: string;
  name: string;
  registry: 'licensed-bank' | 'licensed-insurer' | 'unregistered';
  entityType: string | null;
  entityKind: string | null;
}

const INTENT: Record<string, string> = {
  buy_now: 'ready to buy, with a deadline',
  research: 'comparing options without a deadline',
  support_issue: 'asking about a problem with something already bought',
  cancel: 'asking how to stop or reverse a purchase',
  [NONE]: 'none of the above fits the inquiry',
};

const COMPETITOR_PROBE: ProbeSpec<InquiryRecord> = {
  id: 'comparison-target',
  cost: 1,
  description: 'check whether the inquiry names a product this catalogue does not sell',
  read: (r) => (r.competitorListed ? 'competitor-listed' : 'no-competitor'),
  buckets: {
    'competitor-listed': ['research', 'support_issue'],
    'no-competitor': ['buy_now', 'cancel'],
  },
};

const STOCK_PROBE: ProbeSpec<InquiryRecord> = {
  id: 'stock-lookup',
  cost: 2,
  description: 'look up stock for the product named in the inquiry',
  read: (r) => `stock-${r.stock}`,
  buckets: {
    'stock-in-stock': ['buy_now'],
    'stock-backorder': ['research', 'support_issue'],
  },
};

const FLAT_INTENT: Tally = { buy_now: 0.4, research: 0.3, support_issue: 0.15, cancel: 0.05, [NONE]: 0.1 };
const LOW_SIGNAL: Tally = { research: 0.34, buy_now: 0.3, support_issue: 0.2, cancel: 0.06, [NONE]: 0.1 };

function inquiry(overrides: Partial<InquiryRecord> & Pick<InquiryRecord, 'inquiryId' | 'text'>): InquiryRecord {
  return { competitorListed: false, stock: 'in-stock', intent: null, urgency: null, competitorFlag: null, ...overrides };
}

function intentDecision(
  record: InquiryRecord,
  probes: ProbeSpec<InquiryRecord>[],
  budget: number,
  scripted: Decision<InquiryRecord>['scripted'],
  expect: Decision<InquiryRecord>['expect'],
): Decision<InquiryRecord> {
  return {
    id: record.inquiryId,
    title: `${record.inquiryId} — ${record.text}`,
    instructions: 'What is this customer inquiry about? Choose none_of_these if none fits.',
    options: INTENT,
    indicators: {
      urgent: 'the inquiry expresses time pressure',
      supply_concern: 'the inquiry mentions availability or supply',
      competitor_mention: 'the inquiry names a competitor',
    },
    record,
    state: (r) => ({ text: r.text }),
    probes,
    budget,
    scripted,
    gate: () => null,
    plan: (option, _r, indicators) => [
      setField<InquiryRecord>({ id: 'intent', description: 'write the intent feature', field: 'intent', value: option }),
      setField<InquiryRecord>({
        id: 'urgency',
        description: 'write the urgency feature',
        field: 'urgency',
        value: (indicators['urgent'] ?? 0) >= 0.5 ? 'high' : 'normal',
      }),
      setField<InquiryRecord>({
        id: 'competitor',
        description: 'write the competitor-mention feature',
        field: 'competitorFlag',
        value: (indicators['competitor_mention'] ?? 0) >= 0.5,
      }),
    ],
    expect,
  };
}

const RELATION: Record<string, string> = {
  subsidiary_of: 'the left entity owns the right entity',
  same_entity_variant: 'the two names refer to one legal entity',
  unrelated: 'no ownership or identity link',
  [NONE]: 'neither record supports a relation',
};

function edgeDecision(record: EdgeRecord, scripted: Decision<EdgeRecord>['scripted'], expect: Decision<EdgeRecord>['expect']): Decision<EdgeRecord> {
  return {
    id: record.edgeId,
    title: `${record.edgeId} — ${record.left} / ${record.right}`,
    instructions: 'What relation do these two records describe? Choose none_of_these if none applies.',
    options: RELATION,
    indicators: { records_contradict: 'the two records give conflicting values for the same attribute' },
    record,
    state: (r) => ({ left: r.left, right: r.right }),
    probes: [],
    budget: 0,
    scripted,
    gate: (_r, option, indicators) =>
      option === 'same_entity_variant' && (indicators['records_contradict'] ?? 0) >= 0.5
        ? 'the records contradict each other, so they are not merged'
        : null,
    plan: (option) => [
      setField<EdgeRecord>({ id: 'staged', description: 'stage the edge in the annotation graph', field: 'staged', value: option }),
    ],
    expect,
  };
}

const ENTITY_TYPE: Record<string, string> = {
  organisation: 'a company, bank, insurer or other legal body',
  person: 'a natural person',
  product: 'a product or service the catalogue describes',
  [NONE]: 'none of these fits the record',
};

const ENTITY_KIND: Record<string, string> = {
  bank: 'a deposit-taking bank',
  insurer: 'an insurance undertaking',
  fintech: 'a payments or lending firm without a banking licence',
  [NONE]: 'none of these fits the organisation',
};

const REGISTRY: ProbeSpec<EntityRecord> = {
  id: 'registry-lookup',
  cost: 1,
  description: 'look up the organisation in the licence register',
  read: (r) => `registry-${r.registry}`,
  buckets: {
    'registry-licensed-bank': ['bank'],
    'registry-licensed-insurer': ['insurer'],
    'registry-unregistered': ['fintech', NONE],
  },
};

function entityType(record: EntityRecord, scripted: Decision<EntityRecord>['scripted']): Decision<EntityRecord> {
  return {
    id: `${record.entityId}-type`,
    title: `${record.entityId} — ${record.name}: what kind of entity is this?`,
    instructions: 'What type of entity does this record describe? Choose none_of_these if none fits.',
    options: ENTITY_TYPE,
    record,
    state: (r) => ({ name: r.name }),
    probes: [],
    budget: 0,
    scripted,
    gate: () => null,
    plan: (option) => [
      setField<EntityRecord>({ id: 'entity-type', description: 'write the entity type', field: 'entityType', value: option }),
    ],
    expect: { outcome: 'completed' },
  };
}

function entityKind(record: EntityRecord, scripted: Decision<EntityRecord>['scripted'], expect: Decision<EntityRecord>['expect']): Decision<EntityRecord> {
  return {
    id: `${record.entityId}-kind`,
    title: `${record.entityId} — ${record.name}: which kind of organisation?`,
    instructions: 'Which kind of organisation is this? Choose none_of_these if none fits.',
    options: ENTITY_KIND,
    record,
    state: (r) => ({ name: r.name }),
    probes: [REGISTRY],
    budget: 2,
    scripted,
    gate: (r) => (r.entityType === 'organisation' ? null : `the type step did not settle on organisation (it read ${r.entityType ?? 'nothing'})`),
    plan: (option) => [
      setField<EntityRecord>({ id: 'entity-kind', description: 'write the organisation kind', field: 'entityKind', value: option }),
    ],
    expect,
  };
}

function build(): { inquiries: Decision<InquiryRecord>[]; edges: Decision<EdgeRecord>[]; hierarchy: Decision<EntityRecord>[] } {
  const inquiries = [
    intentDecision(
      inquiry({ inquiryId: 'INQ-7001', text: 'Can you ship the 40 units before the price goes up next week?' }),
      [],
      0,
      () => ({
        distribution: { buy_now: 0.85, research: 0.07, support_issue: 0.04, cancel: 0.02, [NONE]: 0.02 },
        indicators: { urgent: 0.9, supply_concern: 0.6, competitor_mention: 0.05 },
      }),
      { outcome: 'completed', flipped: false },
    ),
    intentDecision(
      inquiry({ inquiryId: 'INQ-7002', text: 'Is this better than the alternative from the other brand?', competitorListed: true }),
      [COMPETITOR_PROBE],
      2,
      (obs) => {
        if (obs.includes('comparison-target:competitor-listed')) {
          return {
            distribution: { research: 0.8, buy_now: 0.08, support_issue: 0.05, cancel: 0.03, [NONE]: 0.04 },
            indicators: { urgent: 0.1, supply_concern: 0.1, competitor_mention: 0.95 },
          };
        }
        return { distribution: FLAT_INTENT, indicators: { urgent: 0.1, supply_concern: 0.1, competitor_mention: 0.3 } };
      },
      { outcome: 'completed', flipped: true },
    ),
    intentDecision(
      inquiry({ inquiryId: 'INQ-7003', text: 'Any update on this?', stock: 'backorder' }),
      [STOCK_PROBE],
      1,
      () => ({ distribution: LOW_SIGNAL, indicators: { urgent: 0.4, supply_concern: 0.2, competitor_mention: 0.1 } }),
      { outcome: 'refused' },
    ),
  ];

  const edge = (id: string, left: string, right: string) => ({ edgeId: id, left, right, staged: null });
  const edges = [
    edgeDecision(
      edge('KG-REL-42', 'Acme Holdings Ltd', 'Acme Bank Ltd'),
      () => ({
        distribution: { same_entity_variant: 0.86, subsidiary_of: 0.06, unrelated: 0.05, [NONE]: 0.03 },
        indicators: { records_contradict: 0.71 },
      }),
      { outcome: 'refused' },
    ),
    edgeDecision(
      edge('KG-REL-47', 'Acme Bank Ltd', 'Acme Holdings Ltd'),
      () => ({
        distribution: { subsidiary_of: 0.83, same_entity_variant: 0.08, unrelated: 0.05, [NONE]: 0.04 },
        indicators: { records_contradict: 0.08 },
      }),
      { outcome: 'completed', flipped: false },
    ),
  ];

  // Two steps, sharing one record. The second step is gated on the first.
  const entity: EntityRecord = { entityId: 'KG-ENT-51', name: 'Acme Bank Ltd', registry: 'licensed-bank', entityType: null, entityKind: null };
  const hierarchy = [
    entityType(entity, () => ({ distribution: { organisation: 0.9, person: 0.04, product: 0.03, [NONE]: 0.03 } })),
    entityKind(
      entity,
      (obs) => (obs.includes('registry-lookup:registry-licensed-bank')
        ? { distribution: { bank: 0.88, insurer: 0.04, fintech: 0.04, [NONE]: 0.04 } }
        : { distribution: { insurer: 0.36, bank: 0.34, fintech: 0.2, [NONE]: 0.1 } }),
      { outcome: 'completed', flipped: true },
    ),
  ];

  return { inquiries, edges, hierarchy };
}

export async function run(log: (line: string) => void = console.log): Promise<Result[]> {
  const { inquiries, edges, hierarchy } = build();
  const results: Result[] = [];
  for (const decision of inquiries) {
    results.push(await decide(decision, createClient(scriptFor(decision)), log));
  }
  for (const decision of edges) {
    results.push(await decide(decision, createClient(scriptFor(decision)), log));
  }
  // Runs in order: the type step sets the field the kind step is gated on.
  for (const decision of hierarchy) {
    results.push(await decide(decision, createClient(scriptFor(decision)), log));
  }
  return results;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  fixtureBanner(isLiveJev());
  printSummary(await run());
}
