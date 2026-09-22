/**
 * The browser driver, shared by every browser example.
 *
 * Launch, record, describe, click, stop. None of it is specific to Jev — that
 * is the point. Example 05 runs one arm through this driver, example 06 runs
 * two, and the only thing that changes between arms is the `decide` function
 * they hand in. When the comparison says "same loop, same page, same clicks,
 * different decision model", this file is why that is literally true.
 */

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  RecordingContext,
  Recorder,
  clickAt,
  connectCDP,
  findElementBySelector,
  injectOverlays,
  moveCursorTo,
  navigate,
  pause,
} from '@webreel/core';

import { launchRecordableChrome } from './chrome-launch.ts';
import type { PageElement, Status } from './browser-policy.ts';
import { dim } from './ui.ts';

export const VIEWPORT = { width: 1280, height: 800 };

export interface PageView {
  url: string;
  text: string;
  elements: PageElement[];
}

/** What an arm may ask the driver to do next. */
export type StepDecision =
  | { kind: 'act'; elementId: string }
  | { kind: 'terminal'; status: Status; reason: string };

export interface StepOutcome {
  decision: StepDecision;
  /** Lines to print under the step heading. The arm owns its own narration. */
  lines: string[];
  /** What the caption should say while this decision is on screen. */
  caption: string;
}

export interface Arm {
  /** Shown in the recorded caption and the console. */
  label: string;
  /** Sub-caption: which model, and whether it is live or replayed. */
  detail: string;
  decide(page: PageView, history: string[]): Promise<StepOutcome>;
}

export interface RunOptions {
  arm: Arm;
  /** First page, relative to `examples/site`. */
  entry: string;
  outputPath?: string;
  maxSteps?: number;
  /** Set by the caller so both arms in a comparison hold identical timing. */
  beats?: { settle: number; afterClick: number; start: number; end: number };
}

export interface RunResult {
  status: Status;
  history: string[];
  answer?: string;
  finalPage: string;
  steps: number;
  /** Wall-clock time inside `arm.decide`, summed. Real measurement. */
  decisionMs: number;
  /** Wall-clock time for the whole run, launch excluded. */
  totalMs: number;
  videoPath?: string;
}

const DEFAULT_BEATS = { settle: 900, afterClick: 1600, start: 1400, end: 2200 };

/**
 * Step 2 of the loop: describe.
 *
 * Tags every interactive element with `data-jev` so a chosen id maps back to a
 * selector, and returns labels rather than markup. A page therefore costs
 * tokens in proportion to its controls, not its HTML.
 */
const DESCRIBE = `(() => {
  const nodes = [...document.querySelectorAll('a[href], button, [role="tab"], input')];
  const elements = nodes
    .filter((node) => {
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    })
    .map((node, index) => {
      const id = 'e' + (index + 1);
      node.setAttribute('data-jev', id);
      const tag = node.tagName.toLowerCase();
      const role = node.getAttribute('role') === 'tab' ? 'tab'
        : tag === 'a' ? 'link'
        : tag === 'input' ? 'input'
        : 'button';
      return {
        id,
        role,
        label: (node.innerText || node.value || node.getAttribute('aria-label') || '').trim(),
        destructive: node.dataset.destructive === 'true' || undefined,
      };
    })
    .filter((element) => element.label.length > 0);

  return {
    url: location.pathname.split('/').pop(),
    text: (document.querySelector('main')?.innerText || document.body.innerText)
      .replace(/\\s+/g, ' ').trim().slice(0, 400),
    elements,
  };
})()`;

/**
 * The caption strip burned into the recording.
 *
 * Two videos side by side are unreadable without knowing which is which and
 * what each one is waiting on, so every run carries its own label, its current
 * state and a running clock. This is presentation only — it never touches the
 * elements the agent is choosing between.
 */
function captionScript(label: string, detail: string, caption: string, elapsedMs: number): string {
  const payload = JSON.stringify({ label, detail, caption, elapsedMs });
  return `(() => {
    const data = ${payload};
    let bar = document.getElementById('__jev_caption');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = '__jev_caption';
      bar.style.cssText = [
        'position:fixed','top:0','left:0','right:0','z-index:2147483646',
        'font:600 26px/1.3 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif',
        'padding:16px 22px','background:#0b1020','color:#e8ecff',
        'display:flex','align-items:center','gap:18px','pointer-events:none',
        'box-shadow:0 2px 12px rgba(0,0,0,.35)',
      ].join(';');
      document.documentElement.appendChild(bar);
      document.body.style.paddingTop = '76px';
    }
    const seconds = (data.elapsedMs / 1000).toFixed(1) + 's';
    bar.innerHTML =
      '<span style="font-weight:800">' + data.label + '</span>' +
      '<span style="opacity:.6;font-weight:500;font-size:20px">' + data.detail + '</span>' +
      '<span style="margin-left:auto;opacity:.95;font-weight:500;font-size:22px">' + data.caption + '</span>' +
      '<span style="font-variant-numeric:tabular-nums;opacity:.75;min-width:78px;text-align:right">' + seconds + '</span>';
  })()`;
}

export async function runArm(options: RunOptions): Promise<RunResult> {
  const { arm, entry } = options;
  const maxSteps = options.maxSteps ?? 6;
  const beats = options.beats ?? DEFAULT_BEATS;
  const record = Boolean(options.outputPath);

  if (options.outputPath) await mkdir(dirname(options.outputPath), { recursive: true });

  const chrome = await launchRecordableChrome();
  const client = await connectCDP(chrome.port);

  await client.Page.enable();
  await client.DOM.enable();
  await client.Runtime.enable();
  await client.Emulation.setDeviceMetricsOverride({
    ...VIEWPORT,
    deviceScaleFactor: 1,
    mobile: false,
  });

  const ctx = new RecordingContext();
  ctx.setMode(record ? 'record' : 'preview');
  ctx.resetCursorPosition(VIEWPORT.width, VIEWPORT.height);

  // fps matters more than it looks. The recorder duplicates frames to cover the
  // gap between screenshots and caps that at 3, so at the default 60fps the cap
  // clamps and playback runs fast. 20fps tracks the wall clock much closer.
  let recorder =
    record && options.outputPath ? new Recorder(VIEWPORT.width, VIEWPORT.height, { fps: 20 }) : null;

  const siteUrl = (page: string) =>
    pathToFileURL(resolve(import.meta.dirname, '..', 'examples', 'site', page)).href;

  const history: string[] = [];
  let status: Status = 'running';
  let answer: string | undefined;
  let currentPage = entry;
  let decisionMs = 0;
  let steps = 0;

  const started = Date.now();
  let caption = 'starting';
  const paint = async () => {
    await client.Runtime.evaluate({
      expression: captionScript(arm.label, arm.detail, caption, Date.now() - started),
    });
  };

  try {
    await navigate(client, siteUrl(currentPage));
    await injectOverlays(client);
    await paint();

    if (recorder && options.outputPath) {
      // Recording is decoration, not the point. webreel fetches ffmpeg on first
      // use and that download can fail — webreel 0.1.4 asks for a build its
      // upstream no longer publishes. Set FFMPEG_PATH to work around it. Either
      // way the loop below still runs; you just lose the video.
      try {
        await recorder.start(client, options.outputPath, ctx);
        ctx.setRecorder(recorder);
      } catch (err) {
        recorder = null;
        ctx.setMode('preview');
        console.log(
          dim(`  recording unavailable (${err instanceof Error ? err.message : String(err)})`),
        );
      }
    }

    await pause(beats.start);

    for (let step = 0; step < maxSteps; step++) {
      await pause(beats.settle);

      const { result } = await client.Runtime.evaluate({
        expression: DESCRIBE,
        returnByValue: true,
      });
      const page = result.value as PageView;
      currentPage = page.url;

      caption = 'thinking…';
      await paint();

      const before = Date.now();
      const outcome = await arm.decide(page, history);
      decisionMs += Date.now() - before;
      steps = step + 1;

      caption = outcome.caption;
      await paint();

      for (const line of outcome.lines) console.log(line);

      if (outcome.decision.kind === 'terminal') {
        status = outcome.decision.status;
        answer = status === 'done' ? page.text : undefined;
        break;
      }

      const targetId = outcome.decision.elementId;
      const element = page.elements.find((candidate) => candidate.id === targetId);
      if (!element) {
        status = 'stuck';
        break;
      }

      // Irreversibility is a DOM fact, enforced here, for every arm. No
      // decision model — probabilistic or generative — gets a vote on it.
      if (element.destructive) {
        status = 'needs_confirmation';
        console.log(`  ${dim(`blocked: "${element.label}" is irreversible`)}`);
        break;
      }

      const box = await findElementBySelector(client, `[data-jev="${element.id}"]`);
      if (!box) {
        status = 'stuck';
        break;
      }

      await moveCursorTo(ctx, client, box.x + box.width / 2, box.y + box.height / 2);
      await clickAt(ctx, client, box.x + box.width / 2, box.y + box.height / 2);
      history.push(`click "${element.label}"`);

      await pause(beats.afterClick);
      await injectOverlays(client); // navigation wipes the overlay layer
      await paint();

      if (step === maxSteps - 1) status = 'max_steps';
    }

    caption = status === 'done' ? 'done' : status;
    await paint();
    await pause(beats.end);
  } finally {
    if (recorder) await recorder.stop();
    await client.close().catch(() => {});
    chrome.kill();
  }

  return {
    status,
    history,
    answer,
    finalPage: currentPage,
    steps,
    decisionMs,
    totalMs: Date.now() - started,
    ...(recorder && options.outputPath ? { videoPath: options.outputPath } : {}),
  };
}
