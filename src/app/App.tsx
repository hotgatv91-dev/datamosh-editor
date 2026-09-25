/**
 * App shell.
 *
 * Desktop: toolbar | preview | inspector, with the timeline getting real estate
 * underneath. Mobile: preview on top, timeline in the middle, a bottom tool bar
 * whose Datamosh entry opens a bottom sheet — a genuine mobile layout, not a
 * shrunken desktop.
 */

import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import styles from './app.module.css';
import { useEditor } from '../state/store';
import { TopBar } from './TopBar';
import { StatusBar } from './StatusBar';
import { ErrorBoundary } from './ErrorBoundary';
import { ToolBar, ToolPanel } from '../features/toolbar/ToolPanels';
import { PreviewSurface } from '../features/preview/PreviewSurface';
import { Transport } from '../features/preview/Transport';
import { Timeline } from '../features/timeline/Timeline';
import { Inspector } from '../features/inspector/Inspector';
import { ExportPanel } from '../features/export/ExportPanel';
import { Button, Modal } from '../ui/primitives';
import { t } from '../i18n/strings';
import { useKeyboardShortcuts } from '../hooks/useKeyboard';
import { startPointerDrag } from '../features/timeline/drag';

const TOOL_TITLES: Record<string, string> = {
  media: t.media,
  edit: t.edit,
  effects: t.effects,
  datamosh: t.datamosh,
  speed: t.speed,
  adjust: t.adjust,
  audio: t.audio,
};
import { useIsMobile } from '../hooks/useMediaQuery';
import { saveAutosave } from '../engine/project/storage';
import { importVideoFile } from '../features/media/importMedia';
import { errorDetail, errorMessage } from '../engine/errors';
import { log } from '../engine/log';
import { frameSourceRegistry } from '../engine/frames';

export function App() {
  return (
    <ErrorBoundary>
      <AppShell />
    </ErrorBoundary>
  );
}

/**
 * Drag handle between the preview and the timeline.
 *
 * The timeline no longer reserves a fixed slice of the window, so the way to
 * trade space between "watch it" and "edit it" is to grab this.
 */
function TimelineDivider() {
  const setUi = useEditor((s) => s.setUi);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const column = event.currentTarget.parentElement;
    if (!column) return;
    // Measure rather than guess: the column may be content-sized right now.
    const startHeight = column.getBoundingClientRect().height;
    const max = Math.round(window.innerHeight * 0.5);
    startPointerDrag(event.nativeEvent, event.currentTarget, {
      onMove: ({ dy }) =>
        setUi({ timelineHeight: Math.max(120, Math.min(max, Math.round(startHeight - dy))) }),
    });
  };

  return (
    <div
      className={styles.divider}
      onPointerDown={onPointerDown}
      onDoubleClick={() => setUi({ timelineHeight: 0 })}
      title={t.resizeTimeline}
    />
  );
}

function AppShell() {
  const isMobile = useIsMobile();
  const setUi = useEditor((s) => s.setUi);
  const exportOpen = useEditor((s) => s.ui.exportOpen);
  const timelineHeight = useEditor((s) => s.ui.timelineHeight);
  const leftCollapsed = useEditor((s) => s.ui.leftCollapsed);
  const rightCollapsed = useEditor((s) => s.ui.rightCollapsed);
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);

  useKeyboardShortcuts();

  /* ---------------------------------------------------------- autosave */
  const revision = useEditor((s) => s.revision);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void saveAutosave(useEditor.getState().project);
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [revision]);

  /* --------------------------------------------- release decoders on unload */
  useEffect(() => {
    const onUnload = () => frameSourceRegistry.disposeAll();
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, []);

  /* ------------------------------------------------ window-wide drag & drop */
  useEffect(() => {
    const onDragEnter = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      dragDepth.current += 1;
      setDragOver(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    };
    const onDragLeave = () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragOver(false);
    };
    const onDrop = async (event: DragEvent) => {
      event.preventDefault();
      dragDepth.current = 0;
      setDragOver(false);
      const files = event.dataTransfer?.files;
      if (!files?.length) return;
      const file = files[0]!;
      try {
        const result = await importVideoFile(file);
        useEditor.getState().addMedia(result.asset, file);
        useEditor.getState().setStatus({
          kind: 'success',
          message: `Imported ${result.asset.name}`,
          at: Date.now(),
        });
      } catch (error) {
        log.error('import', 'Drop import failed', error);
        useEditor.getState().setStatus({
          kind: 'error',
          message: errorMessage(error),
          detail: errorDetail(error),
          at: Date.now(),
        });
      }
    };
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  return (
    <div
      className={clsx(
        styles.app,
        isMobile && styles.mobile,
        timelineHeight > 0 && styles.appResized,
      )}
      style={
        {
          ...(timelineHeight ? { '--tl-height': `${timelineHeight}px` } : {}),
          // Collapsing the tool column keeps the icon rail and drops the panel,
          // so the width goes to the preview instead of disappearing entirely.
          ...(leftCollapsed ? { '--w-toolbar': '46px' } : {}),
          ...(rightCollapsed ? { '--w-inspector': '0px' } : {}),
        } as React.CSSProperties
      }
    >
      <TopBar onOpenProjectPanel={() => setUi({ sheet: 'project' })} />

      {isMobile ? (
        <>
          <div className={styles.mobileStage}>
            <PreviewSurface />
          </div>
          <Transport compact />
          <div className={styles.mobileTimeline}>
            <Timeline />
            <ToolBar vertical={false} />
          </div>
          <MobileSheet />
        </>
      ) : (
        <>
          <div className={styles.body}>
            <div className={styles.toolbarCol}>
              <ToolBar />
              {leftCollapsed ? null : <ToolPanel />}
            </div>
            <div className={styles.previewCol}>
              <PreviewSurface />
            </div>
            {rightCollapsed ? null : (
              <div className={styles.inspectorCol}>
                <Inspector />
              </div>
            )}
          </div>
          <Transport />
          <div className={styles.timelineCol}>
            <TimelineDivider />
            <Timeline />
          </div>
        </>
      )}

      <StatusBar />

      {exportOpen ? (
        <Modal title={t.exportTitle} onClose={() => setUi({ exportOpen: false })}>
          <ExportPanel />
        </Modal>
      ) : null}

      {dragOver ? (
        <div className={styles.dropOverlay}>
          <div className={styles.dropOverlayBox}>
            <div className={styles.dropOverlayPlus}>+</div>
            <div>{t.dropHere}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Bottom sheet: the tool panel or the inspector, on small screens. */
function MobileSheet() {
  const sheet = useEditor((s) => s.ui.sheet);
  const tool = useEditor((s) => s.ui.tool);
  const peek = useEditor((s) => s.ui.sheetPeek);
  const selection = useEditor((s) => s.selection);
  const setUi = useEditor((s) => s.setUi);
  // Read for the folded header only: it keeps the block's range in view while
  // the sheet is out of the way, so the user knows what they are dragging.
  const effect = useEditor((s) =>
    selection.effectId ? s.project.effects.find((e) => e.id === selection.effectId) ?? null : null,
  );

  const open = sheet !== null && sheet === tool;
  /*
   * Two intents, two bodies. Tapping ⚡ Datamosh in the tab bar means "add a
   * mosh", so it gets the tool panel with the preset grid — it used to show the
   * inspector of whatever clip happened to be selected, which looked like the
   * wrong panel entirely. Opening the sheet for a datamosh block means "edit
   * this block", and that is the inspector.
   */
  const showsInspector = sheet === 'datamosh' && selection.effectId !== null;

  useEffect(() => {
    // A datamosh block getting selected with the sheet closed opens its
    // settings. A folded sheet is left alone: folding is how the timeline is
    // reached, and re-opening on every selection would fight the user.
    if (tool === 'datamosh' && selection.effectId && sheet === null) {
      setUi({ sheet: 'datamosh', sheetPeek: false });
    }
  }, [tool, selection.effectId, sheet, setUi]);

  if (!open) return null;

  const title = sheet === 'datamosh' ? `⚡ ${t.datamosh}` : TOOL_TITLES[tool];

  return (
    <>
      <div className={styles.scrim} onClick={() => setUi({ sheet: null })} />
      <div className={clsx(styles.sheet, peek && styles.sheetPeek)}>
        <div
          className={styles.sheetGrip}
          title={peek ? 'Mở rộng bảng' : 'Thu gọn để chỉnh block trên timeline'}
          onPointerDown={(event) => {
            // Flick the sheet down to get the timeline back, up for settings —
            // the gesture every phone sheet has.
            startPointerDrag(event.nativeEvent, event.currentTarget, {
              onMove: ({ dy }) => {
                if (dy > 30 && !peek) setUi({ sheetPeek: true });
                else if (dy < -30 && peek) setUi({ sheetPeek: false });
              },
            });
          }}
        />
        <div className={styles.sheetHead}>
          <span className={styles.sheetTitle}>{title}</span>
          {peek && effect ? (
            <span className={styles.sheetMeta}>
              {effect.startFrame} → {effect.endFrame}f
            </span>
          ) : null}
          <div className={styles.sheetSpacer} />
          <Button
            variant="ghost"
            onClick={() => setUi({ sheetPeek: !peek })}
            title={peek ? 'Mở rộng thiết lập' : 'Thu gọn để chỉnh block trên timeline'}
          >
            {peek ? '⌃' : '⌄'}
          </Button>
          <Button variant="ghost" onClick={() => setUi({ sheet: null })}>
            {t.close}
          </Button>
        </div>
        {peek ? null : (
          <div className={styles.sheetBody}>
            {showsInspector ? <Inspector /> : <ToolPanel />}
          </div>
        )}
      </div>
    </>
  );
}
