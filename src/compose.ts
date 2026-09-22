/**
 * Stitching the two recorded arms into one side-by-side video, plus a GIF.
 *
 * ffmpeg comes from `ensureFfmpeg()` — webreel already downloads and caches a
 * binary, so there is nothing to install and nothing here reimplements it.
 */

import { execFileSync } from 'node:child_process';
import { ensureFfmpeg } from '@webreel/core';

export interface StackInput {
  path: string;
  /** Seconds this arm actually took, used to hold the finisher on its last frame. */
  durationSec: number;
}

function run(bin: string, args: string[]): void {
  execFileSync(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
}

/**
 * Places two runs next to each other on one timeline starting at t=0.
 *
 * The shorter run is padded by cloning its final frame, so the arm that
 * finishes first visibly sits there finished while the other is still working.
 * That padding is the comparison — trimming to the shortest would delete it.
 */
export function stackSideBySide(left: StackInput, right: StackInput, output: string): void {
  const ffmpeg = resolveFfmpeg();
  const longest = Math.max(left.durationSec, right.durationSec);
  const tile = 'scale=960:-2,setsar=1';
  // A seam, so two screenshots of the same site read as two runs and not one
  // very wide page.
  const seam = 'pad=iw+6:ih:0:0:color=0x0b1020';

  run(ffmpeg, [
    '-y',
    '-i', left.path,
    '-i', right.path,
    '-filter_complex',
    `[0:v]${tile},${seam},tpad=stop_mode=clone:stop_duration=${(longest - left.durationSec).toFixed(2)}[a];` +
      `[1:v]${tile},tpad=stop_mode=clone:stop_duration=${(longest - right.durationSec).toFixed(2)}[b];` +
      `[a][b]hstack=inputs=2[v]`,
    '-map', '[v]',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    output,
  ]);
}

/**
 * A GIF for the README.
 *
 * GitHub will not inline-play a committed MP4 in markdown — an <img> needs an
 * animated format. Two passes (palettegen then paletteuse) because a 256-colour
 * palette chosen from the actual frames is the difference between a readable
 * screen recording and a smeared one.
 */
export function toGif(input: string, output: string, width = 1280, fps = 10): void {
  const ffmpeg = resolveFfmpeg();
  const filters = `fps=${fps},scale=${width}:-1:flags=lanczos`;

  run(ffmpeg, [
    '-y',
    '-i', input,
    '-filter_complex', `${filters},split[s0][s1];[s0]palettegen=max_colors=192[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3`,
    '-loop', '0',
    output,
  ]);
}

let cached: string | null = null;
function resolveFfmpeg(): string {
  if (!cached) throw new Error('call prepareFfmpeg() before composing');
  return cached;
}

export async function prepareFfmpeg(): Promise<void> {
  cached = await ensureFfmpeg();
}
