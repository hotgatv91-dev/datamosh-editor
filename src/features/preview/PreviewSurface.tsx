/**
 * Preview surface.
 *
 * The canvas is deliberately not allowed to eat the window: the layout caps it,
 * and the render scale can drop independently of the source resolution so a
 * weak GPU still gets a usable frame rate. Rendering is on demand when paused
 * and driven by requestAnimationFrame while playing.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import styles from './preview.module.css';
import { useEditor } from '../../state/store';
import { DatamoshPreviewRenderer, applyClipTransform } from '../../engine/datamosh/preview/renderer';
import { FrameMapCache, resolveTimelineFrame } from '../../engine/timeline/playback';
import { frameSourceRegistry } from '../../engine/frames';
import { mediaInfoFromAsset } from '../../engine/frames/types';
import { assetById } from '../../engine/timeline/derive';
import { log } from '../../engine/log';
import { errorMessage } from '../../engine/errors';
import { t } from '../../i18n/strings';
import { Empty } from '../../ui/primitives';

const QUALITY_CAP: Record<number, number> = { 0: 4096, 360: 640, 540: 960, 720: 1280 };
/**
 * How many frames are replayed to rebuild motion history when seeking into a
 * mosh region. The user can change it (`ui.primeFrames`): more frames means a
 * truer smear right after a seek, fewer means a snappier scrub. Without any
 * priming a paused seek has no history, so there is nothing to warp along.
 */
const DEFAULT_PRIME_FRAMES = 4;

export function PreviewSurface() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<DatamoshPreviewRenderer | null>(null);
  const cacheRef = useRef(new FrameMapCache());
  const busyRef = useRef(false);
  const queuedRef = useRef<number | null>(null);
  const lastFrameRef = useRef<number | null>(null);
  const playingRef = useRef(false);
  const clockRef = useRef<{ last: number; position: number }>({ last: 0, position: 0 });
  const retryRef = useRef<{ attempts: number; frame: number | null }>({ attempts: 0, frame: null });
  const retryTimerRef = useRef<number | null>(null);
  /**
   * Two preview surfaces exist for a moment when the shell switches between the
   * phone and desktop layouts. Without this the outgoing instance kept asking
   * the shared decoder for frames — every seek resets it — and the incoming one
   * starved: both timed out and the canvas stayed black.
   */
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
    };
  }, []);

  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [perfOpen, setPerfOpen] = useState(false);
  const [perfMs, setPerfMs] = useState(0);
  const [perfLanes, setPerfLanes] = useState(0);

  const project = useEditor((s) => s.project);
  const playhead = useEditor((s) => s.playhead);
  const playing = useEditor((s) => s.ui.playing);
  const previewMode = useEditor((s) => s.ui.previewMode);
  const splitPosition = useEditor((s) => s.ui.splitPosition);
  const previewQuality = useEditor((s) => s.ui.previewQuality);
  const previewFpsCap = useEditor((s) => s.ui.previewFpsCap);
  const motionQuality = useEditor((s) => s.ui.motionQuality);
  const primeFrames = useEditor((s) => s.ui.primeFrames);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const setUi = useEditor((s) => s.setUi);
  const mediaFiles = useEditor((s) => s.mediaFiles);
  const duration = useEditor((s) => s.duration);

  const primaryClip = useMemo(
    () => [...project.clips].sort((a, b) => a.track - b.track || a.startFrame - b.startFrame)[0] ?? null,
    [project.clips],
  );
  const asset = useMemo(
    () => assetById(project, primaryClip?.mediaId ?? null),
    [project, primaryClip?.mediaId],
  );

  const renderSize = useMemo(() => {
    if (!asset) return { width: 640, height: 360 };
    const cap = QUALITY_CAP[previewQuality] ?? 960;
    const longest = Math.max(asset.width, asset.height);
    const scale = Math.min(1, cap / longest);
    return {
      width: Math.max(64, Math.round(asset.width * scale)),
      height: Math.max(36, Math.round(asset.height * scale)),
    };
  }, [asset, previewQuality]);

  /* -------------------------------------------------- renderer lifecycle */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = new DatamoshPreviewRenderer(canvas);
    if (!renderer.available) {
      setUnavailable(
        'WebGL2 is not available on this device, so the datamosh preview cannot be rendered.',
      );
      renderer.dispose();
      return;
    }
    rendererRef.current = renderer;
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__previewRenderer = renderer;
    }
    return () => {
      renderer.dispose();
      rendererRef.current = null;
    };
  }, []);

  const sourceEpoch = useEditor((s) => s.ui.sourceEpoch);

  useEffect(() => {
    rendererRef.current?.setRenderSize(renderSize.width, renderSize.height);
  }, [renderSize.width, renderSize.height]);

  useEffect(() => {
    rendererRef.current?.setMotionQuality(motionQuality);
  }, [motionQuality, sourceEpoch]);

  // The performance readout is polled rather than pushed: it must not re-render
  // React on every frame, and it is only visible while the panel is open.
  useEffect(() => {
    if (!perfOpen) return;
    const id = window.setInterval(() => {
      const stats = rendererRef.current?.getStats();
      if (!stats) return;
      setPerfMs(stats.renderMs);
      setPerfLanes(stats.lanes);
    }, 400);
    return () => window.clearInterval(id);
  }, [perfOpen]);

  /* ------------------------------------------------------ frame fetching */
  const ensureSource = useCallback(
    async (mediaId: string) => {
      const existing = frameSourceRegistry.get(mediaId);
      if (existing) return existing;
      const file = mediaFiles[mediaId];
      const info = assetById(project, mediaId);
      if (!file || !info) return null;
      const result = await frameSourceRegistry.ensure(mediaId, file, mediaInfoFromAsset(info), (error) => {
        log.error('preview', 'frame source failed', error);
      });
      if (result.warnings.length) setNotice(result.warnings[0]!);
      return result.source;
    },
    [mediaFiles, project],
  );

  /**
   * Renders exactly one frame through the pipeline.
   *
   * Returns false when the decoder had no picture to hand over — a brand new
   * source needs a moment before its first frame exists, and a silent skip left
   * the canvas black until something else happened to trigger a redraw.
   */
  const renderOnce = useCallback(
    async (frame: number): Promise<boolean> => {
      const renderer = rendererRef.current;
      if (!renderer?.available || !mountedRef.current) return false;
      const resolved = resolveTimelineFrame(project, frame, cacheRef.current);
      const current = await ensureSource(resolved.mediaId ?? '');
      const image = current ? await current.getFrame(resolved.sourceFrame) : null;
      applyClipTransform(renderer, project, resolved);
      const contiguous = lastFrameRef.current === frame - 1;
      renderer.render({
        image,
        flipY: true,
        resolved,
        project,
        timelineFrame: frame,
        contiguous,
      });
      lastFrameRef.current = frame;
      return image !== null;
    },
    [ensureSource, project],
  );

  const drawFrame = useCallback(
    async (frame: number) => {
      const renderer = rendererRef.current;
      if (!renderer?.available || !mountedRef.current) return;
      if (busyRef.current) {
        queuedRef.current = frame;
        return;
      }
      busyRef.current = true;
      try {
        // Datamosh is temporal: with a single unrelated frame there is no motion
        // to warp along, so a paused seek inside a region replays the frames
        // leading into it. That is the "preview only the area around the
        // effect" behaviour, and it is what makes the smear visible at all.
        const resolved = resolveTimelineFrame(project, frame, cacheRef.current);
        const prime = Math.max(0, Math.min(8, primeFrames));
        if (resolved.datamosh.length && !playingRef.current && prime > 0) {
          const regionStart = Math.min(
            ...resolved.datamosh.map((entry) => entry.effect.startFrame),
          );
          const first = Math.max(regionStart, frame - prime);
          for (let f = first; f < frame; f += 1) {
            await renderOnce(f);
          }
        }
        const presented = await renderOnce(frame);
        /*
         * A source created a moment ago may not have decoded yet. Retry the
         * frame a few times instead of leaving a black canvas on screen until
         * something unrelated happens to trigger a redraw.
         */
        if (!presented && !playingRef.current) {
          const retry = retryRef.current;
          const attempts = retry.frame === frame ? retry.attempts + 1 : 1;
          retryRef.current = { attempts, frame };
          if (attempts <= 5) {
            if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
            retryTimerRef.current = window.setTimeout(() => void drawFrame(frame), 250);
          } else {
            // Still nothing after a second of trying: the source is wedged.
            // Drop it so the next request builds a decoder that works, and poke
            // the views into asking again.
            const mediaId = resolved.mediaId;
            if (mediaId) {
              log.warn('preview', `frame source for ${mediaId} stalled, rebuilding it`);
              frameSourceRegistry.dispose(mediaId);
              cacheRef.current = new FrameMapCache();
              setUi({ sourceEpoch: useEditor.getState().ui.sourceEpoch + 1 });
            }
          }
        } else {
          retryRef.current = { attempts: 0, frame: null };
        }
      } catch (error) {
        log.warn('preview', `render failed at frame ${frame}: ${errorMessage(error)}`);
      } finally {
        busyRef.current = false;
        const queued = queuedRef.current;
        queuedRef.current = null;
        if (queued !== null && queued !== frame) void drawFrame(queued);
      }
    },
    [project, renderOnce, primeFrames, setUi],
  );

  /* --------------------------------------------------------- playback loop */
  useEffect(() => {
    playingRef.current = playing;
    if (!playing) return;
    let raf = 0;
    let lastPresent = 0;
    clockRef.current = { last: performance.now(), position: useEditor.getState().playhead };
    const tick = () => {
      if (!playingRef.current) return;
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      const dt = Math.min(0.25, (now - clockRef.current.last) / 1000);
      clockRef.current.last = now;
      const fps = project.fps || 30;
      let position = clockRef.current.position + dt * fps;
      const total = duration();
      if (position >= total) {
        position = 0;
        lastFrameRef.current = null;
      }
      clockRef.current.position = position;
      const frame = Math.floor(position);
      // The playhead always advances, but the picture may be presented less
      // often: this is the "too laggy, show me fewer frames" dial.
      setPlayhead(frame);
      const interval = previewFpsCap > 0 ? 1000 / previewFpsCap : 0;
      if (interval && now - lastPresent < interval) return;
      lastPresent = now;
      void drawFrame(frame);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, drawFrame, project.fps, duration, setPlayhead, previewFpsCap]);

  /* --------------------------------------------- render when idle changes */
  useEffect(() => {
    if (playing) return;
    if (lastFrameRef.current !== null && Math.abs(lastFrameRef.current - playhead) > 1) {
      lastFrameRef.current = null; // a seek resets motion history
    }
    void drawFrame(playhead);
  }, [playhead, playing, drawFrame]);

  // Re-render when the project changes (new effect, moved block, new parameter)
  // or when a decoder becomes available for the first time.
  const revision = useEditor((s) => s.revision);
  useEffect(() => {
    if (playing) return;
    void drawFrame(useEditor.getState().playhead);
  }, [revision, sourceEpoch, playing, drawFrame]);

  /* ------------------------------------------------------------- controls */
  const toggleFullscreen = () => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void wrap.requestFullscreen?.().catch(() => undefined);
  };

  const hasVideo = !!primaryClip;

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <div className={clsx(styles.stage, playing && styles.stagePlaying)}>
        {/*
          The canvas is always mounted: it is the renderer's surface and binding
          it to `hasVideo` would create the WebGL context only on the second
          render pass, leaving the first render with a null renderer.
        */}
        <canvas
          ref={canvasRef}
          className={styles.canvas}
          width={renderSize.width}
          height={renderSize.height}
          style={{ objectFit: 'contain', visibility: hasVideo ? 'visible' : 'hidden' }}
        />
        {hasVideo ? null : (
          <div className={styles.stageEmpty}>
            <Empty title={t.importVideo} hint={t.dropHere} />
          </div>
        )}
        {previewMode === 'split' && hasVideo ? (
          <div className={styles.splitLine} style={{ left: `${splitPosition * 100}%` }}>
            <span className={styles.splitLabelLeft}>ORIGINAL</span>
            <span className={styles.splitLabelRight}>EFFECT</span>
          </div>
        ) : null}
        {unavailable ? <div className={styles.overlayError}>{unavailable}</div> : null}
      </div>

      <div className={styles.hud}>
        <div className={styles.hudLeft}>
          <span className={styles.hudMode}>
            {previewMode === 'original' ? 'ORIGINAL' : previewMode === 'effect' ? 'EFFECT' : 'SPLIT'}
          </span>
          {asset ? (
            <span className={styles.hudMeta}>
              {asset.width}×{asset.height} · {asset.fps} fps · {asset.container}
            </span>
          ) : null}
        </div>
        <div className={styles.hudRight}>
          {notice ? <span className={styles.hudNotice} title={notice}>{notice}</span> : null}
          <button
            type="button"
            className={clsx(styles.hudBtn, perfOpen && styles.hudBtnActive)}
            onClick={() => setPerfOpen((open) => !open)}
            title="Hiệu năng xem trước — hạ xuống nếu máy bị lag"
          >
            ⚙
          </button>
          <button
            type="button"
            className={styles.hudBtn}
            onClick={toggleFullscreen}
            title={t.fullscreen}
            disabled={!hasVideo}
          >
            ⛶
          </button>
          <select
            className={styles.hudSelect}
            value={previewQuality}
            onChange={(event) => setUi({ previewQuality: Number(event.target.value) as 0 | 360 | 540 | 720 })}
            title={`${t.previewQuality} — export always uses the full resolution`}
          >
            <option value={360}>360p</option>
            <option value={540}>540p</option>
            <option value={720}>720p</option>
            <option value={0}>Original</option>
          </select>
        </div>
      </div>

      {perfOpen ? (
        <div className={styles.perfPanel}>
          <div className={styles.perfHead}>Hiệu năng xem trước</div>
          <div className={styles.perfRow}>
            <span className={styles.perfLabel}>{t.previewQuality}</span>
            <select
              className={styles.hudSelect}
              value={previewQuality}
              onChange={(event) =>
                setUi({ previewQuality: Number(event.target.value) as 0 | 360 | 540 | 720 })
              }
            >
              <option value={360}>360p</option>
              <option value={540}>540p</option>
              <option value={720}>720p</option>
              <option value={0}>Original</option>
            </select>
          </div>
          <div className={styles.perfRow}>
            <span className={styles.perfLabel}>FPS xem trước</span>
            <select
              className={styles.hudSelect}
              value={previewFpsCap}
              onChange={(event) =>
                setUi({ previewFpsCap: Number(event.target.value) as 0 | 24 | 30 | 60 })
              }
              title="Giới hạn số khung hình vẽ ra mỗi giây khi đang phát"
            >
              <option value={0}>Không giới hạn</option>
              <option value={60}>60</option>
              <option value={30}>30</option>
              <option value={24}>24</option>
            </select>
          </div>
          <div className={styles.perfRow}>
            <span className={styles.perfLabel}>Motion vector</span>
            <select
              className={styles.hudSelect}
              value={motionQuality}
              onChange={(event) =>
                setUi({ motionQuality: event.target.value as typeof motionQuality })
              }
              title="Nguồn tốn máy nhất của preview. 'Đầy đủ' = motion thật; 'Tắt tìm chuyển động' vẫn thấy vệt kéo nhưng không dựa trên chuyển động thật."
            >
              <option value="full">Đầy đủ (motion thật)</option>
              <option value="fast">Nhanh (lưới thưa)</option>
              <option value="flat">Tắt tìm chuyển động</option>
            </select>
          </div>
          <div className={styles.perfRow}>
            <span className={styles.perfLabel}>Khung replay khi seek</span>
            <input
              className={styles.perfRange}
              type="range"
              min={0}
              max={8}
              step={1}
              value={primeFrames}
              onChange={(event) => setUi({ primeFrames: Number(event.target.value) })}
              title="Số khung phát lại để dựng lịch sử chuyển động khi nhảy vào giữa vùng datamosh. 0 = nhẹ nhất."
            />
            <span className={styles.perfValue}>{primeFrames}f</span>
          </div>
          <div className={styles.perfStat}>
            {perfMs.toFixed(1)} ms/frame · {perfLanes} lane
          </div>
        </div>
      ) : null}
    </div>
  );
}

export { QUALITY_CAP, DEFAULT_PRIME_FRAMES };
