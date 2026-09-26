export interface GumloopErrorOptions {
  status?: number;
  code?: string;
  body?: unknown;
  requestId?: string;
  cause?: unknown;
}
/** HTTP/protocol failures. In-band stream error events are yielded unchanged. */
export class GumloopError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly body?: unknown;
  readonly requestId?: string;
  constructor(message: string, options: GumloopErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'GumloopError';
    this.status = options.status;
    this.code = options.code;
    this.body = options.body;
    this.requestId = options.requestId;
  }
}
