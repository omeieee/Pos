/** Typed API client: the sync feed catch-up. */
import { syncQuerySchema, syncResponseSchema } from '@sds/shared';
import type { z } from 'zod';
import { checked, type Transport } from '../http.ts';

export function makeSync({ get }: Transport) {
  const sync = {
    /** One page of changes newer than `since`, the same frames the socket pushes. */
    changes: async (query: z.input<typeof syncQuerySchema>) => {
      const parsed = checked(syncQuerySchema, query);
      return (
        await get({
          path: '/v1/sync',
          query: { since: String(parsed.since), limit: String(parsed.limit) },
          schema: syncResponseSchema,
          session: true,
          device: 'optional',
        })
      ).data;
    },
  };

  return sync;
}
