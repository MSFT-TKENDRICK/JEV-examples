/**
 * Wire translation between TypeSafe's `POST /v1/systemone` contract and the
 * request/answer shapes of `@receptron/laya`.
 *
 * Model-free so the root test suite can prove the contract without weights.
 * The contract is read from `@typesafe-ai/sdk`'s published types: choice
 * answers carry `choice`, `confidence` and `probabilities`; score answers carry
 * an expected `score`, `confidence`, a `legend` echoing the rubric, and
 * `probabilities`; noul answers carry `noul`. Laya-only fields (`rl_agent`) are
 * dropped rather than leaked into a Jev-shaped response.
 */

import type { EntryType, Questions } from '@typesafe-ai/sdk';

export class ProxyError extends Error {
  readonly status: number;
  readonly type: string;
  readonly details: unknown;

  constructor(status: number, type: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.type = type;
    this.details = details;
  }
}

/** Structural copies of `@receptron/laya`'s exported question/answer types. */
export type LayaQuestion =
  | { type: 'choice'; instructions: string | object; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: string | object; criteria: string[] }
  | { type: 'noul'; instructions: string | object; criteria?: { true?: string; false?: string } };

export type LayaAnswer =
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number }
  | { type: 'noul'; noul: number };

export interface LayaResult {
  answers: Record<string, LayaAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}

export interface ParsedRequest {
  state: EntryType;
  questions: Questions;
  requestedModel: string | undefined;
}

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isEntry = (value: unknown): boolean =>
  value === null || typeof value === 'string' || typeof value === 'object';

function invalid(path: string, message: string): ProxyError {
  return new ProxyError(400, 'invalid_request', `${path}: ${message}`);
}

/** Validates the structural contract the SDK sends; semantic limits are checked later. */
export function parseSystemOneRequest(body: unknown): ParsedRequest {
  if (!isRecord(body)) throw invalid('body', 'expected a JSON object');
  if (!('state' in body)) throw invalid('state', 'is required (use null for no state)');
  if (!isEntry(body['state'])) throw invalid('state', 'must be text, a JSON object or array, or null');
  const model = body['model'];
  if (model !== undefined && typeof model !== 'string') throw invalid('model', 'must be a string');

  const questions = body['questions'];
  if (!isRecord(questions) || Object.keys(questions).length === 0) {
    throw invalid('questions', 'must be a nonempty object keyed by question name');
  }

  for (const [name, question] of Object.entries(questions)) {
    const path = `questions.${name}`;
    if (!isRecord(question)) throw invalid(path, 'must be an object');
    if (question['instructions'] !== undefined && !isEntry(question['instructions'])) {
      throw invalid(`${path}.instructions`, 'must be text, a JSON object or array, or null');
    }
    const criteria = question['criteria'];
    switch (question['type']) {
      case 'choice':
        if (!isRecord(criteria) || Object.keys(criteria).length === 0) {
          throw invalid(`${path}.criteria`, 'choice needs a nonempty object of labels');
        }
        for (const [label, description] of Object.entries(criteria)) {
          if (!isEntry(description)) throw invalid(`${path}.criteria.${label}`, 'must be an entry or null');
        }
        break;
      case 'score':
        if (!Array.isArray(criteria) || criteria.length === 0) {
          throw invalid(`${path}.criteria`, 'score needs a nonempty array of levels');
        }
        criteria.forEach((level, index) => {
          if (!isEntry(level)) throw invalid(`${path}.criteria.${index}`, 'must be an entry or null');
        });
        break;
      case 'noul':
        if (criteria !== undefined && criteria !== null) {
          if (!isRecord(criteria)) throw invalid(`${path}.criteria`, 'must be an object with true/false');
          for (const key of Object.keys(criteria)) {
            if (key !== 'true' && key !== 'false') throw invalid(`${path}.criteria.${key}`, 'noul criteria are true/false');
            if (!isEntry(criteria[key])) throw invalid(`${path}.criteria.${key}`, 'must be an entry or null');
          }
        }
        break;
      default:
        throw invalid(`${path}.type`, 'must be "choice", "score" or "noul"');
    }
  }

  return {
    state: body['state'] as EntryType,
    questions: questions as unknown as Questions,
    requestedModel: model,
  };
}

/** Laya renders option text by string interpolation, so structured entries become JSON text. */
function entryText(entry: EntryType | undefined): string {
  if (entry === null || entry === undefined) return '';
  return typeof entry === 'string' ? entry : JSON.stringify(entry);
}

function instructionsFor(entry: EntryType | undefined): string | object {
  if (entry === null || entry === undefined) return '';
  return entry;
}

export function toLayaQuestions(questions: Questions): Record<string, LayaQuestion> {
  const out: Record<string, LayaQuestion> = {};
  for (const [name, question] of Object.entries(questions)) {
    const instructions = instructionsFor(question.instructions);
    if (question.type === 'choice') {
      out[name] = {
        type: 'choice',
        instructions,
        criteria: Object.fromEntries(
          Object.entries(question.criteria).map(([label, description]) => [
            label,
            description === null || description === undefined ? null : entryText(description),
          ]),
        ),
      };
    } else if (question.type === 'score') {
      out[name] = { type: 'score', instructions, criteria: (question.criteria as readonly EntryType[]).map(entryText) };
    } else {
      const criteria = question.criteria ?? undefined;
      const noul: { true?: string; false?: string } = {};
      if (criteria?.true !== undefined && criteria.true !== null) noul.true = entryText(criteria.true);
      if (criteria?.false !== undefined && criteria.false !== null) noul.false = entryText(criteria.false);
      out[name] = Object.keys(noul).length > 0 ? { type: 'noul', instructions, criteria: noul } : { type: 'noul', instructions };
    }
  }
  return out;
}

function sameKeys(expected: readonly string[], actual: Record<string, number>, where: string): void {
  const got = Object.keys(actual);
  if (got.length !== expected.length || expected.some((key) => !(key in actual))) {
    throw new ProxyError(502, 'backend_contract', `${where}: backend returned labels ${JSON.stringify(got)}`);
  }
}

/** Maps backend answers onto the TypeSafe answer shapes, echoing the caller's rubric in `legend`. */
export function toTypeSafeAnswers(questions: Questions, result: LayaResult): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const [name, question] of Object.entries(questions)) {
    const answer = result.answers[name];
    if (!answer || answer.type !== question.type) {
      throw new ProxyError(502, 'backend_contract', `questions.${name}: backend returned no ${question.type} answer`);
    }
    if (answer.type === 'choice' && question.type === 'choice') {
      sameKeys(Object.keys(question.criteria), answer.probabilities, `questions.${name}`);
      answers[name] = {
        type: 'choice',
        choice: answer.choice,
        confidence: answer.confidence,
        probabilities: answer.probabilities,
      };
    } else if (answer.type === 'score' && question.type === 'score') {
      const levels = question.criteria as readonly EntryType[];
      sameKeys(levels.map((_, index) => String(index)), answer.probabilities, `questions.${name}`);
      answers[name] = {
        type: 'score',
        score: answer.score,
        confidence: answer.confidence,
        legend: Object.fromEntries(levels.map((level, index) => [String(index), level])),
        probabilities: answer.probabilities,
      };
    } else if (answer.type === 'noul') {
      answers[name] = { type: 'noul', noul: answer.noul };
    }
  }
  return answers;
}
