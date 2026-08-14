/**
 * Structured JSON logging with two independent layers of secret protection.
 *
 *  1. Key-based redaction — any field whose *name* looks like a credential is
 *     replaced, however deeply nested.
 *  2. Value-based scrubbing — secrets registered via `registerSecret()` are
 *     stripped from the serialised line no matter which field they reached.
 *
 * Layer 2 exists because layer 1 only catches what we remembered to name
 * carefully. A connection string pasted into an error message is caught by
 * layer 2 and nothing else.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Returns a logger that merges `bindings` into every subsequent line. */
  child(bindings: LogFields): Logger;
}

export interface LoggerOptions {
  level?: LogLevel | 'silent';
  bindings?: LogFields;
  /** Overridable output, primarily so tests can assert on emitted lines. */
  sink?: (line: string, level: LogLevel) => void;
}

const LEVEL_ORDER: Record<LogLevel | 'silent', number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

const REDACTED = '[REDACTED]';

/** Field names that must never have their value printed. */
const SENSITIVE_KEY_PATTERN = /key|token|secret|password|passwd|auth|credential|cookie|dsn/i;

const MAX_DEPTH = 6;

/**
 * Registered secrets are stripped from every emitted line.
 *
 * Short values are refused on purpose: scrubbing a 3-character key such as the
 * TheSportsDB public test key "123" would corrupt unrelated numbers in the
 * output. Short keys stay protected by URL redaction at the call site instead.
 */
const MIN_SCRUBBABLE_SECRET_LENGTH = 8;

const registeredSecrets = new Set<string>();

export function registerSecret(value: string | null | undefined): void {
  if (typeof value === 'string' && value.length >= MIN_SCRUBBABLE_SECRET_LENGTH) {
    registeredSecrets.add(value);
  }
}

/** Test seam. Not used in production code paths. */
export function clearRegisteredSecrets(): void {
  registeredSecrets.clear();
}

function scrubSecrets(line: string): string {
  let scrubbed = line;
  for (const secret of registeredSecrets) {
    if (scrubbed.includes(secret)) {
      scrubbed = scrubbed.split(secret).join(REDACTED);
    }
  }
  return scrubbed;
}

function serialize(value: unknown, depth: number): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (value === null || typeof value !== 'object') {
    return typeof value === 'bigint' ? value.toString() : value;
  }
  if (depth >= MAX_DEPTH) {
    return '[depth-limit]';
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((entry) => serialize(entry, depth + 1));
  }

  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : serialize(nested, depth + 1);
  }
  return output;
}

function resolveLevel(): LogLevel | 'silent' {
  const raw = process.env['LOG_LEVEL'];
  if (raw !== undefined && raw in LEVEL_ORDER) {
    return raw as LogLevel | 'silent';
  }
  return 'info';
}

function defaultSink(line: string, level: LogLevel): void {
  // The single place in the codebase permitted to touch console; see the
  // eslint override for this file.
  /* eslint-disable no-console */
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
  /* eslint-enable no-console */
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? resolveLevel();
  const bindings = options.bindings ?? {};
  const sink = options.sink ?? defaultSink;
  const threshold = LEVEL_ORDER[level];

  function emit(entryLevel: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_ORDER[entryLevel] < threshold) {
      return;
    }

    const merged = { ...bindings, ...(fields ?? {}) };
    const payload = {
      timestamp: new Date().toISOString(),
      level: entryLevel,
      message,
      ...(serialize(merged, 0) as Record<string, unknown>),
    };

    let line: string;
    try {
      line = JSON.stringify(payload);
    } catch {
      // Circular structure that survived serialize(); never let logging throw.
      line = JSON.stringify({
        timestamp: new Date().toISOString(),
        level: entryLevel,
        message,
        logError: 'payload not serialisable',
      });
    }

    sink(scrubSecrets(line), entryLevel);
  }

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child: (extra) => createLogger({ ...options, level, bindings: { ...bindings, ...extra } }),
  };
}

export const logger: Logger = createLogger();
