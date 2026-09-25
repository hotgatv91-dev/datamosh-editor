/**
 * UI copy. Labels stay in English (matching the layout in the spec), preset
 * descriptions are Vietnamese. Everything goes through this dictionary so the
 * language can be switched without touching components.
 */

export const t = {
  appName: 'DATAMOSH EDITOR',
  untitled: 'Untitled project',

  // top bar
  import: 'Import',
  undo: 'Undo',
  redo: 'Redo',
  save: 'Save',
  load: 'Load',
  newProject: 'New',

  // tools
  media: 'Media',
  edit: 'Edit',
  effects: 'Effects',
  datamosh: 'Datamosh',
  speed: 'Speed',
  adjust: 'Adjust',
  audio: 'Audio',

  // empty states
  importVideo: '+ Import Video',
  dropHere: 'Drag & drop your video here',
  dropHereOr: 'Drag & drop your video here, or press Import',
  timelineEmpty: 'Your timeline is empty.',
  selectSection: 'Select a section of the timeline.',
  noEffectSelected: 'No effect selected.',
  clickEffectToEdit: 'Click an effect block on the timeline to edit it.',

  // preview
  play: 'Play',
  pause: 'Pause',
  stop: 'Stop',
  prevFrame: 'Previous frame',
  nextFrame: 'Next frame',
  fullscreen: 'Fullscreen',
  fit: 'Fit',
  zoom: 'Zoom',
  frame: 'Frame',
  original: 'Original',
  effect: 'Effect',
  split: 'Split',
  previewQuality: 'Preview quality',
  renderScale: 'Render scale',
  decodeLimited: 'Frame-accurate decode unavailable for this file — using video element seeking.',

  // timeline
  video: 'Video',
  timeline: 'Timeline',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  fitTimeline: 'Fit timeline',
  splitAtPlayhead: 'Split',
  deleteSelected: 'Delete',
  duplicate: 'Duplicate',
  markIn: 'Mark In',
  markOut: 'Mark Out',
  clearSelection: 'Clear',

  // inspector
  inspector: 'Inspector',
  effectSection: 'Effect',
  clipSection: 'Video',
  start: 'Start',
  end: 'End',
  duration: 'Duration',
  preset: 'Preset',
  savePreset: 'Save preset',
  showToolColumn: 'Hiện cột công cụ',
  hideToolColumn: 'Thu gọn cột công cụ (dành chỗ cho khung xem)',
  showInspector: 'Hiện bảng thuộc tính',
  hideInspector: 'Ẩn bảng thuộc tính (dành chỗ cho khung xem)',
  resizeTimeline: 'Kéo để đổi chiều cao timeline · nhấp đúp để trả về mặc định',
  reset: 'Reset',
  apply: 'Apply',
  applied: 'Applied',
  previewLabel: 'Preview',
  advancedSettings: 'Advanced Settings',
  basicControls: 'Basic',
  presetControls: 'Preset controls',
  keyframes: 'Keyframes',
  addKeyframe: 'Add keyframe at playhead',
  clearKeyframes: 'Clear all keyframes',
  speedCurve: 'Speed curve',
  speedCurveHint: 'Kéo các điểm để đổi tốc độ trong vùng effect.',
  renderMode: 'Render mode',
  renderModeBitstream: 'True bitstream mosh',
  renderModeBitstreamHint: 'Gỡ I-frame khỏi bitstream khi export — artifact datamosh thật.',
  renderModePreview: 'Preview quality',
  renderModePreviewHint: 'Bake đúng những gì bạn thấy trong preview.',
  supportsBitstreamOnly: 'Chỉ có tác dụng khi export ở chế độ bitstream.',

  // export
  exportTitle: 'Export',
  resolution: 'Resolution',
  fpsLabel: 'FPS',
  format: 'Format',
  originalOption: 'Original',
  preparing: 'Preparing',
  processing: 'Processing',
  encoding: 'Encoding',
  complete: 'Complete',
  downloadVideo: 'Download Video',
  exportPipeline: 'Pipeline',
  pipelineBitstream: 'Fast — bitstream datamosh',
  pipelineBitstreamHint: 'Datamosh thật: I-frame bị gỡ khỏi bitstream. Effect cơ bản dùng filter của ffmpeg.',
  pipelineRender: 'Exact — render frames',
  pipelineRenderHint: 'Bake từng frame từ preview: giống hệt những gì bạn thấy. Chậm hơn.',

  // project
  newProjectConfirm: 'Create a new project? Unsaved changes will be lost.',
  saved: 'Project saved',
  autosaved: 'Autosaved',
  projectFile: 'Datamosh project',
  relinkNeeded: 'Re-select the source video to continue.',
  relink: 'Re-select video',

  // errors / misc
  details: 'Details',
  close: 'Close',
  cancel: 'Cancel',
  ok: 'OK',
  delete: 'Delete',
  enabled: 'Enabled',
  mediaQueue: 'Imported media',
  noMedia: 'No media imported yet.',
  properties: 'Properties',
  name: 'Name',
  size: 'Size',
  resolutionLabel: 'Resolution',
  unsupportedMessage: 'Video format is not supported.',
  tooLargeMessage: 'Video is too large to process on this device.',
  processingMessage: 'Unable to process this video.',
  recents: 'Recent projects',
} as const;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const idx = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** idx;
  return `${value >= 100 || idx === 0 ? Math.round(value) : value.toFixed(1)} ${units[idx]}`;
}

export function formatFps(fps: number): string {
  if (!Number.isFinite(fps) || fps <= 0) return '—';
  return Math.abs(fps - Math.round(fps)) < 0.01 ? `${Math.round(fps)} fps` : `${fps.toFixed(2)} fps`;
}

export function formatResolution(width: number, height: number): string {
  const size = `${width}×${height}`;
  const ratio = width / height;
  const known: [number, string][] = [
    [16 / 9, '16:9'],
    [9 / 16, '9:16'],
    [4 / 3, '4:3'],
    [3 / 4, '3:4'],
    [1, '1:1'],
    [21 / 9, '21:9'],
  ];
  const match = known.find(([r]) => Math.abs(r - ratio) < 0.02);
  return match ? `${size} · ${match[1]}` : size;
}
