import { formatDate } from '@sds/i18n';
import { Gi, type GiName } from '../design/icons.tsx';
import { s } from '../design/style.ts';
import { useEntities, useLocale, useT } from '../ui/hooks.ts';
import { govCopayScheme, type MethodOption, type PayMethod } from './payment-model.ts';
import './pay-glass.css';

const METHOD_ICON: Record<PayMethod, GiName> = {
  cash: 'cash',
  promptpay: 'qrBig',
  gov_copay: 'bank',
  platform: 'store',
};

/** The order the design lists them in. */
const DESIGN_ORDER: readonly PayMethod[] = ['promptpay', 'cash', 'gov_copay', 'platform'];

/**
 * The payment methods as the design's segmented switch (พร้อมเพย์ · เงินสด · ไทยช่วยไทย). It is a
 * radio group. A method that cannot be used is shown disabled (never silently gone) and its reason
 * is written out by `MethodNotes`; ไทยช่วยไทย shows the scheme's last day there. `locked` keeps the
 * chosen method lit and the rest off: a payment is already waiting, and changing the method is its
 * own action.
 */
export function MethodTiles({
  options,
  choice,
  name,
  onChoose,
  locked = false,
  fill = false,
  disabled = false,
}: {
  options: readonly MethodOption[];
  choice: PayMethod | null;
  name: string;
  onChoose: (method: PayMethod) => void;
  locked?: boolean;
  /** Stretch the switch over the whole line (a phone, a dialog). */
  fill?: boolean;
  /** Every choice is off (another order's payment is being saved). */
  disabled?: boolean;
}) {
  const tr = useT();
  const sorted = [...options].sort(
    (a, b) => DESIGN_ORDER.indexOf(a.method) - DESIGN_ORDER.indexOf(b.method),
  );
  return (
    <fieldset
      className="g-seg pay-seg"
      style={s(`border:0;margin:0;min-width:0;${fill ? 'display:flex;width:100%;' : 'flex:none;'}`)}
    >
      <legend className="visually-hidden">{tr('payment.methodsLabel')}</legend>
      {sorted.map((option) => {
        const on = choice === option.method;
        return (
          <label
            key={option.method}
            className={`g-chip${on ? ' g-on' : ''}`}
            style={s(fill ? 'flex:1;padding:0 8px;gap:6px' : '')}
          >
            <input
              type="radio"
              name={name}
              disabled={disabled || !option.enabled || (locked && !on)}
              checked={on}
              onChange={() => onChoose(option.method)}
            />
            <Gi n={METHOD_ICON[option.method]} size="sm" />
            {tr(`payment.method.${option.method}`)}
          </label>
        );
      })}
    </fieldset>
  );
}

/**
 * One quiet line per method that has something to say: why a method is switched off, or the last
 * day of ไทยช่วยไทย. The words are the app's rule, so they are never dropped for the sake of the
 * switch being small.
 */
export function MethodNotes({
  options,
  choice,
}: {
  options: readonly MethodOption[];
  /** The method on screen; the scheme's last day is only told while ไทยช่วยไทย is. */
  choice: PayMethod | null;
}) {
  const tr = useT();
  const locale = useLocale();
  const scheme = govCopayScheme(useEntities().settings);
  const lines = options.flatMap((option) => {
    if (!option.enabled) {
      return [
        { method: option.method, text: tr(`payment.copay.reason.${option.reason}`), off: true },
      ];
    }
    if (option.method === 'gov_copay' && scheme && choice === 'gov_copay') {
      return [
        {
          method: option.method,
          text: tr('payment.method.govCopaySub', {
            date: formatDate(scheme.activeTo, locale, 'date'),
          }),
          off: false,
        },
      ];
    }
    return [];
  });
  if (lines.length === 0) return null;
  return (
    <ul style={s('list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:2px 16px')}>
      {lines.map((line) => (
        <li
          key={line.method}
          className="g-t-c"
          style={s('display:flex;gap:6px;align-items:baseline')}
        >
          <b style={s('font-weight:600;color:var(--ink2);white-space:nowrap')}>
            {tr(`payment.method.${line.method}`)}
          </b>
          <span>{line.text}</span>
        </li>
      ))}
    </ul>
  );
}
