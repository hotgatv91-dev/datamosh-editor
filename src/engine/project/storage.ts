/**
 * Project persistence.
 *
 * A project file is pure JSON: timeline, clips, effect regions, datamosh
 * settings, keyframes and export settings. Video bytes are never stored inside
 * it, so a project stays a few kilobytes and can be saved to local storage or
 * downloaded as a .moshproj file.
 */

import type { Effect, Project } from './types';
import { PROJECT_VERSION, createEmptyProject } from './types';
import { normalizeParams } from '../datamosh/params';
import { log } from '../log';

const DB_NAME = 'datamosh-editor';
const DB_VERSION = 1;
const STORE = 'projects';
const AUTOSAVE_KEY = 'autosave';

export interface ProjectEnvelope {
  kind: 'datamosh-project';
  version: number;
  savedAt: number;
  project: Project;
}

export function serializeProject(project: Project): string {
  const envelope: ProjectEnvelope = {
    kind: 'datamosh-project',
    version: PROJECT_VERSION,
    savedAt: Date.now(),
    project,
  };
  return JSON.stringify(envelope, null, 2);
}

export function deserializeProject(text: string): Project {
  const parsed = JSON.parse(text) as Partial<ProjectEnvelope>;
  if (!parsed || typeof parsed !== 'object') throw new Error('Not a project file');
  const raw = parsed.project ?? (parsed as unknown as Project);
  return migrateProject(raw);
}

export function migrateProject(raw: Partial<Project> | undefined): Project {
  if (!raw || typeof raw !== 'object') throw new Error('Damaged project file');
  const base = createEmptyProject();
  const project: Project = {
    ...base,
    ...raw,
    version: PROJECT_VERSION,
    media: Array.isArray(raw.media) ? raw.media : [],
    clips: Array.isArray(raw.clips) ? raw.clips : [],
    effects: Array.isArray(raw.effects) ? raw.effects.map(normalizeEffect) : [],
    exportSettings: { ...base.exportSettings, ...(raw.exportSettings ?? {}) },
    fps: typeof raw.fps === 'number' && raw.fps > 0 ? raw.fps : base.fps,
  };
  // Clips must reference existing media, otherwise the timeline would be broken.
  const mediaIds = new Set(project.media.map((m) => m.id));
  project.clips = project.clips.filter((clip) => mediaIds.has(clip.mediaId));
  return project;
}

function normalizeEffect(effect: Effect): Effect {
  return {
    ...effect,
    enabled: effect.enabled !== false,
    parameters: normalizeParams(effect.parameters as Record<string, unknown>),
    keyframes: Array.isArray(effect.keyframes) ? effect.keyframes : [],
    speedCurve: Array.isArray(effect.speedCurve) ? effect.speedCurve : [],
    renderMode: effect.renderMode === 'preview-quality' ? 'preview-quality' : 'bitstream',
  };
}

/* ------------------------------------------------------------ IndexedDB */

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      log.warn('storage', 'IndexedDB unavailable', request.error);
      resolve(null);
    };
  });
}

async function put(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function get<T>(key: string): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  const value = await new Promise<T | null>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).get(key);
    request.onsuccess = () => resolve((request.result as T) ?? null);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return value;
}

export async function saveAutosave(project: Project): Promise<void> {
  try {
    await put(AUTOSAVE_KEY, { project, savedAt: Date.now() });
  } catch (error) {
    log.warn('storage', 'autosave failed', error);
  }
}

export async function loadAutosave(): Promise<Project | null> {
  try {
    const value = await get<{ project: Project; savedAt: number }>(AUTOSAVE_KEY);
    if (!value?.project) return null;
    return migrateProject(value.project);
  } catch (error) {
    log.warn('storage', 'autosave load failed', error);
    return null;
  }
}

export async function clearAutosave(): Promise<void> {
  await put(AUTOSAVE_KEY, null);
}

export function downloadProject(project: Project): void {
  const blob = new Blob([serializeProject(project)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const safeName = project.name.replace(/[^\w\-. ]+/g, '_').trim() || 'project';
  anchor.href = url;
  anchor.download = `${safeName}.moshproj.json`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}
