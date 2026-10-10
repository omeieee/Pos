import type { MemberProfile } from '@sds/shared';
import { Gi } from '../design/icons.tsx';
import { s } from '../design/style.ts';
import { useStaffRole, useT } from '../ui/hooks.ts';
import { memberView } from './member-model.ts';

/**
 * Who the order is for, from the optional details the customer gave. Shows nothing when they gave
 * none. The role comes from the session, so the kitchen never sees the phone number.
 */
export function MemberLine({ member }: { member: MemberProfile | null | undefined }) {
  const tr = useT();
  const view = memberView(member, useStaffRole());
  if (!view) return null;
  return (
    <div
      className="g-t-s"
      data-testid="member-line"
      style={s('display:flex;gap:8px;align-items:flex-start')}
    >
      <Gi n="user" size="sm" style={s('margin-top:2px;flex:none')} />
      <span style={s('min-width:0')}>
        <span className="visually-hidden">{tr('order.member.label')}: </span>
        {view.who}
        {view.phone ? (
          <span className="g-num" style={s('display:block')}>
            {tr('order.member.phone', { phone: view.phone })}
          </span>
        ) : null}
      </span>
    </div>
  );
}
