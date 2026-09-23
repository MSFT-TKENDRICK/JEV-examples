/**
 * Collects decision records by running the examples, rather than by
 * reimplementing them.
 *
 * The examples already write a JSONL ledger containing the distribution, the
 * metrics, the thresholds in force and what was actually executed. That is
 * everything a sweep needs, so this harness runs each example as a subprocess
 * with `JEV_LEDGER_FILE` set and reads the result back. Nothing about the
 * pipeline, the fixtures or the policies is duplicated here — if an example
 * changes, this follows it.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DecisionRecord } from '../../../src/ledger.ts';

export interface ExampleRun {
  id: string;
  title: string;
  script: string;
  records: readonly DecisionRecord[];
}

const EXAMPLES = [
  {
    id: '07',
    title: 'Bounded next-step recommendation',
    script: 'examples/fsi/07-next-step/index.ts',
  },
  {
    id: '08',
    title: 'Residual incident runbook routing',
    script: 'examples/fsi/08-runbook-routing/index.ts',
  },
] as const;

export function collect(): ExampleRun[] {
  const dir = mkdtempSync(join(process.cwd(), '.jev-eval-'));

  try {
    return EXAMPLES.map(({ id, title, script }) => {
      const file = join(dir, `${id}.jsonl`);
      const result = spawnSync(process.execPath, [script], {
        env: {
          ...process.env,
          JEV_LEDGER_FILE: file,
          // The sweep reasons about scripted distributions on purpose. Picking up
          // a live key here would silently change what is being measured.
          TYPESAFE_API_KEY: '',
          AI_GATEWAY_API_KEY: '',
          VERCEL_OIDC_TOKEN: '',
          AI_GATEWAY_GENERATIVE: '0',
          JEV_MOCK: '1',
        },
        encoding: 'utf8',
      });

      if (result.status !== 0) {
        throw new Error(
          `Example ${id} exited with status ${result.status}. The sweep cannot ` +
            `report on a run that did not complete.\n${result.stderr ?? ''}`,
        );
      }

      const records = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as DecisionRecord);

      return { id, title, script, records };
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
