/**
 * Editor store: project + selection + UI, with snapshot-based undo/redo.
 *
 * Every mutation goes through `mutate(label, recipe)`, where the recipe edits a
 * structured clone of the project. Projects only ever contain JSON (never video
 * bytes), so cloning is cheap and history is trivially correct — there is no
 * chance of an operation forgetting to register its inverse.
 */

import { create } from 'zustand';
import type {
  EffectType,
  Frame,
  Id,
  MediaAsset,
  Project,
  RenderMode,
} from '../engine/project/types';
import { createEmptyProject } from '../engine/project/types';
import type { DatamoshPreset } from '../engine/datamosh/presets';
import { materializeKeyframes, parametersFromBundles } from '../engine/datamosh/presets';
import type { CustomPreset } from '../engine/datamosh/customPresets';
import {
  MAX_PRESETS,
  loadCustomPresets,
  persistCustomPresets,
  snapshotEffectAsPreset,
} from '../engine/datamosh/customPresets';
import { isLikelyLowEndDevice } from '../engine/device';
import { defaultParameters, normalizeParams } from '../engine/datamosh/params';
import { BASIC_EFFECTS } from '../engine/effects/registry';
import * as ops from '../engine/timeline/ops';
import { projectDuration } from '../engine/timeline/derive';

export type ToolId = 'media' | 'edit' | 'effects' | 'datamosh' | 'speed' | 'adjust' | 'audio';
export type PreviewMode = 'original' | 'effect' | 'split';
export type SheetId = ToolId | 'export' | 'project' | null;
// `full` — real motion vectors (default); `fast` — coarser grid, shorter
// search; `flat` — no search at all, a zero field. Defined next to the
// estimator that implements them so the two cannot drift apart.
export type { MotionQuality } from '../engine/motion/motionField';
import type { MotionQuality } from '../engine/motion/motionField';

export interface Selection {
  clipId: Id | null;
  effectId: Id | null;
  /** In/Out marks used to create new effect regions. */
  range: { start: Frame; end: Frame } | null;
}

export interface StatusMessage {
  kind: 'info' | 'success' | 'error';
  message: string;
  detail?: string;
  at: number;
}

export interface ExportProgress {
  stage: 'preparing' | 'processing' | 'encoding' | 'complete' | 'failed';
  percent: number;
  message: string;
}

export interface UiState {
  tool: ToolId;
  pxPerFrame: number;
  /** First visible timeline frame (the timeline scrolls virtually, no giant DOM). */
  scrollFrame: number;
  timelineHeight: number;
  previewMode: PreviewMode;
  splitPosition: number;
  /** 0 = original resolution. */
  previewQuality: 0 | 360 | 540 | 720;
  /** Preview render cap while playing; 0 = uncapped (every animation frame). */
  previewFpsCap: 0 | 24 | 30 | 60;
  motionQuality: MotionQuality;
  /** Frames replayed to rebuild motion history when seeking into a mosh region. */
  primeFrames: number;
  /** Desktop layout: collapse the tool column / the inspector for more preview. */
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  sheet: SheetId;
  /**
   * Small screens: keep the sheet as a header strip so the timeline stays
   * reachable. Dropped to a peek right after an effect is created, because the
   * next thing the user does is drag the block that was just made.
   */
  sheetPeek: boolean;
  playing: boolean;
  /** True while the selected effect has preview-only changes (Apply pending). */
  pendingApply: boolean;
  /** Bumped when a frame source becomes ready so views can repaint. */
  sourceEpoch: number;
  previewZoom: number;
  showAdvanced: boolean;
  showKeyframes: boolean;
  status: StatusMessage | null;
  exportOpen: boolean;
  exportProgress: ExportProgress | null;
  exportResultUrl: string | null;
}

interface HistoryEntry {
  label: string;
  coalesceKey?: string;
  before: Project;
  after: Project;
  at: number;
}

export interface EditorStore {
  project: Project;
  past: HistoryEntry[];
  future: HistoryEntry[];
  playhead: Frame;
  selection: Selection;
  ui: UiState;
  /** Bumped whenever a project mutation happened, used by autosave. */
  revision: number;
  /** Source files that are not serialisable into the project JSON. */
  mediaFiles: Record<Id, File>;
  /** Presets the user saved. Persisted to localStorage, never in the project. */
  customPresets: CustomPreset[];

  mutate: (label: string, recipe: (draft: Project) => void, coalesceKey?: string) => void;
  undo: () => void;
  redo: () => void;
  replaceProject: (project: Project, options?: { keepHistory?: boolean }) => void;
  newProject: () => void;
  setPlayhead: (frame: Frame) => void;
  setSelection: (patch: Partial<Selection>) => void;
  setUi: (patch: Partial<UiState>) => void;
  setStatus: (status: StatusMessage | null) => void;
  setExportProgress: (progress: ExportProgress | null) => void;
  setExportResult: (url: string | null) => void;
  registerMediaFile: (mediaId: Id, file: File) => void;
  /** Captures the given effect's current settings as a re-usable preset. */
  saveCustomPreset: (label: string, effectId: Id) => CustomPreset | null;
  deleteCustomPreset: (id: string) => void;
  addMedia: (asset: MediaAsset, file: File, options?: { autoClip?: boolean }) => Id | null;
  /** `range` is optional: without one a region is made around the playhead. */
  createDatamoshRegion: (
    preset: DatamoshPreset,
    range?: { start: Frame; end: Frame } | null,
  ) => Id | null;
  createEffectRegion: (type: EffectType, range?: { start: Frame; end: Frame } | null) => Id | null;
  setEffectRenderMode: (effectId: Id, mode: RenderMode) => void;
  duration: () => Frame;
}

const HISTORY_LIMIT = 80;
const COALESCE_MS = 700;

function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Where a new effect block lands when no region has been marked: one second
 * centred on the playhead, clamped to the timeline.
 *
 * Adding an effect must never require marking In/Out first. That two-step dance
 * is the whole reason the block was hard to place — you add it, then drag its
 * edges until it lines up, which is what the block is for.
 */
function defaultEffectRange(
  project: Project,
  playhead: Frame,
): { start: Frame; end: Frame } | null {
  if (!project.clips.length) return null;
  const fps = project.fps || 30;
  const total = Math.max(1, projectDuration(project));
  const length = Math.max(1, Math.min(total, Math.round(fps)));
  const start = Math.max(0, Math.min(Math.max(0, total - length), Math.round(playhead) - Math.floor(length / 2)));
  return { start, end: Math.max(start + 1, Math.min(total, start + length)) };
}

/** Shared by both create*Region actions. */
function resolveRange(
  project: Project,
  playhead: Frame,
  range: { start: Frame; end: Frame } | null | undefined,
): { start: Frame; end: Frame } | null {
  if (range) {
    const start = Math.min(range.start, range.end);
    const end = Math.max(range.start, range.end);
    if (end > start) return { start, end };
  }
  return defaultEffectRange(project, playhead);
}

const initialUi: UiState = {
  tool: 'media',
  pxPerFrame: 4,
  scrollFrame: 0,
  timelineHeight: 0, // 0 = use the CSS default
  previewMode: 'effect',
  splitPosition: 0.5,
  // A weak device starts at 360p instead of 540p: the difference between a
  // usable preview and a slideshow, and the user can raise it in the HUD.
  previewQuality: isLikelyLowEndDevice() ? 360 : 540,
  previewFpsCap: 0,
  motionQuality: 'full',
  primeFrames: 4,
  leftCollapsed: false,
  rightCollapsed: false,
  sheet: null,
  sheetPeek: false,
  playing: false,
  pendingApply: false,
  sourceEpoch: 0,
  previewZoom: 1,
  showAdvanced: false,
  showKeyframes: false,
  status: null,
  exportOpen: false,
  exportProgress: null,
  exportResultUrl: null,
};

export const useEditor = create<EditorStore>((set, get) => ({
  project: createEmptyProject(),
  past: [],
  future: [],
  playhead: 0,
  selection: { clipId: null, effectId: null, range: null },
  ui: initialUi,
  revision: 0,
  mediaFiles: {},
  customPresets: loadCustomPresets(),

  mutate: (label, recipe, coalesceKey) => {
    const { project, past } = get();
    const before = project;
    const draft = clone(project);
    try {
      recipe(draft);
    } catch (error) {
      // A broken operation must never leave the store in a half-mutated state.
      // eslint-disable-next-line no-console
      console.error('mutation failed', label, error);
      return;
    }
    draft.updatedAt = Date.now();

    const last = past[past.length - 1];
    const canCoalesce =
      !!coalesceKey &&
      !!last &&
      last.coalesceKey === coalesceKey &&
      Date.now() - last.at < COALESCE_MS;

    let nextPast: HistoryEntry[];
    if (canCoalesce && last) {
      nextPast = past.slice(0, -1).concat({ ...last, after: draft, at: Date.now() });
    } else {
      nextPast = past.concat({ label, coalesceKey, before, after: draft, at: Date.now() });
      if (nextPast.length > HISTORY_LIMIT) nextPast = nextPast.slice(nextPast.length - HISTORY_LIMIT);
    }

    set((state) => ({
      project: draft,
      past: nextPast,
      future: [],
      revision: state.revision + 1,
    }));
  },

  undo: () => {
    const { past, future } = get();
    const entry = past[past.length - 1];
    if (!entry) return;
    set((state) => ({
      project: entry.before,
      past: past.slice(0, -1),
      future: future.concat(entry),
      revision: state.revision + 1,
    }));
  },

  redo: () => {
    const { past, future } = get();
    const entry = future[future.length - 1];
    if (!entry) return;
    set((state) => ({
      project: entry.after,
      past: past.concat(entry),
      future: future.slice(0, -1),
      revision: state.revision + 1,
    }));
  },

  replaceProject: (project, options) => {
    set((state) => ({
      project,
      past: options?.keepHistory ? state.past : [],
      future: [],
      playhead: 0,
      selection: { clipId: null, effectId: null, range: null },
      revision: state.revision + 1,
    }));
  },

  newProject: () => {
    set((state) => ({
      project: createEmptyProject(),
      past: [],
      future: [],
      playhead: 0,
      selection: { clipId: null, effectId: null, range: null },
      mediaFiles: {},
      ui: { ...state.ui, status: null, exportOpen: false, sheet: null, sheetPeek: false },
      revision: state.revision + 1,
    }));
  },

  setPlayhead: (frame) => {
    const duration = get().duration();
    const clamped = Math.max(0, Math.min(Math.max(0, duration - 1), Math.round(frame)));
    if (clamped === get().playhead) return;
    set({ playhead: clamped });
  },

  setSelection: (patch) => set((state) => ({ selection: { ...state.selection, ...patch } })),

  setUi: (patch) => set((state) => ({ ui: { ...state.ui, ...patch } })),

  setStatus: (status) => set((state) => ({ ui: { ...state.ui, status } })),

  setExportProgress: (progress) => set((state) => ({ ui: { ...state.ui, exportProgress: progress } })),

  setExportResult: (url) => set((state) => ({ ui: { ...state.ui, exportResultUrl: url } })),

  registerMediaFile: (mediaId, file) =>
    set((state) => ({ mediaFiles: { ...state.mediaFiles, [mediaId]: file } })),

  saveCustomPreset: (label, effectId) => {
    const effect = get().project.effects.find((e) => e.id === effectId);
    if (!effect) return null;
    const preset = snapshotEffectAsPreset(effect, label);
    // Saving the same name twice replaces it rather than piling up duplicates.
    const customPresets = [
      preset,
      ...get().customPresets.filter((item) => item.label.toLowerCase() !== preset.label.toLowerCase()),
    ].slice(0, MAX_PRESETS);
    persistCustomPresets(customPresets);
    set({ customPresets });
    return preset;
  },

  deleteCustomPreset: (id) => {
    const customPresets = get().customPresets.filter((item) => item.id !== id);
    persistCustomPresets(customPresets);
    set({ customPresets });
  },

  addMedia: (asset, file, options) => {
    const existing = get().project.media.find(
      (m) => m.name === asset.name && m.sizeBytes === asset.sizeBytes && m.lastModified === asset.lastModified,
    );
    const mediaId = existing?.id ?? asset.id;
    const storedAsset = existing ?? asset;

    let clipId: Id | null = null;
    get().mutate('Import video', (draft) => {
      if (!existing) draft.media.push(storedAsset);
      // The timeline frame rate follows the first video imported.
      if (draft.clips.length === 0) draft.fps = storedAsset.fps;
      if (options?.autoClip !== false) {
        clipId = ops.addClipFromMedia(draft, storedAsset, 0);
      }
    });

    get().registerMediaFile(mediaId, file);
    if (clipId) {
      get().setSelection({ clipId, effectId: null });
    }
    return clipId;
  },

  createDatamoshRegion: (preset, range) => {
    const resolved = resolveRange(get().project, get().playhead, range);
    if (!resolved) {
      get().setStatus({ kind: 'info', message: 'Hãy nhập video trước khi thêm hiệu ứng.', at: Date.now() });
      return null;
    }
    let effectId: Id | null = null;
    get().mutate(`Datamosh · ${preset.label}`, (draft) => {
      // Built from the preset object itself, not from a map lookup by id: a
      // user-saved preset is not in the built-in map, and looking it up by id
      // would silently create the effect with schema defaults.
      const params = parametersFromBundles(preset.params);
      effectId = ops.addEffect(draft, {
        type: 'datamosh',
        startFrame: resolved.start,
        endFrame: resolved.end,
        preset: preset.id,
        parameters: params,
        renderMode: preset.prefersBitstream === false ? 'preview-quality' : 'bitstream',
      });
      const effect = draft.effects.find((e) => e.id === effectId);
      if (effect) {
        effect.keyframes = materializeKeyframes(preset.keyframes ?? [], effect);
        if (!effect.speedCurve.length && preset.id === 'slow-motion') {
          effect.speedCurve = [
            { at: 0, value: 1 },
            { at: 0.25, value: 0.5 },
            { at: 0.6, value: 0.25 },
            { at: 1, value: 1 },
          ];
        }
      }
    });
    if (effectId) get().setSelection({ effectId, range: null });
    return effectId;
  },

  createEffectRegion: (type, range) => {
    const def = BASIC_EFFECTS.find((e) => e.type === type);
    if (!def) return null;
    const resolved = resolveRange(get().project, get().playhead, range);
    if (!resolved) {
      get().setStatus({ kind: 'info', message: 'Hãy nhập video trước khi thêm hiệu ứng.', at: Date.now() });
      return null;
    }
    let effectId: Id | null = null;
    get().mutate(`${def.label} effect`, (draft) => {
      effectId = ops.addEffect(draft, {
        type,
        startFrame: resolved.start,
        endFrame: resolved.end,
        preset: type,
        parameters: normalizeParams({ ...defaultParameters(), ...def.defaults }),
        renderMode: 'preview-quality',
      });
    });
    if (effectId) get().setSelection({ effectId, range: null });
    return effectId;
  },

  setEffectRenderMode: (effectId, mode) => {
    get().mutate('Change render mode', (draft) => {
      ops.setEffectRenderMode(draft, effectId, mode);
    });
  },

  duration: () => projectDuration(get().project),
}));

export function canUndo(state: EditorStore): boolean {
  return state.past.length > 0;
}

export function canRedo(state: EditorStore): boolean {
  return state.future.length > 0;
}
