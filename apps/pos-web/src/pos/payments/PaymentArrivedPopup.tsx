import { formatBaht } from '@sds/i18n';
import { useState } from 'react';
import { Gi } from '../../design/icons.tsx';
import { apiUrl } from '../../platform/config.ts';
import {
  useAuthState,
  useEntities,
  useHasPermission,
  useLocale,
  useServices,
  useStoreState,
  useT,
} from '../../ui/hooks.ts';
import { Modal } from '../../ui/Modal.tsx';
import { localName } from '../cart/names.ts';
import { LineWho } from '../kitchen/KitchenTicket.tsx';
import { buildPopupContent, type PopupDish } from './payment-popup-model.ts';

/** A dish photo from the shop's own menu; a plain bowl when it has none or does not load. */
function DishPhoto({ path }: { path: string | null }) {
  const [broken, setBroken] = useState(false);
  return (
    <span className="ppop__photo" aria-hidden="true">
      {path && !broken ? (
        <img src={apiUrl(path)} alt="" loading="lazy" onError={() => setBroken(true)} />
      ) : (
        <Gi n="bowl" />
      )}
    </span>
  );
}

function Dish({ dish }: { dish: PopupDish }) {
  const locale = useLocale();
  return (
    <li className="ppop__dish">
      <DishPhoto path={dish.photoPath} />
      <span className="ppop__qty g-num">{dish.qty}×</span>
      <span className="ppop__dishname">{localName(locale, dish.nameTh, dish.nameEn)}</span>
    </li>
  );
}

/**
 * The big window that says a payment arrived (D-42): an order is paid (green), or a slip waits for
 * a person to check it (amber). Mounted once in the app for a signed-in person; it shows the first
 * of the queue (`paymentPopup`), and the next one takes its place when this one is closed. It reads
 * the order from the store the alert already filled: only ids travel in the alert. What it shows
 * is chosen by `buildPopupContent` (no phone, room or note); the total only for a role that works
 * with money. Nothing here confirms a payment: "ตรวจสลิป" only opens the order page.
 */
export function PaymentArrivedPopup() {
  const { paymentPopup } = useServices();
  const { enabled, queue } = useStoreState(paymentPopup);
  const { phase } = useAuthState();
  const entities = useEntities();
  const canSeeMoney = useHasPermission('payment.record');
  const canConfirm = useHasPermission('payment.confirm');
  const locale = useLocale();
  const tr = useT();

  const entry = queue[0];
  if (phase !== 'signedIn' || !enabled || !entry) return null;

  const content = buildPopupContent(
    entry,
    entities.orders.get(entry.orderId),
    entities.items,
    canSeeMoney,
  );
  const review = content.kind === 'slip_review';
  const waiting = queue.length - 1;
  const dismiss = () => paymentPopup.dismiss();
  const open = canConfirm || !review ? `#/orders/${content.orderId}` : null;

  const viewLink = open ? (
    <a className={`g-btn g-btn-lg ${review ? 'g-btn-p' : ''}`} href={open} onClick={dismiss}>
      <Gi n={review ? 'receipt' : 'eye'} />
      {tr(review ? 'payPopup.checkSlip' : 'payPopup.viewOrder')}
    </a>
  ) : null;
  const okButton = (
    <button
      type="button"
      className={`g-btn g-btn-lg ${review ? '' : 'g-btn-ok'}`}
      onClick={dismiss}
    >
      {tr('payPopup.ok')}
    </button>
  );

  return (
    <Modal
      key={`${entry.orderId}:${entry.kind}`}
      labelledBy="ppop-title"
      onClose={dismiss}
      variant="payment"
    >
      <div className={`ppop ppop--${content.kind}`} data-testid="payment-popup">
        <div className="ppop__head">
          <Gi n={review ? 'receipt' : 'check'} size="lg" />
          <h2 id="ppop-title" className="ppop__title">
            {tr(`payPopup.title.${content.kind}`)}
          </h2>
          <span className="ppop__no g-num">{content.orderNo}</span>
        </div>
        <div className="ppop__body">
          <p className="ppop__hint" role="status">
            {tr(`payPopup.hint.${content.kind}`)}
          </p>
          {content.loaded ? (
            <>
              <div className="ppop__who">
                {content.line ? <LineWho line={content.line} /> : null}
                {content.recipientName ? (
                  <span>
                    <span className="visually-hidden">{tr('payPopup.recipient')}: </span>
                    {content.recipientName}
                  </span>
                ) : null}
                {content.deliveryBuilding ? (
                  <span className="ppop__where">
                    {tr('payPopup.building', { building: content.deliveryBuilding })}
                  </span>
                ) : null}
              </div>
              <ul className="ppop__dishes" aria-label={tr('payPopup.items')}>
                {content.dishes.map((dish) => (
                  <Dish key={dish.id} dish={dish} />
                ))}
              </ul>
              {content.totalSatang === null ? null : (
                <div className="ppop__total">
                  <span>{tr('payPopup.total')}</span>
                  <span className="ppop__total-amount g-num">
                    {formatBaht(content.totalSatang, locale)}
                  </span>
                </div>
              )}
            </>
          ) : (
            <p className="g-t-s" style={{ margin: 0 }}>
              {tr('payPopup.noOrder')}
            </p>
          )}
          {waiting > 0 ? (
            <p className="ppop__more" role="status">
              {tr('payPopup.more', { count: waiting })}
            </p>
          ) : null}
        </div>
        <div className="ppop__actions">
          {review ? viewLink : okButton}
          {review ? okButton : viewLink}
        </div>
      </div>
    </Modal>
  );
}
