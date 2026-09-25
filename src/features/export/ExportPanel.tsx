/**
 * Export panel: resolution / fps / format, the pipeline choice, the four
 * progress phases and the download button.
 */

import { useMemo, useState } from 'react';
import clsx from 'clsx';
import styles from '../inspector/inspector.module.css';
import { useEditor } from '../../state/store';
import { SelectField, Button, ProgressBar } from '../../ui/primitives';
import { t } from '../../i18n/strings';
import { runExport, buildExportPlan, targetDimensions } from '../../engine/export/pipeline';
import { createFrameRenderContext } from '../../engine/export/frameRenderer';
import { isCrossOriginIsolated, isLikelyLowEndDevice } from '../../engine/export/ffmpegClient';
import { errorDetail, errorMessage } from '../../engine/errors';
import { log } from '../../engine/log';

const phaseLabel: Record<string, string> = {
  preparing: t.preparing,
  processing: t.processing,
  encoding: t.encoding,
  complete: t.complete,
  failed: 'Failed',
};

export function ExportPanel() {
  const project = useEditor((s) => s.project);
  const mediaFiles = useEditor((s) => s.mediaFiles);
  const progress = useEditor((s) => s.ui.exportProgress);
  const resultUrl = useEditor((s) => s.ui.exportResultUrl);
  const setExportProgress = useEditor((s) => s.setExportProgress);
  const setExportResult = useEditor((s) => s.setExportResult);
  const setStatus = useEditor((s) => s.setStatus);
  const mutate = useEditor((s) => s.mutate);
  const [busy, setBusy] = useState(false);

  const plan = useMemo(() => buildExportPlan(project), [project]);
  const hasDatamosh = project.effects.some((e) => e.type === 'datamosh' && e.enabled);
  const isolation = isCrossOriginIsolated();
  const lowEnd = isLikelyLowEndDevice();

  const update = (patch: Partial<typeof project.exportSettings>) =>
    mutate('Export settings', (draft) => {
      draft.exportSettings = { ...draft.exportSettings, ...patch };
    });

  const startExport = async () => {
    const file = project.media[0] ? mediaFiles[project.media[0].id] : null;
    if (!file) {
      setStatus({
        kind: 'error',
        message: t.relinkNeeded,
        at: Date.now(),
      });
      return;
    }
    setBusy(true);
    setExportResult(null);
    setExportProgress({ stage: 'preparing', percent: 0, message: 'Reading source…' });
    let renderContext: Awaited<ReturnType<typeof createFrameRenderContext>> | null = null;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { width, height } = targetDimensions(
        project.media[0]!.width,
        project.media[0]!.height,
        project.exportSettings.resolution,
      );

      const pipeline = hasDatamosh
        ? project.effects.some((e) => e.type === 'datamosh' && e.enabled && e.renderMode === 'preview-quality')
          ? 'preview-quality'
          : 'bitstream'
        : 'preview-quality';

      if (pipeline === 'preview-quality') {
        renderContext = await createFrameRenderContext(project, mediaFiles, width, height);
      }

      const result = await runExport(project, bytes, {
        resolution: project.exportSettings.resolution,
        fps: project.exportSettings.fps,
        format: project.exportSettings.format,
        pipeline,
        renderFrames: renderContext ? (start, count) => renderContext!.render(start, count) : undefined,
        onProgress: ({ stage, percent, message }) => setExportProgress({ stage, percent, message }),
      });

      const url = URL.createObjectURL(result.blob);
      setExportResult(url);
      setExportProgress({
        stage: 'complete',
        percent: 100,
        message: `${(result.blob.size / 1024 ** 2).toFixed(1)} MB · ${
          result.method === 'bitstream-surgery' ? 'bitstream datamosh' : 'rendered frames'
        }`,
      });
      if (result.warnings.length) {
        setStatus({ kind: 'info', message: result.warnings[0]!, at: Date.now() });
      }
      log.info('export', `Export complete: ${result.method}, ${result.blob.size} bytes`);
    } catch (error) {
      log.error('export', 'Export failed', error);
      setExportProgress({ stage: 'failed', percent: 0, message: errorMessage(error) });
      setStatus({
        kind: 'error',
        message: t.processingMessage,
        detail: `${errorMessage(error)}\n${errorDetail(error) ?? ''}\n${log.asText()}`,
        at: Date.now(),
      });
    } finally {
      renderContext?.dispose();
      setBusy(false);
    }
  };

  const percent = progress?.percent ?? 0;

  return (
    <div>
      <SelectField
        label={t.resolution}
        value={project.exportSettings.resolution}
        options={[
          { value: 'original', label: t.originalOption },
          { value: '720', label: '720p' },
          { value: '1080', label: '1080p' },
        ]}
        onChange={(value) => update({ resolution: value as 'original' | '720' | '1080' })}
      />
      <SelectField
        label={t.fpsLabel}
        value={String(project.exportSettings.fps)}
        options={[
          { value: 'original', label: t.originalOption },
          { value: '24', label: '24' },
          { value: '30', label: '30' },
          { value: '60', label: '60' },
        ]}
        onChange={(value) =>
          update({ fps: value === 'original' ? 'original' : (Number(value) as 24 | 30 | 60) })
        }
      />
      <SelectField
        label={t.format}
        value={project.exportSettings.format}
        options={[
          { value: 'mp4', label: 'MP4' },
          { value: 'webm', label: 'WebM' },
        ]}
        onChange={(value) => update({ format: value as 'mp4' | 'webm' })}
      />

      <div className={styles.exportNote}>
        {hasDatamosh
          ? project.effects.some((e) => e.type === 'datamosh' && e.enabled && e.renderMode === 'bitstream')
            ? t.pipelineBitstreamHint
            : t.pipelineRenderHint
          : 'No datamosh region — the export bakes the edited frames.'}
      </div>
      <div className={styles.exportNote}>
        {plan.moshSegments.length
          ? `${plan.moshSegments.length} datamosh region(s) · ${plan.frameDuration} frames`
          : `${plan.frameDuration} frames`}
        {isolation ? ' · isolated context (faster)' : ' · single-threaded encoder'}
        {lowEnd ? ' · low-power device detected' : ''}
        {/* Say out loud whether the sound made it in — silence is a bug, not a preference. */}
        {plan.hasAudio ? ' · có tiếng' : ' · không kèm tiếng'}
      </div>
      {plan.warnings.map((warning) => (
        <div key={warning} className={styles.exportWarn}>
          {warning}
        </div>
      ))}

      {progress ? (
        <div className={styles.exportProgress}>
          <div className={styles.exportStage}>
            <span className={clsx(styles.exportStageLabel, progress.stage === 'failed' && styles.exportStageFailed)}>
              {phaseLabel[progress.stage] ?? progress.stage}
            </span>
            <span className={styles.exportPercent}>{Math.round(percent)}%</span>
          </div>
          <ProgressBar percent={percent} variant="mosh" />
          <div className={styles.exportMessage}>{progress.message}</div>
        </div>
      ) : null}

      <div className={styles.actions}>
        <Button variant="mosh" onClick={() => void startExport()} disabled={busy || !project.clips.length}>
          {busy ? 'Exporting…' : t.exportTitle}
        </Button>
        {resultUrl ? (
          <a className={styles.download} href={resultUrl} download={`datamosh-export.${project.exportSettings.format}`}>
            {t.downloadVideo}
          </a>
        ) : null}
      </div>
      {!project.clips.length && <div className={styles.exportWarn}>{t.timelineEmpty}</div>}
      <div className={styles.hint}>
        Export lần đầu cần tải encoder (~25 MB). Không có gì được gửi lên máy chủ: toàn bộ xử lý chạy
        trên máy bạn. Tiếng gốc được giữ nguyên; vùng datamosh làm méo tiếng theo đúng nhịp của nó.
      </div>
      <div className={styles.hint}>
        <button
          type="button"
          className={styles.linkBtn}
          onClick={() => {
            // Exercises the AVI surgery path without leaving the app.
            log.info('export', 'diagnostics', {
              plan,
              effects: project.effects.map((e) => ({
                id: e.id,
                type: e.type,
                range: `${e.startFrame}–${e.endFrame}`,
                preset: e.preset,
                renderMode: e.renderMode,
                frames: e.endFrame - e.startFrame,
              })),
            });
            setStatus({ kind: 'info', message: 'Diagnostics written to the log', detail: log.asText(), at: Date.now() });
          }}
        >
          Diagnose export plan
        </button>
      </div>
    </div>
  );
}
