/** Typed errors + the exact user-facing copy required by the spec (§XXXIX). */

export type AppErrorCode =
  | 'unsupported-format'
  | 'too-large'
  | 'decode-failed'
  | 'process-failed'
  | 'no-video-track'
  | 'export-failed'
  | 'storage-failed'
  | 'selection-empty';

export class AppError extends Error {
  code: AppErrorCode;
  detail?: string;

  constructor(code: AppErrorCode, message?: string, detail?: string) {
    super(message ?? DEFAULT_MESSAGES[code]);
    this.name = 'AppError';
    this.code = code;
    this.detail = detail;
  }
}

export const DEFAULT_MESSAGES: Record<AppErrorCode, string> = {
  'unsupported-format': 'Video format is not supported.',
  'too-large': 'Video is too large to process on this device.',
  'decode-failed': 'Unable to process this video.',
  'process-failed': 'Unable to process this video.',
  'no-video-track': 'This file does not contain a video track.',
  'export-failed': 'Unable to process this video.',
  'storage-failed': 'Unable to save the project on this device.',
  'selection-empty': 'Select a section of the timeline.',
};

const SUPPORTED_EXTENSIONS = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'ogv'];

/** 2 GB — beyond this the browser file APIs and MEMFS become unreliable. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
/** Above this we warn about low-end / mobile devices but still allow import. */
export const SOFT_FILE_BYTES = 350 * 1024 * 1024;

export function fileExtension(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx < 0 ? '' : name.slice(idx + 1).toLowerCase();
}

export function looksSupported(name: string, mime: string): boolean {
  if (mime && /^video\//i.test(mime)) return true;
  return SUPPORTED_EXTENSIONS.includes(fileExtension(name));
}

export function errorMessage(error: unknown): string {
  if (error instanceof AppError) return error.message;
  if (error instanceof Error) return error.message;
  return DEFAULT_MESSAGES['process-failed'];
}

export function errorDetail(error: unknown): string | undefined {
  if (error instanceof AppError) return error.detail;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return undefined;
}
