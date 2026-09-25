import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/global.css';
import { App } from './app/App';
import { log } from './engine/log';
import { useEditor } from './state/store';
import { importVideoFile } from './features/media/importMedia';
import { frameSourceRegistry } from './engine/frames';
import { resolveTimelineFrame, FrameMapCache } from './engine/timeline/playback';

log.info('app', `Datamosh Editor starting · ${navigator.userAgent}`);

// Dev-only handle so the editor can be driven from the console (and from
// automated smoke tests) without a file picker.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__editor = {
    store: useEditor,
    log,
    frames: frameSourceRegistry,
    resolveTimelineFrame,
    FrameMapCache,
    async importUrl(url: string, filename: string) {
      const response = await fetch(url);
      const blob = await response.blob();
      const file = new File([blob], filename, { type: blob.type || 'video/mp4', lastModified: Date.now() });
      const result = await importVideoFile(file);
      useEditor.getState().addMedia(result.asset, file);
      return { asset: result.asset, warnings: result.warnings };
    },
  };
}

const container = document.getElementById('root');
if (!container) throw new Error('Root container missing');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
