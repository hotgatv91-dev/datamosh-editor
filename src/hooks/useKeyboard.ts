/**
 * Keyboard shortcuts (PC).
 *
 * Space          play / pause
 * ← / →          previous / next frame
 * I / O          mark in / out (defines the region a new effect will use)
 * S              split at playhead
 * Delete         delete the selected clip or effect
 * Ctrl+Z         undo
 * Ctrl+Shift+Z   redo
 * Ctrl+S         save project
 */

import { useEffect } from 'react';
import { useEditor } from '../state/store';
import { downloadProject, saveAutosave } from '../engine/project/storage';
import * as ops from '../engine/timeline/ops';
import { clipsSorted } from '../engine/timeline/derive';

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  const tag = element.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    element.isContentEditable === true
  );
}

export function useKeyboardShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      const state = useEditor.getState();
      const modifier = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();

      if (modifier && key === 'z') {
        event.preventDefault();
        if (event.shiftKey) state.redo();
        else state.undo();
        return;
      }
      if (modifier && key === 'y') {
        event.preventDefault();
        state.redo();
        return;
      }
      if (modifier && key === 's') {
        event.preventDefault();
        void saveAutosave(state.project);
        downloadProject(state.project);
        state.setStatus({ kind: 'success', message: 'Project saved', at: Date.now() });
        return;
      }
      if (modifier && key === 'd') {
        event.preventDefault();
        if (state.selection.effectId) {
          state.mutate('Duplicate effect', (draft) =>
            ops.duplicateEffect(draft, state.selection.effectId!),
          );
        }
        return;
      }

      switch (event.key) {
        case ' ':
        case 'Spacebar':
          event.preventDefault();
          state.setUi({ playing: !state.ui.playing });
          return;
        case 'ArrowLeft':
          event.preventDefault();
          state.setUi({ playing: false });
          state.setPlayhead(state.playhead - 1);
          return;
        case 'ArrowRight':
          event.preventDefault();
          state.setUi({ playing: false });
          state.setPlayhead(state.playhead + 1);
          return;
        case 'Delete':
        case 'Backspace':
          event.preventDefault();
          if (state.selection.effectId) {
            state.mutate('Delete effect', (draft) => ops.deleteEffect(draft, state.selection.effectId!));
            state.setSelection({ effectId: null });
          } else if (state.selection.clipId) {
            state.mutate('Delete clip', (draft) => ops.deleteClip(draft, state.selection.clipId!));
            state.setSelection({ clipId: null });
          }
          return;
        default:
          break;
      }

      if (key === 'i') {
        event.preventDefault();
        const end = state.selection.range?.end ?? state.playhead + 1;
        state.setSelection({ range: { start: state.playhead, end: Math.max(state.playhead + 1, end) } });
        return;
      }
      if (key === 'o') {
        event.preventDefault();
        const start = state.selection.range?.start ?? state.playhead;
        state.setSelection({
          range: { start: Math.min(start, state.playhead), end: state.playhead + 1 },
        });
        return;
      }
      if (key === 's') {
        event.preventDefault();
        const clipId = state.selection.clipId ?? clipsSorted(state.project)[0]?.id;
        if (clipId) state.mutate('Split clip', (draft) => ops.splitClip(draft, clipId, state.playhead));
        return;
      }
      if (key === 'escape') {
        state.setSelection({ range: null });
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
