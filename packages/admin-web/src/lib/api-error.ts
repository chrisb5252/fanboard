import { AxiosError } from 'axios';

export type ErrorKind =
  | 'network'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'invalid'
  | 'rate_limited'
  | 'server'
  | 'unknown';

export interface AdminError {
  kind: ErrorKind;
  message: string;
  /** True when the console should drop the session and return to sign-in. */
  requiresLogin: boolean;
  status?: number;
}

interface ApiErrorBody {
  error?: { code?: string; message?: string };
}

function serverMessage(error: AxiosError): string | undefined {
  const body = error.response?.data as ApiErrorBody | undefined;
  const message = body?.error?.message;
  return typeof message === 'string' && message.trim() !== '' ? message : undefined;
}

/**
 * Maps a failure to something an operator can act on.
 *
 * 403 is separated from 401 on purpose. A 401 means the key is wrong and
 * signing in again is the fix; a 403 means the key is valid but for a different
 * venue, and signing in again with the same key will fail identically. Merging
 * them sends someone round a loop.
 */
export function toAdminError(error: unknown): AdminError {
  if (!(error instanceof AxiosError)) {
    return { kind: 'unknown', message: 'Something went wrong.', requiresLogin: false };
  }

  const status = error.response?.status;

  if (status === undefined) {
    return {
      kind: 'network',
      message: 'Cannot reach the server. Check the connection and try again.',
      requiresLogin: false,
    };
  }

  switch (status) {
    case 400:
      return {
        kind: 'invalid',
        message: serverMessage(error) ?? 'That input is not valid.',
        requiresLogin: false,
        status,
      };
    case 401:
      return {
        kind: 'unauthorized',
        message: 'Invalid API key.',
        requiresLogin: true,
        status,
      };
    case 403:
      return {
        kind: 'forbidden',
        message: 'This API key does not have access to that venue.',
        requiresLogin: false,
        status,
      };
    case 404:
      return {
        kind: 'not_found',
        message: serverMessage(error) ?? 'Venue not found.',
        requiresLogin: false,
        status,
      };
    case 409:
      return {
        kind: 'conflict',
        message: serverMessage(error) ?? 'That already exists.',
        requiresLogin: false,
        status,
      };
    case 429:
      return {
        kind: 'rate_limited',
        message: 'Too many requests. Wait a moment and try again.',
        requiresLogin: false,
        status,
      };
    default:
      if (status >= 500) {
        return {
          kind: 'server',
          message: 'The server had a problem. Try again shortly.',
          requiresLogin: false,
          status,
        };
      }
      return {
        kind: 'unknown',
        message: serverMessage(error) ?? 'Something went wrong.',
        requiresLogin: false,
        status,
      };
  }
}
