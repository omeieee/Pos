import { Gi, type GiName } from '../design/icons.tsx';
import { s } from '../design/style.ts';
import {
  MEMBER_LIMITS,
  type MemberField,
  type MemberForm,
  memberProblems,
} from '../model/member.ts';
import { useT } from './app-context.tsx';
import { Notice, SectionLabel } from './Chrome.tsx';

const FIELDS: readonly { field: MemberField; icon: GiName; type: string; mode?: 'tel' }[] = [
  { field: 'fullName', icon: 'user', type: 'text' },
  { field: 'nickname', icon: 'user', type: 'text' },
  { field: 'building', icon: 'building', type: 'text' },
  { field: 'phone', icon: 'phone', type: 'tel', mode: 'tel' },
];

/**
 * The optional member form of the checkout (owner, 2026-10-11): none of it is required to order.
 * It only edits the form; the screen decides what to send and the server cleans and saves it.
 */
export function MemberSection({
  value,
  onChange,
  showErrors,
}: {
  value: MemberForm;
  onChange: (next: MemberForm) => void;
  showErrors: boolean;
}) {
  const tr = useT();
  const bad = showErrors ? memberProblems(value) : [];
  return (
    <section className="g-rise" aria-labelledby="co-member" style={s('--d:.1s')}>
      <SectionLabel id="co-member">{tr('liff.member.title')}</SectionLabel>
      <div
        className="g-glass"
        style={s(
          'border-radius:28px;padding:14px 16px;display:flex;flex-direction:column;gap:10px',
        )}
      >
        {FIELDS.map(({ field, icon, type, mode }) => (
          <label key={field} className="g-field" style={s('height:48px')}>
            <Gi n={icon} size="sm" />
            <input
              type={type}
              inputMode={mode}
              value={value[field]}
              maxLength={field === 'phone' ? 40 : MEMBER_LIMITS[field]}
              autoComplete={field === 'phone' ? 'tel' : 'off'}
              aria-label={tr(`liff.member.${field}`)}
              aria-invalid={bad.includes(field) || undefined}
              placeholder={tr(`liff.member.${field}`)}
              onChange={(e) => onChange({ ...value, [field]: e.target.value })}
            />
          </label>
        ))}
        {bad.includes('phone') ? (
          <Notice tone="bad" icon="warn" alert>
            {tr('liff.member.phoneBad')}
          </Notice>
        ) : null}
        <div
          className="g-t-c"
          style={s('display:flex;gap:7px;align-items:flex-start;line-height:1.5')}
        >
          <Gi n="info" style={{ width: 14, height: 14, marginTop: 3 }} />
          <span>
            {tr('liff.member.note')}{' '}
            <details style={s('display:inline')}>
              <summary style={s('display:inline;cursor:pointer;text-decoration:underline')}>
                {tr('liff.member.privacy')}
              </summary>
              <p style={s('margin:6px 0 0')}>{tr('liff.privacy.body')}</p>
            </details>
          </span>
        </div>
      </div>
    </section>
  );
}
