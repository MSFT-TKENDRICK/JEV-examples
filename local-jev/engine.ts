/**
 * The Laya decision engine behind the local proxy, via `@receptron/laya`
 * (ONNX Runtime, CPU, no Python).
 *
 * `inspect` answers one question the package does not expose: would this request
 * be silently truncated, and where? It runs the package's own sequence builder
 * unbounded, with only the question budget, and with the checkpoint's full
 * limits, so the check reports the tokens the model actually drops (instructions,
 * options or state) instead of estimating them. It also returns the smallest
 * limits at which nothing is dropped, which `systemOne` can run at instead.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Laya, type LayaOptions } from '@receptron/laya';
import { Tokenizer } from '@huggingface/tokenizers';
import type { EntryType } from '@typesafe-ai/sdk';
import type { DecisionEngine, FidelityIssue, Fit } from './app.ts';
import type { LayaQuestion, LayaResult } from './protocol.ts';

/** receptron/laya-onnx commit holding the fp32 English bundle (421M, ModernBERT-large). */
export const LAYA_ONNX_REVISION = '68f27dfe5a27a54fb2b1fefc432f43f972e90868';
export const LAYA_PACKAGE_VERSION = '0.1.2';

interface SpecialIds {
  cls: number;
  sep: number;
  mask: number;
  pad: number;
  maskTok: string;
}

interface InternalQuestion {
  t: string;
  ins: string;
  crit: unknown;
}

/** Signatures of `@receptron/laya/dist/sequence.js`, which the package keeps out of its exports map. */
interface SequenceModule {
  toInternal(q: LayaQuestion): InternalQuestion;
  renderOptions(q: InternalQuestion): string[];
  serializeState(state: unknown): string;
  buildSequence(
    encode: (text: string) => number[],
    ids: SpecialIds,
    state: unknown,
    q: InternalQuestion,
    maxLen: number,
    headMaxLen: number,
  ): { ids: number[]; markers: number[] };
}

interface TokenizerLike {
  encode(text: string, options: { add_special_tokens: boolean }): { ids: number[] };
  token_to_id(token: string): number | undefined;
}

/** Per-option text cap hard-coded in the package's buildSequence. */
const OPTION_TOKEN_CAP = 48;
/** tokenizer_config.json model_max_length for the ModernBERT-large encoder Laya fine-tunes. */
const MODERNBERT_MAX_POSITIONS = 8192;

export interface LayaEngineOptions {
  modelDir?: string;
  revision?: string;
  threads?: number;
  onProgress?: LayaOptions['onProgress'];
}

export async function loadLayaEngine(options: LayaEngineOptions = {}): Promise<DecisionEngine & { close(): Promise<void> }> {
  const revision = options.revision ?? LAYA_ONNX_REVISION;
  const laya = await Laya.load({
    ...(options.modelDir ? { modelDir: options.modelDir } : { revision }),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    ...(options.threads ? { sessionOptions: { intraOpNumThreads: options.threads } } : {}),
  });

  const read = async (file: string): Promise<object> =>
    JSON.parse(await readFile(path.join(laya.modelDir, file), 'utf8')) as object;
  const tokenizer = new Tokenizer(
    await read('tokenizer/tokenizer.json'),
    await read('tokenizer/tokenizer_config.json'),
  ) as unknown as TokenizerLike;
  const special = (token: string): number => {
    const id = tokenizer.token_to_id(token);
    if (id === undefined) throw new Error(`special token ${token} missing from tokenizer`);
    return id;
  };
  const ids: SpecialIds = { cls: special('[CLS]'), sep: special('[SEP]'), mask: special('[MASK]'), pad: special('[PAD]'), maskTok: '[MASK]' };
  const encode = (text: string): number[] => tokenizer.encode(text, { add_special_tokens: false }).ids;
  const sequence = (await import(new URL('./sequence.js', import.meta.resolve('@receptron/laya')).href)) as SequenceModule;
  const trained = { maxLen: laya.config.max_len, headMaxLen: laya.config.head_max_len };
  const source = options.modelDir ? `modelDir ${path.basename(laya.modelDir)}` : `receptron/laya-onnx@${revision.slice(0, 7)}`;
  const model = `local-laya/${options.modelDir ? 'custom' : `laya-onnx-fp32@${revision.slice(0, 7)}`}`;
  const scrub = (text: string) => text.split(ids.maskTok).join(' ');

  return {
    model,
    description:
      `Local Laya (convaiinnovations/laya, ${source}) via @receptron/laya ${LAYA_PACKAGE_VERSION} on ONNX Runtime CPU. ` +
      `Jev-compatible wire format; not Jev. Trained context ${trained.maxLen} tokens with a ${trained.headMaxLen}-token ` +
      `question budget; the ModernBERT encoder accepts up to ${MODERNBERT_MAX_POSITIONS}.`,
    releaseDate: '2026-09-19',
    trained,
    maxPositions: MODERNBERT_MAX_POSITIONS,
    inspect(state: EntryType, questions: Record<string, LayaQuestion>): Fit {
      // The package's own builder, run with no limits, with only the question budget, and with both:
      // [CLS] instructions [SEP] ([MASK] option)* [SEP] state [SEP]. Any difference is input the model never sees.
      const issues: FidelityIssue[] = [];
      const needed = { ...trained };
      const unbounded = Number.MAX_SAFE_INTEGER;
      const stateTokens = encode(scrub(sequence.serializeState(state))).length;
      for (const [name, question] of Object.entries(questions)) {
        const internal = sequence.toInternal(question);
        const build = (context: number, head: number) => sequence.buildSequence(encode, ids, state, internal, context, head);
        const full = build(unbounded, unbounded);
        const headOnly = build(unbounded, trained.headMaxLen);
        const kept = build(trained.maxLen, trained.headMaxLen);
        const spans = (seq: { ids: number[]; markers: number[] }) =>
          seq.markers.map((m, i) => (seq.markers[i + 1] ?? seq.ids.length - stateTokens - 2) - m);

        const capped = sequence
          .renderOptions(internal)
          .filter((option) => encode(` ${scrub(option)}`).length > OPTION_TOKEN_CAP).length;
        if (capped > 0) {
          issues.push({
            question: name,
            kind: 'option_capped',
            detail: `${capped} option(s) exceed the package's fixed ${OPTION_TOKEN_CAP}-token per-option cap`,
          });
        }
        const fullSpans = spans(full);
        const optionTokens = fullSpans.reduce((s, n) => s + n, 0);
        const instructionTokens = full.markers[0]! - 2;
        const shrunk = spans(headOnly).filter((n, i) => n < fullSpans[i]!).length;
        if (shrunk > 0) {
          issues.push({
            question: name,
            kind: 'options_truncated',
            detail: `${fullSpans.length} options need ${optionTokens} tokens of the ${trained.headMaxLen}-token question budget; ${shrunk} would be cut`,
          });
        }
        const keptInstructions = headOnly.markers[0]! - 2;
        if (keptInstructions < instructionTokens) {
          issues.push({
            question: name,
            kind: 'instructions_truncated',
            detail: `instructions are ${instructionTokens} tokens; the ${trained.headMaxLen}-token question budget keeps ${keptInstructions}`,
          });
        }
        const stateDropped = headOnly.ids.length - kept.ids.length;
        if (stateDropped > 0) {
          issues.push({
            question: name,
            kind: 'state_truncated',
            detail: `state is ${stateTokens} tokens; the ${trained.maxLen}-token context keeps ${Math.max(0, stateTokens - stateDropped)}`,
          });
        }
        // buildSequence keeps every option whole while optBudget >= 16, and the instructions while optBudget >= their length.
        needed.headMaxLen = Math.max(needed.headMaxLen, optionTokens + Math.max(16, instructionTokens));
        needed.maxLen = Math.max(needed.maxLen, full.ids.length);
      }
      return { issues, needed };
    },
    async systemOne(state: EntryType, questions: Record<string, LayaQuestion>, context = trained): Promise<LayaResult> {
      // Callers serialize requests, so the per-call limits cannot leak into a concurrent call.
      laya.config.max_len = context.maxLen;
      laya.config.head_max_len = context.headMaxLen;
      try {
        return (await laya.systemOne(state, questions)) as unknown as LayaResult;
      } finally {
        laya.config.max_len = trained.maxLen;
        laya.config.head_max_len = trained.headMaxLen;
      }
    },
    close: () => laya.close(),
  };
}
