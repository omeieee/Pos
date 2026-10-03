import { type Db, lineRepo } from '@sds/db';
import { followGreeting, type LineSender, privacyAcknowledged, type RoutedEvent } from '@sds/line';
import { PRIVACY_NOTICE_VERSION } from '@sds/shared';
import type { LineRuntime } from './runtime.ts';

export interface HandlerContext {
  db: Db;
  sender: LineSender;
  now: () => Date;
  noticeUrl: string | undefined;
  privacy: LineRuntime['privacy'];
}

/**
 * What the API does for one routed event in this slice: new and returning followers, unfollows
 * and the privacy acknowledgement. Ordering, "โอนแล้ว", slips and keywords come with the
 * ordering flow; until then they are acknowledged to LINE and left for staff in OA Manager.
 *
 * Nothing here logs the event: it holds the LINE user id and what the customer typed.
 */
export async function handleEvent(ctx: HandlerContext, event: RoutedEvent): Promise<void> {
  switch (event.kind) {
    case 'follow': {
      const customerId = await lineRepo.upsertFollower(ctx.db, event.userId);
      // Following is not acknowledging: the notice is shown and the customer taps to confirm.
      await ctx.sender.reply(
        event.replyToken,
        followGreeting({
          controller: ctx.privacy.controller,
          contactEmail: ctx.privacy.contactEmail,
          ...(ctx.noticeUrl ? { noticeUrl: ctx.noticeUrl } : {}),
        }),
        { template: 'follow_greeting', customerId },
      );
      return;
    }
    case 'unfollow':
      await lineRepo.markUnfollowed(ctx.db, event.userId, ctx.now());
      return;
    case 'ack_privacy': {
      const customerId = await lineRepo.acknowledgePrivacy(
        ctx.db,
        event.userId,
        ctx.now(),
        PRIVACY_NOTICE_VERSION,
      );
      if (event.replyToken) {
        await ctx.sender.reply(event.replyToken, [privacyAcknowledged()], {
          template: 'privacy_ack',
          customerId,
        });
      }
      return;
    }
    default:
      return;
  }
}
