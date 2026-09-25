/** Top bar: project identity plus the global actions. */

import { useRef } from 'react';
import clsx from 'clsx';
import styles from './app.module.css';
import { useEditor } from '../state/store';
import { Button } from '../ui/primitives';
import { t } from '../i18n/strings';
import { downloadProject, deserializeProject, loadAutosave } from '../engine/project/storage';
import { errorDetail, errorMessage } from '../engine/errors';
import { log } from '../engine/log';
import { importVideoFile } from '../features/media/importMedia';
import { acceptAttribute } from '../features/media/importMedia';

export function TopBar({ onOpenProjectPanel }: { onOpenProjectPanel: () => void }) {
  const project = useEditor((s) => s.project);
  const past = useEditor((s) => s.past.length);
  const future = useEditor((s) => s.future.length);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const setUi = useEditor((s) => s.setUi);
  const leftCollapsed = useEditor((s) => s.ui.leftCollapsed);
  const rightCollapsed = useEditor((s) => s.ui.rightCollapsed);
  const setStatus = useEditor((s) => s.setStatus);
  const addMedia = useEditor((s) => s.addMedia);
  const replaceProject = useEditor((s) => s.replaceProject);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const projectInputRef = useRef<HTMLInputElement | null>(null);

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const file = files[0]!;
    try {
      const result = await importVideoFile(file);
      addMedia(result.asset, file);
      setStatus({ kind: 'success', message: `Đã nhập ${result.asset.name}`, at: Date.now() });
    } catch (error) {
      log.error('import', 'Import failed', error);
      setStatus({
        kind: 'error',
        message: errorMessage(error),
        detail: `${errorDetail(error) ?? ''}\n\n${log.asText()}`,
        at: Date.now(),
      });
    }
  };

  const onProjectFile = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const loaded = deserializeProject(text);
      replaceProject(loaded);
      setStatus({
        kind: 'success',
        message: `Đã tải ${loaded.name}`,
        detail:
          loaded.media.length > 0
            ? 'Chọn lại video nguồn để tiếp tục: file project không chứa dữ liệu video.'
            : undefined,
        at: Date.now(),
      });
      onOpenProjectPanel();
    } catch (error) {
      setStatus({
        kind: 'error',
        message: errorMessage(error),
        detail: errorDetail(error),
        at: Date.now(),
      });
    }
  };

  return (
    <header className={styles.topbar}>
      {/* Brand */}
      <div className={styles.brand}>
        <span className={styles.brandMark}>📺</span>
        <span className={styles.brandName}>FZtechnology</span>
      </div>

      {/* Media import */}
      <Button onClick={() => inputRef.current?.click()} title="Nhập file video (Ctrl+O)">
        📥 {t.import}
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept={acceptAttribute()}
        className={styles.hidden}
        onChange={(event) => void onFiles(event.target.files)}
      />

      <div className={styles.topbarSep} />

      {/* History */}
      <Button
        onClick={undo}
        disabled={past === 0}
        title={`${t.undo} (Ctrl+Z)`}
        variant="ghost"
      >
        ↩ Undo
      </Button>
      <Button
        onClick={redo}
        disabled={future === 0}
        title={`${t.redo} (Ctrl+Shift+Z)`}
        variant="ghost"
      >
        ↪ Redo
      </Button>

      <div className={styles.topbarSep} />

      {/* Project file actions */}
      <Button
        onClick={() => {
          downloadProject(project);
          setStatus({ kind: 'success', message: t.saved, at: Date.now() });
        }}
        title={`${t.save} (Ctrl+S)`}
        variant="ghost"
      >
        💾 {t.save}
      </Button>
      <Button onClick={() => projectInputRef.current?.click()} title={t.load} variant="ghost">
        📂 {t.load}
      </Button>
      <input
        ref={projectInputRef}
        type="file"
        accept=".json,.moshproj,application/json"
        className={styles.hidden}
        onChange={(event) => void onProjectFile(event.target.files)}
      />
      <Button
        variant="ghost"
        onClick={async () => {
          const autosaved = await loadAutosave();
          if (autosaved) {
            replaceProject(autosaved);
            setStatus({ kind: 'success', message: 'Đã khôi phục autosave', at: Date.now() });
          } else {
            setStatus({ kind: 'info', message: 'Không tìm thấy autosave', at: Date.now() });
          }
        }}
        title="Khôi phục lần lưu tự động gần nhất"
      >
        🔄 Autosave
      </Button>
      <Button
        variant="ghost"
        onClick={() => {
          if (!project.clips.length && !project.effects.length) {
            useEditor.getState().newProject();
            return;
          }
          if (window.confirm(t.newProjectConfirm)) {
            useEditor.getState().newProject();
          }
        }}
        title={t.newProject}
      >
        ✨ {t.newProject}
      </Button>

      <div className={styles.topbarSep} />

      {/* Layout toggles */}
      <Button
        variant="ghost"
        className={clsx(leftCollapsed && styles.toggleActive)}
        onClick={() => setUi({ leftCollapsed: !leftCollapsed })}
        title={leftCollapsed ? t.showToolColumn : t.hideToolColumn}
      >
        ◧
      </Button>
      <Button
        variant="ghost"
        className={clsx(rightCollapsed && styles.toggleActive)}
        onClick={() => setUi({ rightCollapsed: !rightCollapsed })}
        title={rightCollapsed ? t.showInspector : t.hideInspector}
      >
        ◨
      </Button>

      <div className={styles.spacer} />

      {/* Project meta + export */}
      <span className={styles.projectName} title={project.name}>
        {project.name} · {project.fps} fps
      </span>
      <Button variant="primary" onClick={() => setUi({ exportOpen: true })}>
        🚀 {t.exportTitle}
      </Button>
    </header>
  );
}
