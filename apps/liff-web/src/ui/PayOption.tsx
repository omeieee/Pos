import type { AppPayMethod } from '@sds/shared';
import { Gi, type GiName } from '../design/icons.tsx';
import { s } from '../design/style.ts';
import { useT } from './app-context.tsx';

/** The payment cards of the checkout board: icon colour, title and one line, as the design draws them. */
const LOOK: Record<AppPayMethod, { icon: GiName; colour: string }> = {
  promptpay: { icon: 'qr', colour: '#2457b8' },
  cash: { icon: 'cash', colour: '#1b7a43' },
  gov_copay: { icon: 'bank', colour: '#c7691a' },
};

/** The order the board shows them in, whatever order the server lists them. */
export const METHOD_ORDER: readonly AppPayMethod[] = ['promptpay', 'cash', 'gov_copay'];

export function PayBody({ method }: { method: AppPayMethod }) {
  const tr = useT();
  const look = LOOK[method];
  return (
    <>
      <div className="g-ico" aria-hidden="true" style={s(`background:${look.colour}`)}>
        <Gi n={look.icon} size="sm" />
      </div>
      <div style={s('flex-grow:1;min-width:0')}>
        <div className="g-t-3" style={s('font-size:15px')}>
          {tr(`liff.method.title.${method}`)}
        </div>
        <div className="g-t-c">{tr(`liff.method.sub.${method}`)}</div>
      </div>
      <span className="rd" aria-hidden="true" />
    </>
  );
}

/** A radio card (checkout). The native radio fills the card, so the whole card is the target. */
export function PayRadio({
  method,
  checked,
  onChange,
}: {
  method: AppPayMethod;
  checked: boolean;
  onChange: () => void;
}) {
  const tr = useT();
  return (
    <label className="pay">
      <input
        type="radio"
        name="pay"
        checked={checked}
        onChange={onChange}
        aria-label={tr(`liff.method.title.${method}`)}
      />
      <PayBody method={method} />
    </label>
  );
}

/** The same card as a button (changing the method on an order that already exists). */
export function PayButton({
  method,
  current,
  busy,
  onPick,
}: {
  method: AppPayMethod;
  current: boolean;
  busy: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      className="pay"
      aria-pressed={current}
      disabled={busy || current}
      onClick={onPick}
    >
      <PayBody method={method} />
    </button>
  );
}
