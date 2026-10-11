import type { OrderDto } from '@sds/shared';
import { type ReactNode, useRef, useState } from 'react';
import { allowedRoutes } from '../app/routes.ts';
import { clockTime } from '../design/format.ts';
import { Gi, type GiName } from '../design/icons.tsx';
import { useLayout } from '../design/layout.ts';
import { s } from '../design/style.ts';
import { AccountMenu } from '../ui/AccountMenu.tsx';
import { useAuthState, useEntities, useNow, useT } from '../ui/hooks.ts';
import { SyncPill } from '../ui/SyncPill.tsx';
import { KitchenTicket } from './KitchenTicket.tsx';
import { handedOverToday, kitchenQueue, WAIT_WARN_MINUTES } from './kitchen-model.ts';
import { currentBusinessDay } from './order-board.ts';
import { SoundControl } from './SoundControl.tsx';
import { useKitchenDisplay } from './use-kitchen-display.ts';
import { useLoadOrders } from './use-load-orders.ts';

/**
 * Styles the inline `style` cannot carry (keyframes, the design's `.q` box and amber note). Every
 * colour is a token of the dark scope; the glow stops for people who asked for less motion.
 */
const BOARD_CSS = `
@keyframes kb-glow{0%,100%{box-shadow:0 0 0 0 rgba(110,160,255,0),var(--sh1)}50%{box-shadow:0 0 0 7px rgba(110,160,255,.28),var(--sh1)}}
.kb-ticket{padding:18px 18px 18px 26px;display:flex;flex-direction:column;gap:12px;position:relative;overflow:hidden}
.kb-ticket::before{content:"";position:absolute;left:0;top:0;bottom:0;width:10px;background:var(--kb-accent,var(--ink3))}
.kb-st-new{--kb-accent:var(--sky)}
.kb-st-cooking{--kb-accent:var(--amber)}
.kb-st-ready{--kb-accent:var(--jade)}
.kb-new{animation:kb-glow 2.4s ease-in-out infinite!important}
.kb-late{box-shadow:0 0 0 3px var(--chili),var(--sh1)!important}
.kb-stale{opacity:.62}
.kb-top{display:flex;align-items:baseline;gap:12px;justify-content:space-between}
.kb-no{margin:0;font-size:56px;line-height:1.05;font-weight:800;letter-spacing:-.01em}
.kb-wait{display:inline-flex;align-items:center;gap:6px;font-size:30px;line-height:1.1;font-weight:800;color:var(--ink2);white-space:nowrap}
.kb-wait[data-level="warn"]{color:var(--amber-ink)}
.kb-wait[data-level="late"]{color:var(--chili-ink)}
.kb-wait-stale{font-size:17px;font-weight:600;color:var(--ink3);white-space:normal;text-align:right}
.kb-where{display:flex;gap:10px;align-items:center;font-size:28px;font-weight:800;line-height:1.25;color:var(--ink)}
.kb-line{display:flex;gap:10px;align-items:center;font-size:22px;font-weight:600;line-height:1.3;color:var(--ink)}
.kb-pic{width:36px;height:36px;border-radius:50%;object-fit:cover;flex:none}
.kb-items{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:14px}
.kb-item{display:flex;gap:14px;align-items:flex-start}
.kb-q{min-width:58px;height:58px;border-radius:18px;display:grid;place-items:center;font-size:36px;font-weight:800;background:rgba(255,255,255,.16);flex:none}
.kb-nm{font-size:32px;font-weight:800;line-height:1.2;overflow-wrap:anywhere}
.kb-opt{font-size:20px;color:var(--ink2);line-height:1.4;margin-top:2px}
.kb-item-note{color:var(--amber-ink);font-weight:700}
.kb-note{display:flex;gap:8px;align-items:center;padding:10px 14px;border-radius:14px;background:var(--amber-soft);color:var(--amber-ink);font-size:20px;font-weight:700}
.kb-meta{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:15px;line-height:1.4;color:var(--ink3)}
.kb-pay{display:inline-flex;gap:4px;align-items:center}
.kb-st-ready .kb-pay:not(.kb-paid){color:var(--amber-ink);font-weight:700}
.kb-go{min-height:76px;font-size:28px;font-weight:800;border-radius:22px;color:#fff;border:0}
.kb-go-start{background:var(--sky)!important}
.kb-go-done{background:var(--jade)!important}
.kb-colhead{font-size:30px;font-weight:800;line-height:1.2}
.kb-col-new .kb-colhead{color:var(--sky-ink)}
.kb-col-cooking .kb-colhead{color:var(--amber-ink)}
.kb-col-ready .kb-colhead{color:var(--jade-ink)}
.g-dk .g-sw:not(:checked){background:rgba(255,255,255,.28)}
.kb-snap{scrollbar-width:none;-webkit-overflow-scrolling:touch}
.kb-snap::-webkit-scrollbar{display:none}
@media (max-width:600px){.kb-no{font-size:48px}.kb-nm{font-size:28px}.kb-wait{font-size:26px}}
@media (prefers-reduced-motion:reduce){.kb-new{animation:none!important}}
`;

type ColumnId = 'new' | 'cooking' | 'ready';

const COLUMN: Record<ColumnId, { tone: string; icon: GiName }> = {
  new: { tone: 'g-b-info', icon: 'dot' },
  cooking: { tone: 'g-b-warn', icon: 'flame' },
  ready: { tone: 'g-b-ok', icon: 'check' },
};

function Column({
  id,
  count,
  phone,
  setRef,
  children,
  footer,
}: {
  id: ColumnId;
  count: number;
  phone: boolean;
  setRef: (el: HTMLElement | null) => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const tr = useT();
  const { tone, icon } = COLUMN[id];
  return (
    <section
      ref={setRef}
      className={`g-sunk g-scroll kb-col-${id}`}
      aria-labelledby={`kb-col-${id}`}
      style={s(
        `display:flex;flex-direction:column;gap:12px;padding:14px;min-height:0;min-width:0;${
          phone ? 'flex:0 0 88%;scroll-snap-align:center;' : ''
        }`,
      )}
    >
      <div style={s('display:flex;align-items:center;gap:10px;padding:2px 4px')}>
        <h2 id={`kb-col-${id}`} className="kb-colhead" style={s('flex-grow:1;margin:0')}>
          {tr(`kitchen.col.${id}`)}
        </h2>
        <span className={`g-badge ${tone}`}>
          <Gi n={icon} />
          {tr('kitchen.ticketCount', { count })}
        </span>
      </div>
      {children}
      {footer}
    </section>
  );
}

/**
 * The kitchen board (`#/kitchen`, design "Kitchen board"): the orders to make as big-type tickets in
 * three columns, new / cooking / ready, oldest first. Made for an iPad or a wall-mounted screen,
 * and for an iPhone on the kitchen wall in portrait, where the columns slide sideways and snap, with
 * a row of counts on top that jumps to a column.
 *
 * The orders come from the entity store, so a new order appears by itself (realtime) and a
 * finished one leaves; opening the view also fetches today's list once. It shows no price, no
 * total and no payment action. While it is open the screen stays awake and the session stays
 * signed in (`useKitchenDisplay`), and the sound switch lives here (iOS needs a tap to unlock audio).
 * The back button goes to the first page this role may open; a kitchen-only role has none.
 */
export function KitchenScreen() {
  const tr = useT();
  const auth = useAuthState();
  const role = auth.session?.staff.role;
  const state = useEntities();
  const phone = useLayout() === 'phone';
  // The timers count seconds, so the board re-reads the clock every second.
  const now = useNow(1_000);
  const { load, retry } = useLoadOrders();
  const [active, setActive] = useState(0);
  const columns = useRef<(HTMLElement | null)[]>([]);
  useKitchenDisplay();

  if (!role) return null;
  const queue = kitchenQueue(state.orders.values(), now);
  const fresh: OrderDto[] = queue.toMake.filter((o) => o.status === 'new');
  const cooking: OrderDto[] = queue.toMake.filter((o) => o.status === 'preparing');
  const counts = [fresh.length, cooking.length, queue.ready.length];
  const back = allowedRoutes(auth.session?.permissions ?? []).find((r) => r.id !== 'kitchen');
  const done = handedOverToday(state.orders.values(), currentBusinessDay(state.settings, now));
  const empty = queue.toMake.length === 0;

  const tickets = (id: ColumnId, list: OrderDto[], offset: number) => (
    <ol
      aria-labelledby={`kb-col-${id}`}
      style={s('list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:12px')}
    >
      {list.map((order, index) => (
        <KitchenTicket
          key={order.id}
          order={order}
          role={role}
          now={now}
          delay={Math.min(0.05 + (offset + index) * 0.07, 0.4)}
        />
      ))}
    </ol>
  );
  const note = (text: string, status?: 'status') => (
    <p className="g-t-s" role={status} style={s('margin:0;padding:8px 4px;text-align:center')}>
      {text}
    </p>
  );
  const clock = (
    <time
      className="g-num"
      dateTime={new Date(now).toISOString()}
      style={s(
        `font-size:${phone ? 30 : 40}px;line-height:1.2;font-weight:600;padding-left:6px;flex:none`,
      )}
    >
      {clockTime(now)}
    </time>
  );
  // The board has no navigation, so who is signed in and the sign-out live behind this avatar.
  const staff = auth.session?.staff;
  const account = staff ? (
    <AccountMenu
      placement="bottom-end"
      label={`${staff.displayName} · ${tr(`role.${staff.role}`)}`}
      className="g-avatar"
      style={s('border:0;cursor:pointer;font:inherit;flex:none')}
    >
      {Array.from(staff.displayName.trim())[0] ?? ''}
    </AccountMenu>
  ) : null;
  const title = (
    <div style={s('flex:1 1 0;display:flex;flex-direction:column;min-width:0')}>
      <h1 id="kitchen-title" className="g-t-1" style={s('margin:0')}>
        {tr('kitchen.title')}
      </h1>
      <div className="g-t-s">{tr('kitchen.subtitle', { minutes: WAIT_WARN_MINUTES })}</div>
    </div>
  );
  const backButton = back ? (
    <a
      className="g-btn g-btn-icon"
      href={`#${back.path}`}
      aria-label={tr('common.back')}
      title={tr(back.labelKey)}
      style={s('flex:none')}
    >
      <Gi n="chevronLeft" />
    </a>
  ) : null;

  return (
    <section
      aria-labelledby="kitchen-title"
      style={s(
        `flex:1;min-height:0;display:flex;flex-direction:column;gap:16px;${
          phone
            ? 'padding:calc(env(safe-area-inset-top, 0px) + 14px) 14px calc(env(safe-area-inset-bottom, 0px) + 14px);'
            : 'padding:0 4px 4px;'
        }`,
      )}
    >
      <style>{BOARD_CSS}</style>
      <header
        style={s(
          `display:flex;align-items:center;gap:${phone ? 12 : 16}px;padding:0 4px;flex-wrap:wrap;flex:none`,
        )}
      >
        {backButton}
        {title}
        {phone ? (
          <>
            {clock}
            <div style={s('display:flex;align-items:center;gap:12px;flex:1 1 100%')}>
              <SoundControl />
              <span style={s('margin-left:auto')}>
                <SyncPill compact />
              </span>
              {account}
            </div>
          </>
        ) : (
          <>
            <SoundControl />
            <SyncPill />
            {clock}
            {account}
          </>
        )}
      </header>

      {load === 'error' ? (
        <div
          role="alert"
          className="g-sunk"
          style={s(
            'display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 16px;color:var(--chili-ink);font-weight:600;flex:none',
          )}
        >
          <Gi n="warn" />
          <span style={s('flex-grow:1')}>{tr('orders.loadFailed')}</span>
          <button type="button" className="g-btn" onClick={retry}>
            {tr('common.retry')}
          </button>
        </div>
      ) : null}

      {phone ? (
        <nav
          aria-label={tr('kitchen.columns')}
          className="g-scroll"
          style={s('display:flex;gap:8px;flex:none')}
        >
          {(['new', 'cooking', 'ready'] as const).map((id, index) => (
            <button
              key={id}
              type="button"
              className={`g-chip${active === index ? ' g-on' : ''}`}
              aria-pressed={active === index}
              style={s('flex:1 1 0;padding:0 10px')}
              onClick={() => {
                setActive(index);
                columns.current[index]?.scrollIntoView?.({
                  behavior: 'smooth',
                  inline: 'center',
                  block: 'nearest',
                });
              }}
            >
              {tr(`kitchen.col.${id}`)}
              <span className={`g-badge ${COLUMN[id].tone}`} style={s('height:22px;padding:0 8px')}>
                {counts[index]}
              </span>
            </button>
          ))}
        </nav>
      ) : null}

      <div
        className={phone ? 'kb-snap' : undefined}
        onScroll={
          phone
            ? (event) => {
                const el = event.currentTarget;
                setActive(Math.round((el.scrollLeft / el.scrollWidth) * 3));
              }
            : undefined
        }
        style={s(
          phone
            ? 'display:flex;gap:12px;flex-grow:1;min-height:0;overflow-x:auto;scroll-snap-type:x mandatory;margin:0 -14px;padding:0 14px'
            : 'display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;flex-grow:1;min-height:0',
        )}
      >
        <Column
          id="new"
          count={fresh.length}
          phone={phone}
          setRef={(el) => {
            columns.current[0] = el;
          }}
        >
          {fresh.length > 0
            ? tickets('new', fresh, 0)
            : note(
                empty
                  ? load === 'loading'
                    ? tr('kitchen.loading')
                    : tr('kitchen.empty')
                  : tr('kitchen.new.empty'),
                empty && load === 'loading' ? 'status' : undefined,
              )}
        </Column>
        <Column
          id="cooking"
          count={cooking.length}
          phone={phone}
          setRef={(el) => {
            columns.current[1] = el;
          }}
        >
          {cooking.length > 0
            ? tickets('cooking', cooking, fresh.length)
            : note(tr('kitchen.cooking.empty'))}
        </Column>
        <Column
          id="ready"
          count={queue.ready.length}
          phone={phone}
          setRef={(el) => {
            columns.current[2] = el;
          }}
          footer={
            <div style={s('flex-grow:1;display:flex;align-items:flex-end')}>
              <div className="g-t-c" style={s('padding:4px')}>
                {done.averageMinutes === null
                  ? tr('kitchen.handedOver', { count: done.count })
                  : tr('kitchen.handedOverAvg', {
                      count: done.count,
                      minutes: done.averageMinutes,
                    })}
              </div>
            </div>
          }
        >
          {queue.ready.length > 0
            ? tickets('ready', queue.ready, fresh.length + cooking.length)
            : note(tr('kitchen.ready.empty'))}
        </Column>
      </div>
    </section>
  );
}
