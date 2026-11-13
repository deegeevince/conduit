export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Readonly<Record<string, unknown>>;

/** One JSON object per line on stdout. This is the only module in the server that writes to the console. */
export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** A logger that adds `fields` to everything it writes. */
  child(fields: LogFields): Logger;
}

function describeError(value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack, cause: describeError(value.cause) };
  return value;
}

export function createLogger(level: LogLevel, bound: LogFields = {}, write: (line: string) => void = (line) => process.stdout.write(line)): Logger {
  const emit = (at: LogLevel, event: string, fields: LogFields | undefined): void => {
    if (ORDER[at] < ORDER[level]) return;
    const record: Record<string, unknown> = { time: new Date().toISOString(), level: at, event, ...bound };
    for (const [key, value] of Object.entries(fields ?? {})) record[key] = describeError(value);
    write(`${JSON.stringify(record)}\n`);
  };
  return {
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    child: (fields) => createLogger(level, { ...bound, ...fields }, write),
  };
}
