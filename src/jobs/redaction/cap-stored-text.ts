import { MAX_ERROR_CHARS, MAX_LOG_ENTRIES, MAX_LOG_ENTRY_CHARS, MAX_LOGS_CHARS } from '../constants'
import type { JobLogEntry } from '../types'

export function capText(value: string, max: number): string {
  if (value.length <= max) {
    return value
  }
  return `${value.slice(0, max)}\n[truncated]`
}

export function errorDetails(error: unknown): string {
  if (error instanceof Error) {
    const stack = error.stack ? `\n${error.stack}` : ''
    return capText(`${error.name}: ${error.message}${stack}`, MAX_ERROR_CHARS)
  }
  return capText(String(error), MAX_ERROR_CHARS)
}

export function capLogs(entries: JobLogEntry[]): JobLogEntry[] {
  const capped = entries.slice(-MAX_LOG_ENTRIES).map((entry) => ({
    at: entry.at,
    message: capText(entry.message, MAX_LOG_ENTRY_CHARS),
  }))
  while (JSON.stringify(capped).length > MAX_LOGS_CHARS && capped.length > 1) {
    capped.shift()
  }
  if (JSON.stringify(capped).length > MAX_LOGS_CHARS && capped[0]) {
    capped[0] = {
      at: capped[0].at,
      message: capText(capped[0].message, 200),
    }
  }
  return capped
}
