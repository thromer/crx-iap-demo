import type { Logger, LogLevel, LogSubsystem } from './types.ts';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let seq = 0;

export function nextSeq(): number {
  seq += 1;
  return seq;
}

// Verbose structured logger, enabled by default at `debug` in this build so misbehavior is
// obvious at a glance rather than requiring a debugger.
export function createLogger(minLevel: LogLevel = 'debug'): Logger {
  const threshold = LEVEL_ORDER[minLevel];

  function log(
    level: LogLevel,
    subsystem: LogSubsystem,
    message: string,
    data?: Record<string, unknown>,
  ): void {
    if (LEVEL_ORDER[level] < threshold) return;
    const entry = {
      seq: nextSeq(),
      ts: Date.now(),
      level,
      subsystem,
      message,
      ...data,
    };
    const line = JSON.stringify(entry);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }

  return {
    debug: (subsystem, message, data) => log('debug', subsystem, message, data),
    info: (subsystem, message, data) => log('info', subsystem, message, data),
    warn: (subsystem, message, data) => log('warn', subsystem, message, data),
    error: (subsystem, message, data) => log('error', subsystem, message, data),
  };
}
