import { s } from '../../design/style.ts';
import { useServices, useStoreState, useT } from '../../ui/hooks.ts';

/**
 * The per-device switch of the payment pop-up (D-42), next to the sound switch of the kitchen view
 * and on the phone alerts page. Same markup as `SoundControl`: a real checkbox with `role="switch"`,
 * a label of at least 48 px, and the state told in words for a screen reader. The choice is
 * remembered on this device and is on until someone turns it off.
 */
export function PaymentPopupSwitch() {
  const { paymentPopup } = useServices();
  const { enabled } = useStoreState(paymentPopup);
  const tr = useT();
  return (
    <fieldset className="ksound" style={s('border:0;margin:0;padding:0;min-width:0')}>
      <legend className="visually-hidden">{tr('payPopup.switch')}</legend>
      <label
        className="g-t-s"
        style={s('display:flex;align-items:center;gap:10px;min-height:48px;cursor:pointer')}
      >
        <input
          type="checkbox"
          role="switch"
          aria-checked={enabled}
          className="g-sw"
          checked={enabled}
          onChange={() => void paymentPopup.setEnabled(!enabled)}
        />
        {tr('payPopup.switchShort')}
      </label>
      <span role="status" aria-live="polite" className="visually-hidden">
        {tr(enabled ? 'payPopup.state.on' : 'payPopup.state.off')}
      </span>
    </fieldset>
  );
}
