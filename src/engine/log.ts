/**
 * Ring-buffer log. The UI shows the last few entries behind the "Details"
 * button of any error, so a failed import/export is diagnosable without a
 * devtools session.
 */

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  id: number;
  at: number;
  level: LogLevel;
  scope: string;
  message: string;
  detail?: string;
}

const MAX_ENTRIES = 200;
let nextId = 1;
let entries: LogEntry[] = [];
const listeners = new Set<() => void>();

function push(level: LogLevel, scope: string, message: string, detail?: unknown): void {
  const text =
    detail === undefined
      ? undefined
      : typeof detail === 'string'
        ? detail
        : safeStringify(detail);
  entries = [...entries, { id: nextId++, at: Date.now(), level, scope, message, detail: text }];
  if (entries.length > MAX_ENTRIES) entries = entries.slice(entries.length - MAX_ENTRIES);
  listeners.forEach((fn) => fn());
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ''}`;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export const log = {
  info: (scope: string, message: string, detail?: unknown) => push('info', scope, message, detail),
  warn: (scope: string, message: string, detail?: unknown) => push('warn', scope, message, detail),
  error: (scope: string, message: string, detail?: unknown) => push('error', scope, message, detail),
  entries: () => entries,
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  clear(): void {
    entries = [];
    listeners.forEach((fn) => fn());
  },
  asText(): string {
    return entries
      .map(
        (e) =>
          `[${new Date(e.at).toLocaleTimeString()}] ${e.level.toUpperCase()} ${e.scope}: ${e.message}${
            e.detail ? `\n  ${e.detail.replace(/\n/g, '\n  ')}` : ''
          }`,
      )
      .join('\n');
  },
};
