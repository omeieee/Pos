import {
  type Slip2goReceiver,
  satangToSlip2goAmount,
  slip2goAmountToSatang,
  slip2goResponseSchema,
} from '@sds/shared';
import { z } from 'zod';

/**
 * The Slip2Go client (D-27): a paid service that checks a transfer slip against the bank's records.
 * It sends the slip's QR text first (no picture leaves the machine) and the picture only when no QR
 * could be read. Facts proven against the live service (docs/plans/slip2go-integration.md, 11):
 * the QR-text call answers HTTP 200 and the image call HTTP 201, so the answer is read by its
 * `code`, never by the HTTP status; the image call takes the conditions at the root of `payload`.
 *
 * What this module never does: throw for a network, timeout, 429 or 5xx failure (it is a
 * `transient` result), keep or return names and accounts (the parse picks the few fields we need),
 * or log anything but `{code, ms}` (never the key, the URL, a body or the QR text).
 */

/** What a slip must satisfy; the checker builds it from the payment, the order and the settings. */
export interface VerifyConditions {
  /** This payment's own amount (a top-up charges only the difference). */
  amountSatang: number;
  receivers: readonly Slip2goReceiver[];
  /** The transfer must be at or after this instant. */
  notBefore: Date;
}

export type VerifyResult =
  /** Slip2Go answered (any code, including its errors). Branch on `code`. */
  | {
      kind: 'answer';
      code: string;
      referenceId?: string;
      transRef?: string;
      /** The sending bank's 3-digit code, to build the duplicate key with `transRef`. */
      senderBank?: string;
      /** `data.amount` in satang, or null when absent or not a clean baht figure. */
      amountSatang?: number | null;
      dateTime?: string;
    }
  /** Network, timeout, rate limit or server error: worth trying again later. */
  | { kind: 'transient' };

export type AccountInfoResult =
  | { kind: 'info'; estimatedQuotaSlip: number | null; packageExpiredDate: string | null }
  | { kind: 'failed'; code?: string };

export interface SlipVerifier {
  verifyQr(qr: string, conditions: VerifyConditions): Promise<VerifyResult>;
  verifyImage(bytes: Uint8Array, mime: string, conditions: VerifyConditions): Promise<VerifyResult>;
  /** Not charged. Used by the daily quota check. */
  accountInfo(): Promise<AccountInfoResult>;
}

export interface Slip2goConfig {
  baseUrl: string;
  /** Secret: never logged, never in an error. */
  secretKey: string;
  timeoutMs: number;
  /** `{code, ms}` only. */
  log?: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
  };
}

const conditionObject = (c: VerifyConditions) => ({
  checkAmount: { type: 'eq', amount: satangToSlip2goAmount(c.amountSatang) },
  checkReceiver: c.receivers.map((r) => ({
    accountType: r.accountType,
    accountNumber: r.accountNumber,
  })),
  checkDate: { type: 'gte', date: c.notBefore.toISOString() },
});

const accountInfoSchema = z.object({
  code: z.string(),
  data: z
    .object({
      estimatedQuotaSlip: z.number().optional(),
      packageExpiredDate: z.string().optional(),
    })
    .optional(),
});

// One verifier per process, installed by `server.ts`: the daily account-check job reads it here.
// Without one (SLIP_VERIFIER=off, tests) the job does nothing.
let installed: SlipVerifier | null = null;

export const installSlipVerifier = (verifier: SlipVerifier | null): void => {
  installed = verifier;
};
export const activeSlipVerifier = (): SlipVerifier | null => installed;

export function createSlip2goVerifier(
  config: Slip2goConfig,
  fetchImpl: typeof fetch = fetch,
): SlipVerifier {
  const base = config.baseUrl.replace(/\/+$/, '');

  /** One request. Never throws: a failure is `{ failure }` with a fixed word. */
  async function send(
    path: string,
    init: { method: 'GET' | 'POST'; body?: string | FormData; json?: boolean },
  ): Promise<
    { ok: true; status: number; text: string; ms: number } | { ok: false; why: string; ms: number }
  > {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetchImpl(`${base}${path}`, {
        method: init.method,
        headers: {
          authorization: `Bearer ${config.secretKey}`,
          ...(init.json ? { 'content-type': 'application/json' } : {}),
        },
        ...(init.body !== undefined ? { body: init.body } : {}),
        signal: controller.signal,
      });
      const text = await response.text();
      return { ok: true, status: response.status, text, ms: Date.now() - started };
    } catch {
      // The reason is a fixed word: an error message could carry the URL or the key.
      return {
        ok: false,
        why: controller.signal.aborted ? 'timeout' : 'network',
        ms: Date.now() - started,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  function readAnswer(reply: Awaited<ReturnType<typeof send>>): VerifyResult {
    if (!reply.ok) {
      config.log?.warn({ code: reply.why, ms: reply.ms }, 'slip2go');
      return { kind: 'transient' };
    }
    let parsed: z.ZodSafeParseResult<z.infer<typeof slip2goResponseSchema>>;
    try {
      parsed = slip2goResponseSchema.safeParse(JSON.parse(reply.text));
    } catch {
      parsed = slip2goResponseSchema.safeParse(undefined);
    }
    if (!parsed.success) {
      const transient = reply.status === 429 || reply.status >= 500;
      config.log?.warn(
        { code: transient ? `http_${reply.status}` : 'invalid_response', ms: reply.ms },
        'slip2go',
      );
      return transient ? { kind: 'transient' } : { kind: 'answer', code: 'invalid_response' };
    }
    const { code, data } = parsed.data;
    config.log?.info({ code, ms: reply.ms }, 'slip2go');
    return {
      kind: 'answer',
      code,
      ...(data?.referenceId ? { referenceId: data.referenceId } : {}),
      ...(data?.transRef ? { transRef: data.transRef } : {}),
      ...(data?.sender?.bank?.id ? { senderBank: data.sender.bank.id } : {}),
      ...(data?.amount !== undefined ? { amountSatang: slip2goAmountToSatang(data.amount) } : {}),
      ...(data?.dateTime ? { dateTime: data.dateTime } : {}),
    };
  }

  return {
    async verifyQr(qr, conditions) {
      const body = JSON.stringify({
        payload: { qrCode: qr, checkCondition: conditionObject(conditions) },
      });
      return readAnswer(
        await send('/api/verify-slip/qr-code/info', { method: 'POST', body, json: true }),
      );
    },
    async verifyImage(bytes, mime, conditions) {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), 'slip');
      form.append('payload', JSON.stringify(conditionObject(conditions)));
      return readAnswer(
        await send('/api/verify-slip/qr-image/info', { method: 'POST', body: form }),
      );
    },
    async accountInfo() {
      const reply = await send('/api/account/info', { method: 'GET' });
      if (!reply.ok) {
        config.log?.warn({ code: reply.why, ms: reply.ms }, 'slip2go');
        return { kind: 'failed' };
      }
      let parsed: z.ZodSafeParseResult<z.infer<typeof accountInfoSchema>>;
      try {
        parsed = accountInfoSchema.safeParse(JSON.parse(reply.text));
      } catch {
        parsed = accountInfoSchema.safeParse(undefined);
      }
      if (!parsed.success) return { kind: 'failed' };
      config.log?.info({ code: parsed.data.code, ms: reply.ms }, 'slip2go');
      if (parsed.data.code !== '200001') return { kind: 'failed', code: parsed.data.code };
      return {
        kind: 'info',
        estimatedQuotaSlip: parsed.data.data?.estimatedQuotaSlip ?? null,
        packageExpiredDate: parsed.data.data?.packageExpiredDate ?? null,
      };
    },
  };
}
