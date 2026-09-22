/**
 * The browser driver: a `WalkDriver` backed by real Chrome over CDP.
 *
 * Launch, describe, peek, click, type, record, stop. None of it is specific to
 * Jev - that is the point. The decision loop in `src/site/walk.ts` is the same
 * loop example 04 runs offline; supplying one of these only makes the actions
 * real. When example 05 says "the same loop, against a real browser", this file
 * is why that is literally true rather than a claim.
 *
 * Three things here are worth knowing before trusting the output:
 *
 *   - `describe()` returns what the DOM contains, and `walk()` compares it
 *     against the graph. A mismatch throws. The live example cannot silently
 *     degrade into the fixture.
 *   - `peek()` reads the `data-peek` index on `<body>`, which is a convenience
 *     over evidence the page already renders - badges, breadcrumb titles,
 *     enabled state, the footer legend. It adds nothing the page does not show.
 *   - `replay()` backtracks by returning to the entry page and clicking the
 *     path again. Jumping straight to a URL would be faster and would not be
 *     what a browser agent can actually do.
 */

import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';

import {
  RecordingContext,
  Recorder,
  connectCDP,
  findElementBySelector,
  injectOverlays,
  moveCursorTo,
  navigate,
  pause,
} from '@webreel/core';

import { launchRecordableChrome } from './chrome-launch.ts';
import type { WalkDriver } from './site/walk.ts';
import { dim } from './ui.ts';

export const VIEWPORT = { width: 1280, height: 800 };

export interface Beats {
  settle: number;
  afterClick: number;
  /** Cursor dwell on an element before it is followed. */
  click: number;
  start: number;
  end: number;
}

export const DEFAULT_BEATS: Beats = {
  settle: 700,
  afterClick: 1200,
  click: 350,
  start: 1400,
  end: 2600,
};

export interface SessionOptions {
  /** Shown in the recorded caption strip. */
  label: string;
  detail: string;
  /** Set to record. Omit to drive a visible browser without a video. */
  outputPath?: string;
  beats?: Partial<Beats>;
}

export interface BrowserSession extends WalkDriver {
  /** Resolves to the written file, or null if recording was unavailable. */
  close(finalCaption: string): Promise<string | null>;
  recording: boolean;
}

/**
 * Step 2 of the loop: describe.
 *
 * Tags every interactive element with `data-jev` so a chosen id maps back to a
 * selector, and returns labels rather than markup. A page costs tokens in
 * proportion to its controls, not its HTML.
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
        irreversible: node.dataset.destructive === 'true' || undefined,
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
 * A silent screen recording of an agent is unreadable without knowing what it
 * is doing and why, so every run carries its label, its current state and a
 * running clock. Presentation only - it never touches the elements the agent
 * is choosing between.
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
        'font:600 24px/1.3 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif',
        'padding:15px 22px','background:#0b1020','color:#e8ecff',
        'display:flex','align-items:center','gap:18px','pointer-events:none',
        'box-shadow:0 2px 12px rgba(0,0,0,.35)',
      ].join(';');
      document.documentElement.appendChild(bar);
      document.body.style.paddingTop = '72px';
    }
    const seconds = (data.elapsedMs / 1000).toFixed(1) + 's';
    bar.innerHTML =
      '<span style="font-weight:800">' + data.label + '</span>' +
      '<span style="opacity:.6;font-weight:500;font-size:19px">' + data.detail + '</span>' +
      '<span style="margin-left:auto;opacity:.95;font-weight:500;font-size:21px">' + data.caption + '</span>' +
      '<span style="font-variant-numeric:tabular-nums;opacity:.75;min-width:74px;text-align:right">' + seconds + '</span>';
  })()`;
}

const PEEK = (probeId: string) => `(() => {
  const index = JSON.parse(document.body.dataset.peek || '{}');
  return index[${JSON.stringify(probeId)}] ?? 'unknown';
})()`;

const READ_VALUE = (elementId: string) =>
  `(document.querySelector('[data-jev=${JSON.stringify(elementId)}]')?.value ?? '')`;

export async function openSession(options: SessionOptions): Promise<BrowserSession> {
  const beats: Beats = { ...DEFAULT_BEATS, ...options.beats };
  const wantsRecording = options.outputPath !== undefined;
  if (options.outputPath !== undefined) {
    await mkdir(dirname(options.outputPath), { recursive: true });
  }

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
  ctx.setMode(wantsRecording ? 'record' : 'preview');
  ctx.resetCursorPosition(VIEWPORT.width, VIEWPORT.height);

  // fps matters more than it looks. The recorder duplicates frames to cover the
  // gap between screenshots and caps that at 3, so at the default 60fps the cap
  // clamps and playback runs fast. 20fps tracks the wall clock much closer.
  let recorder =
    wantsRecording && options.outputPath !== undefined
      ? new Recorder(VIEWPORT.width, VIEWPORT.height, { fps: 20 })
      : null;

  const started = Date.now();
  let caption = 'starting';

  const urlFor = (file: string) =>
    pathToFileURL(resolve(import.meta.dirname, '..', 'examples', 'site', file)).href;

  /** `file:///.../examples/site/billing.html` -> `billing.html`. */
  const fileOf = (href: string) => href.split('/').pop() ?? href;

  const paint = async () => {
    await client.Runtime.evaluate({
      expression: captionScript(options.label, options.detail, caption, Date.now() - started),
    });
  };

  const settle = async (file: string) => {
    await navigate(client, urlFor(file));
    await injectOverlays(client); // navigation wipes the overlay layer
    await paint();
    await pause(beats.settle);
  };

  /**
   * Follows the element the policy chose.
   *
   * Not `clickAt` from webreel: that helper fires a native CDP click *and* a
   * JS synthetic click at the same coordinates, which is fine for a static
   * page and wrong here - the native click navigates, and the synthetic one
   * then lands on whatever occupies those coordinates on the page that just
   * loaded. Two pages per click. So the cursor moves for the recording, and
   * the navigation follows the element's own href.
   */
  const clickSelector = async (elementId: string) => {
    const box = await findElementBySelector(client, `[data-jev="${elementId}"]`);
    if (box === null || box === undefined) {
      throw new Error(`No element tagged ${elementId} on screen`);
    }
    await moveCursorTo(ctx, client, box.x + box.width / 2, box.y + box.height / 2);
    await pause(beats.click);

    const { result } = await client.Runtime.evaluate({
      expression: `(() => {
        const node = document.querySelector('[data-jev=${JSON.stringify(elementId)}]');
        if (!node) return null;
        if (node.tagName === 'A' && node.getAttribute('href')) return node.href;
        const handler = node.getAttribute('onclick') || '';
        const match = handler.match(/location\\.href='([^']+)'/);
        node.click();
        return match === null ? '' : match[1];
      })()`,
      returnByValue: true,
    });

    const href = result.value as string | null;
    if (href === null) throw new Error(`Element ${elementId} vanished before the click`);
    if (href !== '') await settle(fileOf(href));
  };

  const describe = async () => {
    const { result } = await client.Runtime.evaluate({
      expression: DESCRIBE,
      returnByValue: true,
    });
    return result.value as {
      url: string;
      text: string;
      elements: { id: string; label: string }[];
    };
  };

  await settle('home.html');

  if (recorder !== null && options.outputPath !== undefined) {
    // Recording is evidence, not the point of the example. webreel fetches
    // ffmpeg on first use and that download can fail; set FFMPEG_PATH to work
    // around it. Either way the run below still happens - you lose the video,
    // not the result, and the loss is reported rather than hidden.
    try {
      await recorder.start(client, options.outputPath, ctx);
      ctx.setRecorder(recorder);
    } catch (error) {
      recorder = null;
      ctx.setMode('preview');
      console.log(
        dim(`  recording unavailable: ${error instanceof Error ? error.message : String(error)}`),
      );
    }
  }

  await pause(beats.start);

  return {
    recording: recorder !== null,

    async start(entryFile: string) {
      await settle(entryFile);
    },

    describe,

    async peek(probeId: string) {
      caption = `peek: ${probeId}`;
      await paint();
      const { result } = await client.Runtime.evaluate({
        expression: PEEK(probeId),
        returnByValue: true,
      });
      await pause(beats.settle);
      return String(result.value ?? 'unknown');
    },

    async click(elementId: string) {
      await clickSelector(elementId);
      await pause(beats.afterClick);
      await injectOverlays(client);
      await paint();
    },

    async fill(elementId: string, value: string) {
      await clickSelector(elementId);
      await client.Runtime.evaluate({
        expression: `(() => {
          const node = document.querySelector('[data-jev=${JSON.stringify(elementId)}]');
          if (node) { node.value = ${JSON.stringify(value)}; node.dispatchEvent(new Event('input', { bubbles: true })); }
        })()`,
      });
      await pause(Math.round(beats.settle / 2));
    },

    async readValue(elementId: string) {
      const { result } = await client.Runtime.evaluate({
        expression: READ_VALUE(elementId),
        returnByValue: true,
      });
      return String(result.value ?? '');
    },

    async replay(steps, entryFile) {
      await settle(entryFile);
      for (const step of steps) {
        caption = `replay: "${step.label}"`;
        await paint();
        await describe(); // re-tag after navigation
        await clickSelector(step.elementId);
        await pause(beats.afterClick);
        await injectOverlays(client);
        await paint();
      }
    },

    async caption(text: string) {
      caption = text;
      await paint();
    },

    async close(finalCaption: string) {
      caption = finalCaption;
      await paint();
      await pause(beats.end);
      const written = recorder !== null && options.outputPath !== undefined;
      try {
        if (recorder !== null) await recorder.stop();
      } finally {
        await client.close().catch(() => {});
        chrome.kill();
      }
      return written ? (options.outputPath ?? null) : null;
    },
  };
}
