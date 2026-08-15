/**
 * Console logging for the display.
 *
 * The only module allowed to touch console; see the eslint override. Everything
 * here goes to the device log, never to the screen — a TV in a bar must show
 * the game, not a stack trace.
 *
 * Nothing logged here may contain the display key. Callers pass context, not
 * credentials.
 */

function stamp(): string {
  return new Date().toISOString();
}

/* eslint-disable no-console */
export const log = {
  info(message: string, fields?: Record<string, unknown>): void {
    console.log(`${stamp()} [fanboard-tv] ${message}`, fields ?? '');
  },
  warn(message: string, fields?: Record<string, unknown>): void {
    console.warn(`${stamp()} [fanboard-tv] ${message}`, fields ?? '');
  },
  error(message: string, fields?: Record<string, unknown>): void {
    console.error(`${stamp()} [fanboard-tv] ${message}`, fields ?? '');
  },
};
/* eslint-enable no-console */
