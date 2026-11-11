import {
  competitorIdSchema,
  competitorSchema,
  createCompetitorSchema,
  snapshotSchema,
} from '@rounds/shared';

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const timeout = AbortSignal.timeout(15_000);
  try {
    const response = await fetch(`/api${path}`, {
      ...init,
      signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
      headers: { ...init.headers, Accept: 'application/json' },
    });
    if (!response.ok) {
      const messages: Record<number, string> = {
        400: 'The request is not valid. Check the competitor ID and try again.',
        404: 'This competitor could not be found.',
        429: 'Too many requests. Please wait a moment and try again.',
      };
      throw new ApiError(
        messages[response.status] ?? 'The service is unavailable. Please try again.',
        response.status,
      );
    }
    return response;
  } catch (error) {
    if (init.signal?.aborted) throw error;
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      timeout.aborted
        ? 'The request timed out. Please try again.'
        : 'Could not connect to the server. Check your connection and try again.',
    );
  }
}

async function readJson<T>(
  response: Response,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
): Promise<T> {
  try {
    const result = schema.safeParse(await response.json());
    if (result.success) return result.data;
  } catch {
    /* An invalid or interrupted response is not usable application data. */
  }
  throw new ApiError('The server returned an unexpected response. Please try again.');
}

export const api = {
  competitors: async (signal?: AbortSignal) =>
    readJson(await request('/competitors', { signal }), competitorSchema.array()),
  addCompetitor: async (input: { id: string }) => {
    const validated = createCompetitorSchema.parse(input);
    const response = await request('/competitors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validated),
    });
    const competitor = await readJson(response, createCompetitorSchema);
    return { ...competitor, created: response.status === 201 };
  },
  removeCompetitor: async (id: string) => {
    await request(`/competitors/${encodeURIComponent(competitorIdSchema.parse(id))}`, {
      method: 'DELETE',
    });
  },
  snapshots: async (id: string, cursor?: string, signal?: AbortSignal) => {
    const params = new URLSearchParams({ limit: '20' });
    if (cursor) params.set('cursor', cursor);
    const response = await request(
      `/competitors/${encodeURIComponent(competitorIdSchema.parse(id))}/snapshots?${params}`,
      { signal },
    );
    const snapshots = await readJson(response, snapshotSchema.array());
    const nextCursor = response.headers.get('X-Next-Cursor');
    if (nextCursor && (!/^[A-Za-z0-9_-]+$/.test(nextCursor) || nextCursor.length > 512)) {
      throw new ApiError('The server returned an invalid history cursor. Please refresh the page.');
    }
    const active = response.headers.get('X-Tracking-Active');
    if (active !== null && active !== 'true' && active !== 'false')
      throw new ApiError(
        'The server returned an invalid tracking status. Please refresh the page.',
      );
    return {
      snapshots,
      nextCursor: nextCursor || undefined,
      active: active === null ? undefined : active === 'true',
    };
  },
};

export function shouldRetry(failureCount: number, error: Error): boolean {
  return (
    failureCount < 1 &&
    (!(error instanceof ApiError) || error.status === null || error.status >= 500)
  );
}
