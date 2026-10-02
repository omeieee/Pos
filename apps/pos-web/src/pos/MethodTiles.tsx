import { formatDate } from '@sds/i18n';
import { useEntities, useLocale, useT } from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';
import { govCopayScheme, type MethodOption, type PayMethod } from './payment-model.ts';

const METHOD_ICON = { cash: 'cash', promptpay: 'qr', gov_copay: 'hands' } as const;

/**
 * The payment methods as a group of large radio tiles. A method that cannot be used is shown
 * disabled with its reason (never silently gone); ไทยช่วยไทย shows the scheme's last day.
 */
export function MethodTiles({
  options,
  choice,
  name,
  onChoose,
}: {
  options: readonly MethodOption[];
  choice: PayMethod | null;
  name: string;
  onChoose: (method: PayMethod) => void;
}) {
  const tr = useT();
  const locale = useLocale();
  const scheme = govCopayScheme(useEntities().settings);
  return (
    <fieldset className="methods">
      <legend className="label">{tr('payment.methodsLabel')}</legend>
      {options.map((option) => (
        <label
          key={option.method}
          className={`method${choice === option.method ? ' method--on' : ''}${option.enabled ? '' : ' method--off'}`}
        >
          <input
            className="visually-hidden"
            type="radio"
            name={name}
            disabled={!option.enabled}
            checked={choice === option.method}
            onChange={() => onChoose(option.method)}
          />
          <Icon name={METHOD_ICON[option.method]} />
          <span className="method__name">
            {tr(`payment.method.${option.method}`)}
            {!option.enabled ? (
              <span className="method__sub">{tr(`payment.copay.reason.${option.reason}`)}</span>
            ) : option.method === 'gov_copay' && scheme ? (
              <span className="method__sub">
                {tr('payment.method.govCopaySub', {
                  date: formatDate(scheme.activeTo, locale, 'date'),
                })}
              </span>
            ) : null}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
