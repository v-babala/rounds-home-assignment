export class ExternalError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number | null = null,
    public readonly retryAfterMs = 0,
  ) {
    super(code);
  }
}

export function normalizeRetryAfterMs(delay: number, now = Date.now()): number {
  const bounded = Math.max(1000, delay);
  // A finite delay can still overflow Date's supported timestamp range.
  return Number.isFinite(new Date(now + bounded).getTime()) ? bounded : 1000;
}

export function retryAfterMs(value: string | null, now = Date.now()): number {
  if (value === null) return 1000;
  const seconds = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return normalizeRetryAfterMs(delay, now);
}

// The timeout covers headers AND body; the size limit also applies to streamed responses.
export async function requestJson(
  url: string,
  timeoutMs: number,
  signal: AbortSignal,
  init: RequestInit = {},
): Promise<unknown> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = AbortSignal.any([signal, timeout]);
  try {
    const response = await fetch(url, { ...init, redirect: 'error', signal: combined });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ExternalError(
        'http_error',
        response.status,
        response.status === 429 ? retryAfterMs(response.headers.get('retry-after')) : 0,
      );
    }
    if (!response.body) throw new ExternalError('invalid_json', response.status);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 256 * 1024) {
        await reader.cancel();
        throw new ExternalError('response_too_large', response.status);
      }
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      throw new ExternalError('invalid_json', response.status);
    }
  } catch (error) {
    if (error instanceof ExternalError) throw error;
    if (signal.aborted) throw new ExternalError('interrupted');
    if (timeout.aborted) throw new ExternalError('timeout');
    throw new ExternalError('network_error');
  }
}

export function backoffMs(attempt: number, base = 1000): number {
  return Math.min(300_000, base * 2 ** Math.min(attempt - 1, 8)) * (1 + Math.random() * 0.2);
}

export class SourceLimiter {
  private nextStart = 0;
  constructor(
    private readonly requestsPerSecond: number,
    private readonly clock = Date.now,
  ) {}
  get ready(): boolean {
    return this.clock() >= this.nextStart;
  }
  started(): void {
    this.nextStart = this.clock() + Math.ceil(1000 / this.requestsPerSecond);
  }
  pause(ms: number): void {
    this.nextStart = Math.max(this.nextStart, this.clock() + ms);
  }
}
