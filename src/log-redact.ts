/**
 * Deterministic log preprocessing: bound the window, then redact it.
 *
 * ## Why a log tail is not a state-construction strategy
 *
 * The obvious way to build state for an incident is to take the last N lines of
 * the spool. It is also the wrong way, for two independent reasons:
 *
 * 1. **The tail is usually the cleanup, not the cause.** A batch job that fails
 *    at 02:14 spends the next forty lines closing files, backing out a unit of
 *    work and writing a condition-code summary. Tail forty lines and the causal
 *    event is already gone, while the noise that survives looks diagnostic.
 * 2. **The tail carries whatever the application logged.** In a banking batch
 *    that routinely includes card numbers in reject records, account numbers in
 *    posting errors, dataset names that encode entity and environment, internal
 *    hostnames, TSO user IDs and occasionally key-check values.
 *
 * So this module anchors a **bounded window** on the first line that matches a
 * diagnostic marker, and redacts that window before anything leaves the process.
 * Both steps are ordinary deterministic code: no model participates in deciding
 * what is sensitive, because a model deciding what to redact is a model that can
 * decide wrongly and silently.
 *
 * ## What this module does not establish
 *
 * Redaction here removes **the configured patterns**, and nothing else. It is
 * best-effort over unstructured vendor log text: an identifier in a format no
 * rule matches survives into the request, and a new vendor message can introduce
 * one at any time. The module demonstrates that minimization happens *before*
 * the request is built and that what was removed is enumerable — it is not a
 * data-loss-prevention control, it has not been tested against a real spool
 * corpus, and it must never be described as exhaustive. Treat the output as
 * reduced-sensitivity, never as non-sensitive.
 */

/** Categories are reported by name and count, so minimization is reviewable. */
export type RedactionCategory =
  | 'pan'
  | 'iban'
  | 'account'
  | 'key-material'
  | 'dataset'
  | 'hostname'
  | 'ip'
  | 'userid';

/** Dropped entirely, or replaced with a stable within-request pseudonym. */
type Treatment = 'drop' | 'pseudonym';

interface Rule {
  category: RedactionCategory;
  pattern: RegExp;
  treatment: Treatment;
  /** Short prefix used when building a pseudonym, e.g. `dsn` -> `<dsn:1>`. */
  short: string;
}

/**
 * Order matters: the most specific patterns run first, so a PAN inside a reject
 * record is not first consumed by the looser account-number rule.
 */
const RULES: readonly Rule[] = [
  {
    category: 'pan',
    // 13-19 digits in 4-digit groups, the shape card data actually appears in.
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    treatment: 'drop',
    short: 'pan',
  },
  {
    category: 'iban',
    pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,26}\b/g,
    treatment: 'drop',
    short: 'iban',
  },
  {
    category: 'key-material',
    pattern: /\b(?:KCV|KEYCHECK|TOKEN|SECRET)\s*[=:]\s*[A-Za-z0-9+/=_-]{4,}/gi,
    treatment: 'drop',
    short: 'key',
  },
  {
    category: 'account',
    pattern: /\b(?:ACCT|ACCOUNT|ACCTNO|CUSTNO)\s*[=:#]?\s*\d{6,16}\b/gi,
    treatment: 'drop',
    short: 'acct',
  },
  {
    category: 'ip',
    pattern: /\b\d{1,3}(?:\.\d{1,3}){3}\b/g,
    treatment: 'pseudonym',
    short: 'ip',
  },
  {
    category: 'dataset',
    // Three or more uppercase qualifiers, optionally a GDG generation or member.
    pattern: /\b[A-Z#$@][A-Z0-9#$@]{0,7}(?:\.[A-Z#$@][A-Z0-9#$@]{0,7}){2,}(?:\([^)]{1,8}\))?/g,
    treatment: 'pseudonym',
    short: 'dsn',
  },
  {
    category: 'hostname',
    pattern: /\b[a-z][a-z0-9-]{2,}(?:\.[a-z0-9-]{2,}){2,}\b/g,
    treatment: 'pseudonym',
    short: 'host',
  },
  {
    category: 'userid',
    pattern: /\b(?:USER|USERID|TSOID)\s*[=:]\s*[A-Z0-9#$@]{3,8}\b/gi,
    treatment: 'pseudonym',
    short: 'user',
  },
];

export interface RedactionReport {
  /** Counts by category. Zero-count categories are omitted. */
  counts: Readonly<Partial<Record<RedactionCategory, number>>>;
  /**
   * Pseudonym to original value. Retained **locally** for the engineer reading
   * the incident; it is never part of the state sent, and a caller that puts it
   * in a request has undone the minimization.
   */
  mapping: Readonly<Record<string, string>>;
}

export interface RedactedText {
  text: string;
  report: RedactionReport;
}

/**
 * Redacts one block of text.
 *
 * Pseudonyms are stable within a call, so a repeated dataset name stays visibly
 * the same value across lines — a reader can still see that two errors reference
 * one dataset without being told which dataset.
 */
export function redact(text: string): RedactedText {
  const counts: Partial<Record<RedactionCategory, number>> = {};
  const mapping: Record<string, string> = {};
  const assigned = new Map<string, string>();
  let output = text;

  for (const rule of RULES) {
    output = output.replace(rule.pattern, (match) => {
      counts[rule.category] = (counts[rule.category] ?? 0) + 1;
      if (rule.treatment === 'drop') return `<${rule.category}-redacted>`;

      const existing = assigned.get(match);
      if (existing) return existing;

      const token = `<${rule.short}:${assigned.size + 1}>`;
      assigned.set(match, token);
      mapping[token] = match;
      return token;
    });
  }

  return { text: output, report: { counts, mapping } };
}

/** Lines that anchor a diagnostic window. Cleanup chatter is deliberately absent. */
const MARKERS: readonly RegExp[] = [
  /\bIEA995I|\bIEF450I|\bIEF472I/, // abend and step-completion messages
  /\bABEND\b|\bCOMPLETION CODE\b|\bSYSTEM COMPLETION\b/,
  /\bSQLCODE\s*=?\s*-\d+/, // DB2 negative SQLCODEs
  /\bAMQ\d{4}[A-Z]?\b/, // MQ reason messages
  /\b[A-Z]{2,4}\d{3,4}[EWS]\b/, // vendor message identifiers, e.g. PLX0421E
  /\bRC=\s*(?!0000\b)\d{2,4}\b/, // non-zero return codes
  /\bERROR\b|\bFAILED\b|\bNOT FOUND\b|\bEMPTY\b/i,
];

export interface WindowOptions {
  /** Lines of context kept before the anchor. */
  before?: number;
  /** Lines of context kept after the anchor. */
  after?: number;
  /** Hard cap on lines, applied after context expansion. */
  maxLines?: number;
  /** Hard cap on characters, applied last. */
  maxChars?: number;
}

export interface DiagnosticWindow {
  /** The redacted window, ready to be placed in request state. */
  lines: readonly string[];
  /** Index of the anchor line in the original spool, for the engineer. */
  anchorLine: number | null;
  /** First and last source line included, 1-based and inclusive. */
  startLine: number;
  endLine: number;
  /** Total lines in the source spool, so the reader knows what was left out. */
  sourceLineCount: number;
  /** True when the window hit a cap rather than ending naturally. */
  truncated: boolean;
  redaction: RedactionReport;
}

/**
 * Extracts a bounded, redacted diagnostic window from a spool.
 *
 * Anchored on the **first** marker match rather than the last: in a batch flow
 * the first diagnostic message is the one most likely to be causal, and the
 * later ones are frequently its consequences. That is a heuristic about log
 * structure, not an inference about the failure, and it is stated here so nobody
 * reads it as root-cause analysis.
 *
 * When nothing matches, the head of the spool is returned rather than the tail,
 * and `anchorLine` is null so the caller can see that no marker was found.
 */
export function diagnosticWindow(
  spool: readonly string[],
  options: WindowOptions = {},
): DiagnosticWindow {
  const { before = 4, after = 12, maxLines = 24, maxChars = 2400 } = options;

  let anchor = -1;
  for (let index = 0; index < spool.length; index++) {
    const line = spool[index] ?? '';
    if (MARKERS.some((marker) => marker.test(line))) {
      anchor = index;
      break;
    }
  }

  const start = anchor === -1 ? 0 : Math.max(0, anchor - before);
  const end = anchor === -1 ? Math.min(spool.length, maxLines) : Math.min(spool.length, anchor + after + 1);

  let selected = spool.slice(start, end);
  let truncated = end < spool.length || start > 0;

  if (selected.length > maxLines) {
    selected = selected.slice(0, maxLines);
    truncated = true;
  }

  const { text, report } = redact(selected.join('\n'));
  let lines = text.split('\n');

  if (text.length > maxChars) {
    let budget = maxChars;
    const kept: string[] = [];
    for (const line of lines) {
      if (budget - line.length < 0) break;
      budget -= line.length + 1;
      kept.push(line);
    }
    lines = kept;
    truncated = true;
  }

  return {
    lines,
    anchorLine: anchor === -1 ? null : anchor,
    startLine: start + 1,
    endLine: start + lines.length,
    sourceLineCount: spool.length,
    truncated,
    redaction: report,
  };
}

/** A one-line summary of what was removed, for terminal output and ledger notes. */
export function redactionSummary(report: RedactionReport): string {
  const entries = Object.entries(report.counts);
  if (entries.length === 0) return 'no redaction patterns matched';
  return entries.map(([category, count]) => `${category}×${count}`).join(', ');
}
