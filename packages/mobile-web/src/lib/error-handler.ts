import { AxiosError } from 'axios';

/**
 * Turns any thrown value into something a patron can act on.
 *
 * "Something went wrong" tells a person nothing. Every message below says what
 * happened and what to do about it, because the alternative is a room full of
 * people tapping a button that silently does nothing.
 */

export type ErrorKind =
  | 'network'
  | 'locked'
  | 'unauthorized'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'invalid'
  | 'server'
  | 'unknown';

export interface FriendlyError {
  kind: ErrorKind;
  message: string;
  /** True when the caller should send the player back to venue entry. */
  requiresReauth: boolean;
  status?: number;
  retryAfterSeconds?: number;
}

interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    details?: { retryAfterSeconds?: number };
  };
}

function serverMessage(error: AxiosError): string | undefined {
  const body = error.response?.data as ApiErrorBody | undefined;
  const message = body?.error?.message;
  return typeof message === 'string' && message.trim() !== '' ? message : undefined;
}

export function toFriendlyError(error: unknown): FriendlyError {
  if (!(error instanceof AxiosError)) {
    return {
      kind: 'unknown',
      message: 'Something went wrong. Please try again.',
      requiresReauth: false,
    };
  }

  const status = error.response?.status;

  if (status === undefined) {
    return {
      kind: 'network',
      message: 'Connection lost. Check your signal and try again.',
      requiresReauth: false,
    };
  }

  switch (status) {
    case 400:
      return {
        kind: 'invalid',
        message: serverMessage(error) ?? 'That input is not valid.',
        requiresReauth: false,
        status,
      };
    case 401:
      return {
        kind: 'unauthorized',
        message: 'Your session ended. Join the venue again to keep playing.',
        requiresReauth: true,
        status,
      };
    case 403:
      return {
        kind: 'unauthorized',
        message: 'That session belongs to a different venue.',
        requiresReauth: true,
        status,
      };
    case 404:
      return {
        kind: 'not_found',
        message: serverMessage(error) ?? 'Not found. It may have been removed.',
        requiresReauth: false,
        status,
      };
    case 409:
      return {
        kind: 'conflict',
        message: serverMessage(error) ?? 'That nickname is taken. Try another.',
        requiresReauth: false,
        status,
      };
    case 423:
      return {
        kind: 'locked',
        message: 'This game has started. Picks are locked.',
        requiresReauth: false,
        status,
      };
    case 429: {
      const body = error.response?.data as ApiErrorBody | undefined;
      const seconds = body?.error?.details?.retryAfterSeconds;
      const minutes = typeof seconds === 'number' ? Math.ceil(seconds / 60) : undefined;
      return {
        kind: 'rate_limited',
        message:
          minutes === undefined
            ? 'Too many attempts. Try again later.'
            : `Too many attempts. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`,
        requiresReauth: false,
        status,
        ...(typeof seconds === 'number' ? { retryAfterSeconds: seconds } : {}),
      };
    }
    default:
      if (status >= 500) {
        return {
          kind: 'server',
          message: 'The scoreboard is having trouble. Trying again shortly.',
          requiresReauth: false,
          status,
        };
      }
      return {
        kind: 'unknown',
        message: serverMessage(error) ?? 'Something went wrong. Please try again.',
        requiresReauth: false,
        status,
      };
  }
}
