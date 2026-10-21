/**
 * The agent's two calls to the POS API, both authenticated by the `x-device-token` header.
 * It polls (`/v1/print/claim`) and reports (`/v1/print/jobs/:id/ack`); nothing connects in.
 */
import { type ClaimedPrintJob, claimPrintJobResponseSchema, type PrintAckInput } from '@sds/shared';

/**
 * - `unreachable`: no answer, a timeout, a 5xx/429 or an unreadable answer; try again later.
 * - `auth`: 401/403, the token was refused; retrying fast will not help.
 * - `rejected`: any other 4xx (the job is gone, the lease was lost); the call will never succeed.
 */
export type ApiFailureKind = 'unreachable' | 'auth' | 'rejected';

export class ApiCallError extends Error {
  readonly kind: ApiFailureKind;
  readonly status: number | null;
  constructor(kind: ApiFailureKind, status: number | null) {
    super(`API call failed: ${kind}${status === null ? '' : ` (${status})`}`);
    this.name = 'ApiCallError';
    this.kind = kind;
    this.status = status;
  }
}

export interface PrintApi {
  /** The next job, or null when nothing is waiting. */
  claim(): Promise<ClaimedPrintJob | null>;
  ack(jobId: string, input: PrintAckInput): Promise<void>;
}

export function createPrintApi(options: {
  baseUrl: string;
  token: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): PrintApi {
  const fetchImpl = options.fetchImpl ?? fetch;

  async function post(path: string, body: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(`${options.baseUrl}/v1${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-device-token': options.token },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch {
      throw new ApiCallError('unreachable', null);
    }
    if (response.status === 401 || response.status === 403) {
      throw new ApiCallError('auth', response.status);
    }
    if (response.status >= 500 || response.status === 429) {
      throw new ApiCallError('unreachable', response.status);
    }
    if (!response.ok) throw new ApiCallError('rejected', response.status);
    try {
      return await response.json();
    } catch {
      throw new ApiCallError('unreachable', response.status);
    }
  }

  return {
    async claim() {
      const parsed = claimPrintJobResponseSchema.safeParse(await post('/print/claim', {}));
      // An answer we cannot read (an old or new server) is treated like no answer.
      if (!parsed.success) throw new ApiCallError('unreachable', 200);
      return parsed.data.job;
    },
    async ack(jobId, input) {
      await post(`/print/jobs/${encodeURIComponent(jobId)}/ack`, input);
    },
  };
}
