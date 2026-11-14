import type { ErrorBody } from '@conduit/language';

/** The one error type that is allowed to reach the HTTP edge. Everything else becomes a 500 `internal`. */
export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, statusCode: number, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export const errors = {
  badRequest: (message: string): AppError => new AppError('bad_request', 400, message),
  forbidden: (message: string): AppError => new AppError('forbidden', 403, message),
  methodNotAllowed: (message: string): AppError => new AppError('method_not_allowed', 405, message),
  unsupportedMedia: (expected: string): AppError => new AppError('unsupported_media_type', 415, `the Content-Type must be ${expected}`),
  notFound: (what: string): AppError => new AppError('not_found', 404, `${what} not found`),
  conflict: (message: string): AppError => new AppError('conflict', 409, message),
  turnClosed: (turn: string, why: string): AppError => new AppError('turn_closed', 409, `turn ${turn} is closed: ${why}`),
  tooLarge: (limit: number): AppError => new AppError('payload_too_large', 413, `request body is larger than ${limit} bytes`),
  brainFailed: (message: string, cause?: unknown): AppError => new AppError('brain_failed', 502, message, { cause }),
  brainTimeout: (message: string): AppError => new AppError('brain_timeout', 504, message),
  imageFailed: (message: string, cause?: unknown): AppError => new AppError('image_failed', 502, message, { cause }),
  imageTimeout: (message: string): AppError => new AppError('image_timeout', 504, message),
};

export function toErrorBody(error: unknown): ErrorBody {
  if (error instanceof AppError) return { code: error.code, message: error.message, statusCode: error.statusCode };
  return { code: 'internal', message: 'internal error', statusCode: 500 };
}
