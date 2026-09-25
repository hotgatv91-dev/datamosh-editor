/**
 * Media panel: import (file picker on Android, drag & drop on desktop), the
 * imported asset list with metadata, and the empty state.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import styles from '../inspector/inspector.module.css';
import { useEditor } from '../../state/store';
import { Button, Panel } from '../../ui/primitives';
import { acceptAttribute, importVideoFile } from './importMedia';
import { formatBytes, formatFps, formatResolution, t } from '../../i18n/strings';
import { errorDetail, errorMessage } from '../../engine/errors';
import { log } from '../../engine/log';
import { frameSourceRegistry } from '../../engine/frames';
import { mediaInfoFromAsset } from '../../engine/frames/types';
import { assetById } from '../../engine/timeline/derive';

export function MediaPanel() {
  const project = useEditor((s) => s.project);
  const mediaFiles = useEditor((s) => s.mediaFiles);
  const addMedia = useEditor((s) => s.addMedia);
  const setStatus = useEditor((s) => s.setStatus);
  const setUi = useEditor((s) => s.setUi);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [sourceRevision, setSourceRevision] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Open decoders right after import so the first preview frame is immediate
  // and the capability badge below tells the truth.
  useEffect(() => {
    let cancelled = false;
    const missing = project.media.filter((asset) => !frameSourceRegistry.get(asset.id));
    if (!missing.length) return;
    void (async () => {
      for (const asset of missing) {
        const file = mediaFiles[asset.id];
        if (!file) continue;
        try {
          await frameSourceRegistry.ensure(asset.id, file, mediaInfoFromAsset(asset));
        } catch (error) {
          log.warn('media', `Could not open a frame source for ${asset.name}`, error);
        }
        if (cancelled) return;
        setSourceRevision((value) => value + 1);
        useEditor.getState().setUi({ sourceEpoch: useEditor.getState().ui.sourceEpoch + 1 });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project.media, mediaFiles]);

  void sourceRevision;

  const handleFiles = useCallback(
    async (files: FileList | File[] | null) => {
      if (!files || !files.length) return;
      setBusy(true);
      const warnings: string[] = [];
      for (const file of Array.from(files)) {
        try {
          const result = await importVideoFile(file);
          const clipId = addMedia(result.asset, file);
          warnings.push(...result.warnings);
          if (clipId) setUi({ tool: 'edit', pendingApply: false });
          setStatus({
            kind: 'success',
            message: `Imported ${result.asset.name}`,
            detail: warnings.length ? warnings.join('\n') : undefined,
            at: Date.now(),
          });
        } catch (error) {
          log.error('import', `Import failed for ${file.name}`, error);
          setStatus({
            kind: 'error',
            message: errorMessage(error),
            detail: `${errorDetail(error) ?? ''}\nfile: ${file.name}\nsize: ${formatBytes(file.size)}\n\n${log.asText()}`,
            at: Date.now(),
          });
        }
      }
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    },
    [addMedia, setStatus, setUi],
  );

  const hasMedia = project.media.length > 0;

  return (
    <div className={styles.inspector}>
      <div className={styles.head}>
        <span className={styles.headTitle}>{t.media}</span>
        <Button variant="ghost" onClick={() => inputRef.current?.click()} disabled={busy}>
          {t.import}
        </Button>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={acceptAttribute()}
        className={styles.fileInput}
        onChange={(event) => void handleFiles(event.target.files)}
      />

      {!hasMedia ? (
        <div
          className={clsx(styles.dropZone, dragOver && styles.dropZoneActive)}
          onDragOver={(event) => {
            event.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragOver(false);
            void handleFiles(event.dataTransfer.files);
          }}
          onClick={() => inputRef.current?.click()}
        >
          <div className={styles.dropPlus}>{busy ? '…' : '+'}</div>
          <div className={styles.dropTitle}>{t.importVideo}</div>
          <div className={styles.dropHint}>{t.dropHereOr}</div>
          <div className={styles.dropFormats}>MP4 · MOV · WebM</div>
        </div>
      ) : (
        <div
          className={clsx(styles.dropZoneCompact, dragOver && styles.dropZoneActive)}
          onDragOver={(event) => {
            event.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragOver(false);
            void handleFiles(event.dataTransfer.files);
          }}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? 'Importing…' : '+ Drop another video or click to browse'}
        </div>
      )}

      {hasMedia ? (
        <Panel title={`${t.mediaQueue} (${project.media.length})`}>
          {project.media.map((asset) => {
            const loaded = !!mediaFiles[asset.id];
            const source = frameSourceRegistry.get(asset.id);
            return (
              <div key={asset.id} className={styles.mediaItem}>
                <div className={styles.mediaName} title={asset.name}>
                  {asset.name}
                </div>
                <div className={styles.mediaMeta}>
                  {formatResolution(asset.width, asset.height)} · {formatFps(asset.fps)} ·{' '}
                  {(asset.durationFrames / asset.fps).toFixed(2)}s · {formatBytes(asset.sizeBytes)}
                </div>
                <div className={styles.mediaTags}>
                  <span className={styles.tag}>{asset.container}</span>
                  <span className={styles.tag}>{asset.videoCodec || 'unknown'}</span>
                  {asset.hasAudio ? <span className={styles.tag}>audio</span> : null}
                  <span className={clsx(styles.tag, source?.frameAccurate ? styles.tagOk : styles.tagWarn)}>
                    {source ? (source.frameAccurate ? 'frame accurate' : 'seek decode') : 'not loaded'}
                  </span>
                  {loaded || source ? null : <span className={styles.tagWarn}>{t.relinkNeeded}</span>}
                </div>
              </div>
            );
          })}
        </Panel>
      ) : null}

      {project.clips.length ? (
        <Panel title="Timeline">
          {project.clips.map((clip) => {
            const asset = assetById(project, clip.mediaId);
            return (
              <div key={clip.id} className={styles.mediaMeta}>
                {asset?.name} · in {clip.inFrame} / out {clip.outFrame} · start {clip.startFrame} ·{' '}
                {clip.speed}×
              </div>
            );
          })}
        </Panel>
      ) : null}
    </div>
  );
}
