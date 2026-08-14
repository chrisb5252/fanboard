import { logger as rootLogger, type Logger } from './logger';

/**
 * An error with a deliberate HTTP representation.
 *
 * Anything that is NOT an ApiError is treated as a bug and rendered as a
 * generic 500 — internal messages, stack traces and driver errors must never
 * reach a client, because they leak schema and topology.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Safe to serialise to the client. Never put internal detail here. */
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(message: string, details?: unknown): ApiError {
    return new ApiError(400, 'invalid_request', message, details);
  }

  static unauthorized(message = 'Authentication required'): ApiError {
    return new ApiError(401, 'unauthorized', message);
  }

  static forbidden(message = 'Not permitted for this venue'): ApiError {
    return new ApiError(403, 'forbidden', message);
  }

  static notFound(message = 'Not found'): ApiError {
    return new ApiError(404, 'not_found', message);
  }

  static locked(message = 'Game is locked', details?: unknown): ApiError {
    return new ApiError(423, 'game_locked', message, details);
  }

  static internal(message = 'Internal server error'): ApiError {
    return new ApiError(500, 'internal_error', message);
  }
}

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/**
 * Maps any thrown value onto a client-safe body + status.
 *
 * Unknown errors are logged in full server-side and reduced to a bare 500 for
 * the client.
 */
export function toErrorBody(
  error: unknown,
  log: Logger = rootLogger,
): { status: number; body: ErrorBody } {
  if (error instanceof ApiError) {
    if (error.status >= 500) {
      log.error('request failed', { code: error.code, status: error.status, error });
    } else {
      log.debug('request rejected', { code: error.code, status: error.status });
    }

    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      },
    };
  }

  log.error('unhandled error in request handler', { error });
  return {
    status: 500,
    body: { error: { code: 'internal_error', message: 'Internal server error' } },
  };
}
