/** Typed API client: saved delivery recipients. */
import { recipientsQuerySchema, recipientsResponseSchema } from '@sds/shared';
import type { z } from 'zod';
import { checked, type Transport } from '../http.ts';

export function makeRecipients({ get }: Transport) {
  const recipients = {
    /**
     * Remembered recipients, most recent first, for the order screen. `q` is the name staff typed
     * (personal data): it travels in the query only, and no error or log line ever repeats it.
     */
    list: async (query: z.input<typeof recipientsQuerySchema> = {}) => {
      const parsed = checked(recipientsQuerySchema, query);
      return (
        await get({
          path: '/v1/recipients',
          query: {
            ...(parsed.q ? { q: parsed.q } : {}),
            ...(parsed.building ? { building: parsed.building } : {}),
            limit: String(parsed.limit),
          },
          schema: recipientsResponseSchema,
          session: true,
          device: 'optional',
        })
      ).data;
    },
  };

  return recipients;
}
