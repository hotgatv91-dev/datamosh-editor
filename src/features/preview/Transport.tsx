/** Transport bar: play/pause/stop, frame stepping, time readout, preview modes. */

import clsx from 'clsx';
import styles from './preview.module.css';
import { useEditor } from '../../state/store';
import { formatTimecode } from '../../engine/timeline/math';
import { effectById } from '../../engine/timeline/derive';
import { t } from '../../i18n/strings';

export function Transport({ compact }: { compact?: boolean }) {
  const project = useEditor((s) => s.project);
  const playhead = useEditor((s) => s.playhead);
  const playing = useEditor((s) => s.ui.playing);
  const previewMode = useEditor((s) => s.ui.previewMode);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const setUi = useEditor((s) => s.setUi);
  const duration = useEditor((s) => s.duration);
  const selection = useEditor((s) => s.selection);
  const selectedEffect = effectById(project, selection.effectId);

  const fps = project.fps || 30;
  const total = duration();
  const hasVideo = project.clips.length > 0;

  const step = (delta: number) => {
    setUi({ playing: false });
    setPlayhead(playhead + delta);
  };

  const rangeLabel = selection.range
    ? `${formatTimecode(selection.range.start, fps)} – ${formatTimecode(selection.range.end, fps)}`
    : null;

  return (
    <div className={styles.transport}>
      <button
        type="button"
        className={clsx(styles.tButton, styles.tPlay)}
        onClick={() => setUi({ playing: !playing })}
        disabled={!hasVideo}
        title={playing ? t.pause : t.play}
      >
        {playing ? '❚❚' : '▶'}
      </button>
      <button
        type="button"
        className={styles.tButton}
        onClick={() => {
          setUi({ playing: false });
          setPlayhead(0);
        }}
        disabled={!hasVideo}
        title={t.stop}
      >
        ■
      </button>
      <button
        type="button"
        className={styles.tButton}
        onClick={() => step(-1)}
        disabled={!hasVideo}
        title={`${t.prevFrame} (←)`}
      >
        ◀
      </button>
      <button
        type="button"
        className={styles.tButton}
        onClick={() => step(1)}
        disabled={!hasVideo}
        title={`${t.nextFrame} (→)`}
      >
        ▶
      </button>

      <div className={styles.tSep} />

      <span className={styles.tTime}>
        {formatTimecode(playhead, fps)} / {formatTimecode(Math.max(0, total), fps)}
      </span>
      <span className={styles.tFrame}>
        {t.frame} {playhead}
      </span>

      {!compact ? (
        <>
          <div className={styles.tSep} />
          <div className={styles.tModes}>
            {(['original', 'effect', 'split'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={clsx(styles.tMode, previewMode === mode && styles.tModeActive)}
                onClick={() => setUi({ previewMode: mode })}
              >
                {mode === 'original' ? t.original : mode === 'effect' ? t.effect : t.split}
              </button>
            ))}
          </div>
        </>
      ) : null}

      <div className={styles.tSpacer} />

      {selectedEffect ? (
        <span className={styles.tFrame} title={selectedEffect.preset ?? selectedEffect.type}>
          {selectedEffect.type === 'datamosh' ? '⚡ ' : ''}
          {selectedEffect.preset ?? selectedEffect.type}
        </span>
      ) : rangeLabel ? (
        <span className={styles.tFrame}>IN/OUT {rangeLabel}</span>
      ) : null}
    </div>
  );
}
