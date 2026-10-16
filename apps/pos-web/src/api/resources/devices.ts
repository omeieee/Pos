/** Typed API client: this device: register and outbox recovery. */
import {
  idParamSchema,
  type OutboxRecoveryInput,
  outboxRecoveryInputSchema,
  outboxRecoveryResponseSchema,
} from '@sds/shared';
import { checked, newClientRequestId, type Transport } from '../http.ts';

export function makeDevices({ post }: Transport) {
  const devices = {
    /**
     * The owner reports that they took over or cleared the entries another person left in this
     * device's offline outbox, so the server can audit it (counts only, never contents). Owner only,
     * fresh step-up (`auth.runSensitive`). A retry with the same `clientRequestId` answers 200 and
     * writes nothing more; the same id with other counts is 409 IDEMPOTENCY_KEY_REUSED.
     */
    outboxRecovery: async (
      deviceId: string,
      input: Omit<OutboxRecoveryInput, 'clientRequestId'>,
      options?: { clientRequestId?: string },
    ) => {
      const clientRequestId = options?.clientRequestId ?? newClientRequestId();
      const { data, status } = await post({
        path: `/v1/devices/${checked(idParamSchema, { id: deviceId }).id}/outbox-recovery`,
        body: checked(outboxRecoveryInputSchema, { ...input, clientRequestId }),
        schema: outboxRecoveryResponseSchema,
        session: true,
        device: 'optional',
      });
      return { result: data, replay: status === 200, clientRequestId };
    },
  };

  return devices;
}
