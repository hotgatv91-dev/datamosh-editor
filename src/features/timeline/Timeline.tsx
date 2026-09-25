/**
 * Timeline.
 *
 * Canvas draws the ruler, the selection strip, the video track with thumbnails
 * and the playhead — one element, no per-frame DOM. Effect blocks are DOM so
 * they can be dragged and resized with real hit areas (>=26px on touch), and
 * they are the *only* representation of an effect region: there is no separate
 * panel list, so what you see on the timeline is the truth.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import styles from './timeline.module.css';
import { useEditor } from '../../state/store';
import type { Effect, Frame } from '../../engine/project/types';
import {
  chooseTickStep,
  clipEndFrame,
  formatShortTime,
  formatTimecode,
  frameToX,
  showFrameGrid,
  snapFrame,
  collectSnapTargets,
  xToFrameRounded,
  fitZoom,
  clampZoom,
  type Viewport,
} from '../../engine/timeline/math';
import { assetForClip, clipsSorted, effectLaneCount } from '../../engine/timeline/derive';
import { useIsMobile } from '../../hooks/useMediaQuery';
import { frameSourceRegistry } from '../../engine/frames';
import { presetById } from '../../engine/datamosh/presets';
import { effectGlyph, effectLabel } from '../../engine/effects/registry';
import { ThumbnailCache, THUMBNAIL_SIZE } from './thumbnails';
import { startPointerDrag } from './drag';
import * as ops from '../../engine/timeline/ops';
import { t } from '../../i18n/strings';
import { Button } from '../../ui/primitives';

const RULER_H = 20;
const SELECT_H = 14;
const TRACK_H = 52;
const CANVAS_H = RULER_H + SELECT_H + TRACK_H;
const LANE_H = 22;
const EDGE_GRAB_PX = 9;

type HitTarget = 'ruler' | 'select' | 'clip-move' | 'clip-trim-start' | 'clip-trim-end' | 'empty';

export function Timeline() {
  const project = useEditor((s) => s.project);
  const playhead = useEditor((s) => s.playhead);
  const selection = useEditor((s) => s.selection);
  const pxPerFrame = useEditor((s) => s.ui.pxPerFrame);
  const scrollFrame = useEditor((s) => s.ui.scrollFrame);
  const setUi = useEditor((s) => s.setUi);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const setSelection = useEditor((s) => s.setSelection);
  const mutate = useEditor((s) => s.mutate);
  const duration = useEditor((s) => s.duration);
  const sourceEpoch = useEditor((s) => s.ui.sourceEpoch);
  const isMobile = useIsMobile();

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const thumbsRef = useRef(new ThumbnailCache());
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState<HitTarget | null>(null);
  /** Frame an effect block is currently snapped to, drawn as a guide line. */
  const [snapGuide, setSnapGuide] = useState<Frame | null>(null);

  const clips = useMemo(() => clipsSorted(project), [project]);
  const total = Math.max(duration(), project.fps || 30);
  const laneCount = Math.max(1, effectLaneCount(project));

  const view: Viewport = { pxPerFrame, startFrame: scrollFrame, width };
  const visibleFrames = width / pxPerFrame;
  const maxScroll = Math.max(0, total - visibleFrames * 0.25);

  const clampScroll = useCallback(
    (frame: number) => Math.max(0, Math.min(maxScroll, frame)),
    [maxScroll],
  );

  /* ------------------------------------------------------------- sizing */
  useEffect(() => {
    const element = bodyRef.current;
    if (!element) return;
    const update = () => setWidth(Math.max(200, element.clientWidth));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /* -------------------------------------------------------------- drawing */
  const draw = useCallback(
    (interactiveRedraw = false) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(CANVAS_H * dpr)) {
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(CANVAS_H * dpr);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${CANVAS_H}px`;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, CANVAS_H);

      const fps = project.fps || 30;

      // backgrounds
      ctx.fillStyle = '#101316';
      ctx.fillRect(0, 0, width, RULER_H);
      ctx.fillStyle = '#0b0d10';
      ctx.fillRect(0, RULER_H, width, SELECT_H);
      ctx.fillStyle = '#0e1114';
      ctx.fillRect(0, RULER_H + SELECT_H, width, TRACK_H);

      // frame grid at deep zoom
      if (showFrameGrid(pxPerFrame)) {
        ctx.strokeStyle = 'rgba(255,255,255,0.035)';
        ctx.lineWidth = 1;
        const first = Math.floor(scrollFrame);
        const last = scrollFrame + visibleFrames;
        ctx.beginPath();
        for (let f = first; f <= last; f += 1) {
          const x = Math.round(frameToX(f, view)) + 0.5;
          ctx.moveTo(x, RULER_H);
          ctx.lineTo(x, CANVAS_H);
        }
        ctx.stroke();
      }

      // ruler
      const rawStep = chooseTickStep(pxPerFrame, fps);
      const step = Math.max(1, rawStep);
      const firstTick = Math.floor(scrollFrame / step) * step;
      ctx.strokeStyle = '#2a2f36';
      ctx.fillStyle = '#666f7a';
      ctx.font = '10px ui-monospace, monospace';
      ctx.textBaseline = 'middle';
      ctx.beginPath();
      for (let f = firstTick; f <= scrollFrame + visibleFrames + step; f += step) {
        if (f < 0) continue;
        const x = Math.round(frameToX(f, view)) + 0.5;
        ctx.moveTo(x, RULER_H - 6);
        ctx.lineTo(x, RULER_H);
        ctx.fillText(step <= fps ? `${Math.round(f / (fps / step))}` : formatShortTime(f, fps), x + 3, RULER_H / 2 - 1);
      }
      ctx.stroke();

      // video track + thumbnails
      const trackTop = RULER_H + SELECT_H;
      for (const clip of clips) {
        const startX = frameToX(clip.startFrame, view);
        const endX = frameToX(clipEndFrame(clip), view);
        if (endX < -4 || startX > width + 4) continue;
        const x0 = Math.max(-2, startX);
        const x1 = Math.min(width + 2, endX);
        const gradient = ctx.createLinearGradient(0, trackTop, 0, trackTop + TRACK_H);
        gradient.addColorStop(0, '#20262e');
        gradient.addColorStop(1, '#161a1f');
        ctx.fillStyle = gradient;
        ctx.fillRect(x0, trackTop + 1, Math.max(1, x1 - x0), TRACK_H - 2);
        ctx.strokeStyle = selection.clipId === clip.id ? '#3d8bfd' : '#2f353d';
        ctx.lineWidth = 1;
        ctx.strokeRect(x0 + 0.5, trackTop + 1.5, Math.max(1, x1 - x0 - 1), TRACK_H - 3);

        // thumbnail strip
        const asset = assetForClip(project, clip);
        if (asset) {
          const source = frameSourceRegistry.get(asset.id);
          const thumbFrames = Math.max(1, Math.round((THUMBNAIL_SIZE.width * 2) / pxPerFrame));
          const clipThumbCount = cloneCount(clip.inFrame, clip.outFrame, clip.startFrame, clip.speed, thumbFrames);
          for (let i = 0; i < clipThumbCount; i += 1) {
            const timelineFrame = clip.startFrame + i * thumbFrames;
            const sourceFrame = Math.round(clip.inFrame + i * thumbFrames * clip.speed);
            if (sourceFrame >= clip.outFrame) break;
            const tx = frameToX(timelineFrame, view);
            const tw = thumbFrames * pxPerFrame;
            if (tx + tw < -8 || tx > width + 8) continue;
            const bitmap = thumbsRef.current.get(asset.id, sourceFrame);
            if (bitmap && source) {
              ctx.save();
              ctx.beginPath();
              ctx.rect(x0, trackTop + 1, Math.max(1, x1 - x0), TRACK_H - 2);
              ctx.clip();
              const height = TRACK_H - 8;
              const ratio = THUMBNAIL_SIZE.width / THUMBNAIL_SIZE.height;
              const drawWidth = height * ratio;
              ctx.globalAlpha = 0.92;
              ctx.drawImage(bitmap, tx + 2, trackTop + 4, Math.min(drawWidth, tw - 2), height);
              ctx.restore();
            } else if (source) {
              thumbsRef.current.request(asset.id, sourceFrame, source, () => {
                if (!interactiveRedraw) draw(false);
              });
            }
          }
        }

        // clip label
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        const label = `${asset?.name ?? 'clip'}  ·  ${formatTimecode(clip.startFrame, fps)} → ${formatTimecode(clipEndFrame(clip), fps)}`;
        ctx.font = '10px ui-monospace, monospace';
        const textWidth = Math.min(x1 - x0 - 10, ctx.measureText(label).width + 8);
        if (textWidth > 30) {
          ctx.fillRect(x0 + 4, trackTop + 4, textWidth, 14);
          ctx.fillStyle = '#c9d1da';
          ctx.fillText(label, x0 + 8, trackTop + 11);
        }
      }

      // selection range
      if (selection.range) {
        const a = frameToX(Math.min(selection.range.start, selection.range.end), view);
        const b = frameToX(Math.max(selection.range.start, selection.range.end), view);
        ctx.fillStyle = 'rgba(255,171,31,0.20)';
        ctx.fillRect(a, RULER_H, Math.max(1, b - a), CANVAS_H - RULER_H);
        ctx.strokeStyle = '#ffab1f';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(a) + 0.5, RULER_H);
        ctx.lineTo(Math.round(a) + 0.5, CANVAS_H);
        ctx.moveTo(Math.round(b) + 0.5, RULER_H);
        ctx.lineTo(Math.round(b) + 0.5, CANVAS_H);
        ctx.stroke();
        ctx.fillStyle = '#ffab1f';
        ctx.font = '10px ui-monospace, monospace';
        ctx.fillText(
          `${formatTimecode(Math.min(selection.range.start, selection.range.end), fps)} → ${formatTimecode(Math.max(selection.range.start, selection.range.end), fps)}`,
          a + 4,
          RULER_H + SELECT_H / 2,
        );
      } else if (clips.length) {
        ctx.fillStyle = '#3a424c';
        ctx.font = '10px ui-monospace, monospace';
        // Marking is optional now: an effect can be added straight from the tool
        // panel and then aligned by dragging its block.
        ctx.fillText('KÉO ĐỂ ĐÁNH DẤU VÙNG (KHÔNG BẮT BUỘC)', 6, RULER_H + SELECT_H / 2);
      }

      // playhead
      const playheadX = Math.round(frameToX(playhead, view)) + 0.5;
      ctx.strokeStyle = '#ff5a5a';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(playheadX, 0);
      ctx.lineTo(playheadX, CANVAS_H);
      ctx.stroke();
      ctx.fillStyle = '#ff5a5a';
      ctx.beginPath();
      ctx.moveTo(playheadX - 5, 0);
      ctx.lineTo(playheadX + 5, 0);
      ctx.lineTo(playheadX, 7);
      ctx.closePath();
      ctx.fill();
    },
    [
      width,
      view,
      project,
      clips,
      playhead,
      selection.range,
      selection.clipId,
      pxPerFrame,
      scrollFrame,
      visibleFrames,
      duration,
    ],
  );

  useEffect(() => {
    draw();
  }, [draw, project.effects, project.clips, playhead, pxPerFrame, scrollFrame, width, sourceEpoch]);

  /* ------------------------------------------------------- keyboard edits */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      // Never steal keys from a field the user is typing in.
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable) {
        return;
      }
      const selectedId = useEditor.getState().selection.effectId;
      if (event.key === 'Escape') {
        useEditor.getState().setSelection({ effectId: null, range: null });
        return;
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId) {
        event.preventDefault();
        mutate('Delete effect', (draft) => ops.deleteEffect(draft, selectedId));
        useEditor.getState().setSelection({ effectId: null });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mutate]);

  /* ---------------------------------------------------------- hit testing */
  const hitTest = (x: number, y: number): { target: HitTarget; frame: Frame } => {
    const frame = xToFrameRounded(x, view);
    if (y <= RULER_H) return { target: 'ruler', frame };
    if (y <= RULER_H + SELECT_H) return { target: 'select', frame };
    for (const clip of clips) {
      const startX = frameToX(clip.startFrame, view);
      const endX = frameToX(clipEndFrame(clip), view);
      if (x >= startX - EDGE_GRAB_PX && x <= startX + EDGE_GRAB_PX) {
        return { target: 'clip-trim-start', frame };
      }
      if (x >= endX - EDGE_GRAB_PX && x <= endX + EDGE_GRAB_PX) {
        return { target: 'clip-trim-end', frame };
      }
      if (x > startX && x < endX) return { target: 'clip-move', frame };
    }
    return { target: 'empty', frame };
  };

  const snapTargets = useMemo(
    () => collectSnapTargets(project.clips, [playhead], project.effects),
    [project.clips, project.effects, playhead],
  );

  const onCanvasPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const startX = event.clientX - rect.left;
    const startY = event.clientY - rect.top;
    const hit = hitTest(startX, startY);

    const snap = (frame: Frame) => snapFrame(frame, snapTargets, pxPerFrame, 7).frame;

    if (hit.target === 'ruler') {
      setUi({ playing: false });
      setPlayhead(snap(hit.frame));
      startPointerDrag(event.nativeEvent, canvas, {
        onMove: ({ x }) => {
          setPlayhead(snap(xToFrameRounded(x - rect.left, view)));
        },
      });
      return;
    }

    if (hit.target === 'select' || hit.target === 'empty') {
      const anchor = snap(hit.frame);
      setSelection({ range: { start: anchor, end: anchor + 1 }, effectId: null });
      startPointerDrag(event.nativeEvent, canvas, {
        onMove: ({ x }) => {
          const frame = snap(xToFrameRounded(x - rect.left, view));
          setSelection({ range: { start: Math.min(anchor, frame), end: Math.max(anchor, frame) + 1 } });
        },
      });
      return;
    }

    const clip = clips.find((c) => {
      const startX2 = frameToX(c.startFrame, view);
      const endX2 = frameToX(clipEndFrame(c), view);
      return startX >= startX2 - EDGE_GRAB_PX && startX <= endX2 + EDGE_GRAB_PX;
    });
    if (!clip) return;
    setSelection({ clipId: clip.id, effectId: null });

    if (hit.target === 'clip-move') {
      const originalStart = clip.startFrame;
      startPointerDrag(event.nativeEvent, canvas, {
        onStart: () => clip,
        onMove: ({ dx }) => {
          const delta = Math.round(dx / pxPerFrame);
          const target = snap(originalStart + delta);
          mutate('Move clip', (draft) => ops.moveClip(draft, clip.id, target), `clip-move-${clip.id}`);
        },
      });
      return;
    }

    if (hit.target === 'clip-trim-start') {
      startPointerDrag(event.nativeEvent, canvas, {
        onStart: () => clip,
        onMove: ({ x }) => {
          const frame = snap(xToFrameRounded(x - rect.left, view));
          mutate('Trim clip start', (draft) => ops.trimClipStart(draft, clip.id, frame), `trim-start-${clip.id}`);
        },
      });
      return;
    }

    if (hit.target === 'clip-trim-end') {
      startPointerDrag(event.nativeEvent, canvas, {
        onStart: () => clip,
        onMove: ({ x }) => {
          const frame = snap(xToFrameRounded(x - rect.left, view));
          mutate('Trim clip end', (draft) => ops.trimClipEnd(draft, clip.id, frame), `trim-end-${clip.id}`);
        },
      });
      return;
    }
  };

  const onCanvasMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const hit = hitTest(event.clientX - rect.left, event.clientY - rect.top);
    if (hit.target !== hover) setHover(hit.target);
  };

  const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey) {
      const rect = bodyRef.current?.getBoundingClientRect();
      const anchorX = rect ? event.clientX - rect.left : width / 2;
      const anchorFrame = scrollFrame + anchorX / pxPerFrame;
      const next = clampZoom(pxPerFrame * (event.deltaY < 0 ? 1.25 : 0.8));
      setUi({ pxPerFrame: next, scrollFrame: clampScroll(anchorFrame - anchorX / next) });
      return;
    }
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    setUi({ scrollFrame: clampScroll(scrollFrame + delta / pxPerFrame) });
  };

  const zoomBy = (factor: number) => {
    const next = clampZoom(pxPerFrame * factor);
    const anchorFrame = scrollFrame + visibleFrames / 2;
    setUi({ pxPerFrame: next, scrollFrame: clampScroll(anchorFrame - width / next / 2) });
  };

  const cursor =
    hover === 'clip-trim-start' || hover === 'clip-trim-end'
      ? 'ew-resize'
      : hover === 'clip-move'
        ? 'grab'
        : hover === 'ruler'
          ? 'pointer'
          : 'crosshair';

  const effectRows = Math.max(1, laneCount);

  /*
   * Bring a newly selected block into view.
   *
   * Creating an effect drops a block near the playhead, which can easily be
   * outside the visible window — on a phone, off screen is the same as absent,
   * and the whole point of "no I/O marks" is that the block itself is the thing
   * you then drag. A block that is already fully visible is left alone, so a
   * manual scroll is never yanked away.
   */
  const selectedEffectId = selection.effectId;
  useEffect(() => {
    if (!selectedEffectId) return;
    const effect = project.effects.find((e) => e.id === selectedEffectId);
    if (!effect) return;
    const pad = 28;
    const startX = (effect.startFrame - scrollFrame) * pxPerFrame;
    const endX = (effect.endFrame - scrollFrame) * pxPerFrame;
    if (startX >= pad && endX <= width - pad) return;
    const span = effect.endFrame - effect.startFrame;
    const centred = effect.startFrame - (width / pxPerFrame - span) / 2;
    setUi({ scrollFrame: Math.max(0, centred) });
    // Deliberately keyed on the selection alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEffectId]);

  return (
    <div className={styles.timeline}>
      <div className={styles.toolbar}>
        <span className={styles.toolLabel}>{t.timeline}</span>
        <Button variant="ghost" onClick={() => zoomBy(0.8)} title={t.zoomOut}>
          −
        </Button>
        <Button variant="ghost" onClick={() => zoomBy(1.25)} title={t.zoomIn}>
          +
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            const next = fitZoom(total, width);
            setUi({ pxPerFrame: next, scrollFrame: 0 });
          }}
          title={t.fitTimeline}
        >
          {t.fit}
        </Button>
        <span className={styles.zoomReadout}>
          {pxPerFrame >= 1 ? `${pxPerFrame.toFixed(1)} px/frame` : `1 px / ${(1 / pxPerFrame).toFixed(1)} f`}
        </span>

        <div className={styles.toolSep} />

        <Button
          onClick={() => {
            const id = selection.clipId ?? clips[0]?.id;
            if (!id) return;
            mutate(t.splitAtPlayhead, (draft) => ops.splitClip(draft, id, playhead));
          }}
          title={`${t.splitAtPlayhead} (S)`}
          disabled={!clips.length}
        >
          {t.splitAtPlayhead}
        </Button>
        <Button
          onClick={() => {
            if (selection.effectId) {
              mutate('Duplicate effect', (draft) => ops.duplicateEffect(draft, selection.effectId!));
              return;
            }
            if (selection.clipId) {
              mutate('Duplicate clip', (draft) => ops.duplicateClip(draft, selection.clipId!));
            }
          }}
          disabled={!selection.effectId && !selection.clipId}
          title={t.duplicate}
        >
          {t.duplicate}
        </Button>
        <Button
          variant="danger"
          onClick={() => {
            if (selection.effectId) {
              mutate('Delete effect', (draft) => ops.deleteEffect(draft, selection.effectId!));
              setSelection({ effectId: null });
              return;
            }
            if (selection.clipId) {
              mutate('Delete clip', (draft) => ops.deleteClip(draft, selection.clipId!));
              setSelection({ clipId: null });
            }
          }}
          disabled={!selection.effectId && !selection.clipId}
          title={`${t.deleteSelected} (Del)`}
        >
          {t.deleteSelected}
        </Button>

        <div className={styles.toolSep} />

        {/*
         * In/Out marking is optional now that a block can be created straight
         * from a panel, and on a phone the buttons pushed Split/Duplicate/Delete
         * off the edge of a toolbar that has to stay scrollable. Dragging on the
         * selection strip still marks a range for anyone who wants one.
         */}
        {isMobile ? null : (
          <>
            <Button
              onClick={() =>
                setSelection({
                  range: { start: playhead, end: Math.max(playhead + 1, selection.range?.end ?? playhead + 1) },
                })
              }
              title={`${t.markIn} (I)`}
            >
              I
            </Button>
            <Button
              onClick={() =>
                setSelection({
                  range: {
                    start: Math.min(playhead, selection.range?.start ?? playhead),
                    end: Math.max(playhead + 1, Math.min(playhead + 1, total)),
                  },
                })
              }
              title={`${t.markOut} (O)`}
            >
              O
            </Button>
          </>
        )}
        <Button
          variant="ghost"
          onClick={() => setSelection({ range: null })}
          disabled={!selection.range}
          title={t.clearSelection}
        >
          ✕
        </Button>

        <div className={styles.toolSpacer} />
        <span className={styles.zoomReadout}>
          {clips.length ? `${total} frames · ${(total / (project.fps || 30)).toFixed(2)}s` : t.timelineEmpty}
        </span>
      </div>

      <div className={styles.body} ref={bodyRef} onWheel={onWheel}>
        <canvas
          ref={canvasRef}
          className={styles.canvas}
          style={{ cursor }}
          onPointerDown={onCanvasPointerDown}
          onPointerMove={onCanvasMove}
          onPointerLeave={() => setHover(null)}
          onContextMenu={(event) => event.preventDefault()}
        />

        <div className={styles.lanes}>
          {snapGuide !== null ? (
            <div className={styles.snapGuide} style={{ left: frameToX(snapGuide, view) }} />
          ) : null}
          {selection.range ? (
            <div
              className={styles.selectionOverlay}
              style={{
                left: frameToX(Math.min(selection.range.start, selection.range.end), view),
                width: Math.max(
                  1,
                  frameToX(Math.max(selection.range.start, selection.range.end), view) -
                    frameToX(Math.min(selection.range.start, selection.range.end), view),
                ),
              }}
            />
          ) : null}
          {Array.from({ length: effectRows }).map((_, lane) => (
            <div
              className={clsx(styles.lane, lane % 2 === 1 && styles.laneAlt)}
              key={lane}
              style={{ height: LANE_H }}
            >
              <span className={styles.laneLabel}>{lane === 0 ? 'FX' : `FX ${lane + 1}`}</span>
            </div>
          ))}
          {project.effects
            .filter((effect) => effect.track < effectRows + 1)
            .map((effect) => (
              <EffectBlock
                key={effect.id}
                effect={effect}
                view={view}
                selected={selection.effectId === effect.id}
                snapTargets={snapTargets}
                onSnap={setSnapGuide}
              />
            ))}
        </div>
      </div>

      <div className={styles.overview}>
        <div
          className={styles.overviewTrack}
          onPointerDown={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const ratio = (event.clientX - rect.left) / rect.width;
            setUi({ scrollFrame: clampScroll(ratio * total - visibleFrames / 2) });
            startPointerDrag(event.nativeEvent, event.currentTarget, {
              onMove: ({ x }) => {
                const r = (x - rect.left) / rect.width;
                setUi({ scrollFrame: clampScroll(r * total - visibleFrames / 2) });
              },
            });
          }}
        >
          <div
            className={styles.overviewThumb}
            style={{
              left: `${(scrollFrame / total) * 100}%`,
              width: `${Math.min(100, (visibleFrames / total) * 100)}%`,
            }}
          />
        </div>
      </div>
    </div>
  );
}

function cloneCount(
  inFrame: number,
  outFrame: number,
  _startFrame: number,
  _speed: number,
  stepFrames: number,
): number {
  return Math.max(1, Math.ceil((outFrame - inFrame) / Math.max(1, stepFrames)));
}

/* ------------------------------------------------------------- effect block */

function EffectBlock({
  effect,
  view,
  selected,
  snapTargets,
  onSnap,
}: {
  effect: Effect;
  view: Viewport;
  selected: boolean;
  snapTargets: ReturnType<typeof collectSnapTargets>;
  /** Reports the frame the block snapped to, so the timeline can draw a guide. */
  onSnap: (frame: Frame | null) => void;
}) {
  const mutate = useEditor((s) => s.mutate);
  const setSelection = useEditor((s) => s.setSelection);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const setUi = useEditor((s) => s.setUi);
  const customPresets = useEditor((s) => s.customPresets);
  const moshName =
    presetById(effect.preset)?.label ??
    customPresets.find((p) => p.id === effect.preset)?.label ??
    'Datamosh';

  const startX = frameToX(effect.startFrame, view);
  const endX = frameToX(effect.endFrame, view);
  const width = Math.max(8, endX - startX);
  const isMosh = effect.type === 'datamosh';

  /**
   * The live effect, read from the store rather than from props. Props can be a
   * frame behind while a gesture is in flight, and a drag handler that reads a
   * stale range jumps back to where the block used to be.
   */
  const liveEffect = () =>
    useEditor.getState().project.effects.find((e) => e.id === effect.id) ?? effect;

  const makeSnap = (excludeStart: number, excludeEnd: number) => {
    // A block must never snap to itself, otherwise it refuses to move.
    const targets = snapTargets.filter(
      (t) => t.kind !== 'effect' || (t.frame !== excludeStart && t.frame !== excludeEnd),
    );
    return (value: number) => {
      const snapped = snapFrame(value, targets, view.pxPerFrame, 7).frame;
      onSnap(snapped !== value ? snapped : null);
      return snapped;
    };
  };

  const select = () => {
    setSelection({ effectId: effect.id, clipId: null });
    if (isMosh) setUi({ tool: 'datamosh' });
  };

  const onBodyDown = (event: React.PointerEvent<HTMLDivElement>) => {
    select();
    const current = liveEffect();
    // Captured once at gesture start; every position is derived from these, so a
    // long drag can never drift or accelerate.
    const originStart = current.startFrame;
    const length = Math.max(1, current.endFrame - current.startFrame);
    const snap = makeSnap(current.startFrame, current.endFrame);
    const target = event.currentTarget;
    const touching = event.nativeEvent.pointerType !== 'mouse';
    startPointerDrag(event.nativeEvent, target, {
      onMove: ({ dx }) => {
        const frames = Math.round(dx / view.pxPerFrame);
        const start = Math.max(0, snap(originStart + frames));
        mutate(
          'Move effect',
          (draft) => ops.setEffectRange(draft, effect.id, start, start + length),
          `fx-move-${effect.id}`,
        );
      },
      onEnd: ({ dx, dy }) => {
        onSnap(null);
        // A touch *tap* on a block asks for its settings; a drag does not, or
        // the sheet would jump up over the timeline mid-gesture.
        if (touching && isMosh && Math.abs(dx) < 5 && Math.abs(dy) < 5) {
          setUi({ sheet: 'datamosh', sheetPeek: false });
        }
      },
    });
  };

  const onLeftHandle = (event: React.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    select();
    const current = liveEffect();
    const originStart = current.startFrame;
    const snap = makeSnap(current.startFrame, current.endFrame);
    const target = event.currentTarget;
    startPointerDrag(event.nativeEvent, target, {
      onMove: ({ dx }) => {
        const frames = Math.round(dx / view.pxPerFrame);
        const frame = snap(originStart + frames);
        mutate('Resize effect', (draft) => ops.resizeEffectStart(draft, effect.id, frame), `fx-start-${effect.id}`);
      },
      onEnd: () => onSnap(null),
    });
  };

  const onRightHandle = (event: React.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    select();
    const current = liveEffect();
    const originEnd = current.endFrame;
    const snap = makeSnap(current.startFrame, current.endFrame);
    const target = event.currentTarget;
    startPointerDrag(event.nativeEvent, target, {
      onMove: ({ dx }) => {
        const frames = Math.round(dx / view.pxPerFrame);
        const frame = snap(originEnd + frames);
        mutate('Resize effect', (draft) => ops.resizeEffectEnd(draft, effect.id, frame), `fx-end-${effect.id}`);
      },
      onEnd: () => onSnap(null),
    });
  };

  // A datamosh block is named by its preset, not by the raw id: "Monster
  // Attack" is what the user picked and what they need to recognise on a lane.
  const label = isMosh ? moshName : effectLabel(effect.type).toUpperCase();
  const longEnough = width > 96;

  return (
    <div
      className={clsx(
        styles.block,
        isMosh ? styles.blockMosh : styles.blockFx,
        selected && styles.blockSelected,
        !effect.enabled && styles.blockDisabled,
      )}
      style={{ left: startX, width, top: effect.track * LANE_H + 2 }}
      onPointerDown={onBodyDown}
      onDoubleClick={() => setPlayhead(effect.startFrame)}
      title={`${isMosh ? moshName : effectLabel(effect.type)} · ${formatTimecode(effect.startFrame, 30)} → ${formatTimecode(effect.endFrame, 30)} (${effect.endFrame - effect.startFrame} frames)`}
    >
      <div className={styles.handleLeft} onPointerDown={onLeftHandle} />
      <div className={styles.blockLabel}>
        <span className={styles.blockGlyph}>{effectGlyph(effect.type)}</span>
        {longEnough ? <span className={styles.blockText}>{label}</span> : null}
        {width > 190 ? (
          <span className={styles.blockMeta}>
            {effect.endFrame - effect.startFrame}f
            {effect.keyframes.length ? ' · ◆' : ''}
          </span>
        ) : null}
      </div>
      <div className={styles.handleRight} onPointerDown={onRightHandle} />
    </div>
  );
}

export { CANVAS_H, LANE_H };
