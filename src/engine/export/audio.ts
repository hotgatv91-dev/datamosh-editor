/**
 * Export audio — the ffmpeg-facing half.
 *
 * Two jobs, in this order of importance:
 *
 *   1. **The original audio survives the export at all.** The video pipeline
 *      encodes video-only segments (every ffmpeg call is `-an`), so without
 *      this step the result is silent no matter what the source contains.
 *
 *   2. **Inside a datamosh region the audio melts with the picture.** Pitch
 *      drop plus stutter, driven by the region's own parameters — the audio
 *      half of "the motion drifts and the picture smears".
 *
 * The span layout and the filter chain are decided in audioPlan.ts; this file
 * only talks to the encoder.
 */

import { AUDIO_BITRATE, AUDIO_SAMPLE_RATE, buildAudioFilterGraph, type AudioSpan } from './audioPlan';
import { ffmpegClient } from './ffmpegClient';
import { log } from '../log';

export interface AudioBuildResult {
  fileName: string;
  container: 'mp4' | 'webm';
}

function audioCodecFor(container: 'mp4' | 'webm'): { codec: string; name: string } {
  return container === 'webm'
    ? { codec: 'libopus', name: 'audio.ogg' }
    : { codec: 'aac', name: 'audio.m4a' };
}

/**
 * Builds the complete audio track for the export.
 *
 * Returns null when there is nothing usable to build — the caller then exports
 * video-only and says so, instead of failing the whole export or, worse,
 * silently dropping the sound.
 */
export async function buildExportAudio(
  inputName: string,
  spans: AudioSpan[],
  fps: number,
  container: 'mp4' | 'webm',
): Promise<AudioBuildResult | null> {
  if (!spans.length) return null;
  const { codec, name } = audioCodecFor(container);

  const encodeArgs = [
    '-ac', '2',
    '-ar', String(AUDIO_SAMPLE_RATE),
    '-c:a', codec,
    '-b:a', AUDIO_BITRATE,
    name,
  ];

  const graph = buildAudioFilterGraph(spans, fps);
  log.info(
    'export',
    `audio: ${spans.length} span(s), ${spans.filter((span) => span.mangle).length} mangled`,
  );
  const graphCode = await ffmpegClient.exec([
    '-i', inputName,
    '-filter_complex', graph,
    '-map', '[out]',
    ...encodeArgs,
  ]);

  if (graphCode !== 0) {
    // The graph is the part most likely to hit a wasm build missing a filter.
    // Losing the mangle is acceptable; losing the sound is not.
    log.warn('export', 'audio filter graph failed; falling back to the untouched track');
    const plainCode = await ffmpegClient.exec(['-i', inputName, '-vn', ...encodeArgs]);
    if (plainCode !== 0) return null;
  }

  return { fileName: name, container };
}

/** Muxes the built audio back into the finished video, without re-encoding it. */
export async function muxAudioIntoVideo(
  videoName: string,
  audioName: string,
  container: 'mp4' | 'webm',
  outName: string,
): Promise<boolean> {
  const codec = container === 'webm' ? 'libopus' : 'aac';
  const args = [
    '-i', videoName,
    '-i', audioName,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', 'copy',
    '-c:a', codec,
    '-b:a', AUDIO_BITRATE,
    // Both tracks are cut from the same spans, but encoders pad: trim to the
    // shorter one rather than guessing which is right.
    '-shortest',
  ];
  if (container === 'mp4') args.push('-movflags', '+faststart');
  args.push(outName);

  const code = await ffmpegClient.exec(args);
  if (code !== 0) {
    log.warn('export', 'audio mux failed');
    return false;
  }
  return true;
}
