import { clockTime, weekdayDate } from '../design/format.ts';
import { Gi, type GiName } from '../design/icons.tsx';
import { PageHeader } from '../design/PageHeader.tsx';
import { s } from '../design/style.ts';
import { useLocale, useNow, useT } from '../ui/hooks.ts';
import {
  SAMPLE_CHANNELS,
  SAMPLE_KPIS,
  SAMPLE_PENDING,
  SAMPLE_TOP_ITEMS,
  SAMPLE_VAT,
} from './dashboard-sample.ts';

const CIRCUMFERENCE = 339.3;

function Delta({ up, children }: { up: boolean; children: string }) {
  return (
    <span className={`g-badge ${up ? 'g-b-ok' : 'g-b-bad'}`}>
      <Gi n={up ? 'chevronUp' : 'chevronDown'} />
      {children}
    </span>
  );
}

function Kpi({
  delay,
  color,
  icon,
  label,
  value,
  children,
}: {
  delay: string;
  color: string;
  icon: GiName;
  label: string;
  value: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="g-glass g-rise"
      style={s(`padding:20px 22px;display:flex;flex-direction:column;gap:6px;--d:${delay}`)}
    >
      <div className="g-t-s" style={s('display:flex;align-items:center;gap:8px')}>
        <span
          className="g-ico"
          style={s(`width:30px;height:30px;border-radius:10px;background:${color}`)}
        >
          <Gi n={icon} size="sm" />
        </span>
        {label}
      </div>
      <div className="g-num" style={s('font-size:36px;line-height:1.3;font-weight:600')}>
        {value}
      </div>
      <div style={s('display:flex;gap:8px;align-items:center')}>{children}</div>
    </div>
  );
}

/**
 * The back-office overview (`#/dashboard`, laptop design "ภาพรวมวันนี้"). There is no report API
 * yet, so every number comes from `dashboard-sample.ts` and the page says so; the controls that
 * need data (period, export) are shown but disabled.
 */
export function DashboardScreen() {
  const tr = useT();
  const locale = useLocale();
  const now = useNow(60_000);
  const k = SAMPLE_KPIS;
  const top = SAMPLE_TOP_ITEMS[0].qty;
  let offset = 0;

  return (
    <section
      aria-labelledby="dashboard-title"
      className="g-scroll"
      style={s(
        'flex:1;min-height:0;display:flex;flex-direction:column;gap:20px;padding:10px 12px 8px 8px;overflow-y:auto',
      )}
    >
      <PageHeader
        id="dashboard-title"
        wrap
        title={tr('dash.title')}
        subtitle={tr('dash.updated', { date: weekdayDate(now, locale), time: clockTime(now) })}
      >
        <span className="g-badge g-b-mute" title={tr('dash.sample.hint')}>
          <Gi n="info" />
          {tr('dash.sample')}
        </span>
        <fieldset
          className="g-seg"
          aria-label={tr('dash.range.label')}
          style={s('border:0;margin:0')}
        >
          {(['today', 'week', 'month', 'year'] as const).map((range) => (
            <label key={range} className={`g-chip${range === 'today' ? ' g-on' : ''}`}>
              <input
                type="radio"
                name="dash-range"
                checked={range === 'today'}
                disabled={range !== 'today'}
                readOnly
              />
              {tr(`dash.range.${range}`)}
            </label>
          ))}
        </fieldset>
        <button type="button" className="g-btn" disabled title={tr('nav.notReady')}>
          <Gi n="lock" size="sm" />
          {tr('dash.export')}
        </button>
      </PageHeader>
      <div
        role="note"
        className="g-sunk"
        style={s(
          'display:flex;align-items:center;gap:10px;padding:10px 14px;color:var(--amber-ink);background:var(--amber-soft);font-weight:600;flex:none',
        )}
      >
        <Gi n="info" size="sm" />
        <span>{tr('dash.sample.hint')}</span>
      </div>

      <div
        style={s('display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:16px')}
      >
        <Kpi
          delay=".03s"
          color="var(--chili)"
          icon="cash"
          label={tr('dash.kpi.paid')}
          value={k.paid.value}
        >
          <Delta up={k.paid.up}>{k.paid.delta}</Delta>
          <span className="g-t-c">{tr('dash.vsYesterday', { value: k.paid.before })}</span>
        </Kpi>
        <Kpi
          delay=".07s"
          color="#3a3330"
          icon="receipt2"
          label={tr('dash.kpi.orders')}
          value={k.orders.value}
        >
          <Delta up={k.orders.up}>{tr('dash.orderUnit', { count: k.orders.delta })}</Delta>
          <span className="g-t-c">
            {tr('dash.vsYesterday', { value: tr('dash.orderUnit', { count: k.orders.before }) })}
          </span>
        </Kpi>
        <Kpi
          delay=".11s"
          color="#2457b8"
          icon="bag"
          label={tr('dash.kpi.avg')}
          value={k.average.value}
        >
          <Delta up={k.average.up}>{k.average.delta}</Delta>
          <span className="g-t-c">{tr('dash.vsYesterday', { value: k.average.before })}</span>
        </Kpi>
        <Kpi
          delay=".15s"
          color="var(--jade)"
          icon="trend"
          label={tr('dash.kpi.gross')}
          value={k.gross.value}
        >
          <span className="g-badge g-b-mute">{k.gross.margin}</span>
          <span className="g-t-c">{tr('dash.grossNote')}</span>
        </Kpi>
      </div>

      <div style={s('display:flex;flex-wrap:wrap;gap:16px')}>
        <div
          className="g-glass g-rise"
          style={s(
            'flex:2 1 520px;min-width:0;padding:22px 24px 14px;display:flex;flex-direction:column;gap:6px;--d:.19s',
          )}
        >
          <div style={s('display:flex;align-items:center;gap:12px;flex-wrap:wrap')}>
            <div className="g-t-2" style={s('flex-grow:1')}>
              {tr('dash.hourly')}
            </div>
            <span className="g-t-c" style={s('display:flex;align-items:center;gap:6px')}>
              <span style={s('width:18px;height:3px;border-radius:2px;background:var(--chili)')} />
              {tr('dash.today')}
            </span>
            <span className="g-t-c" style={s('display:flex;align-items:center;gap:6px')}>
              <span style={s('width:18px;border-top:2px dashed var(--ink3)')} />
              {tr('dash.yesterday')}
            </span>
          </div>
          <svg
            viewBox="0 0 660 270"
            style={s('width:100%;height:auto;display:block')}
            role="img"
            aria-label={tr('dash.hourlyAlt')}
          >
            <defs>
              <linearGradient id="g-dash-area" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#c62828" stopOpacity=".25" />
                <stop offset="1" stopColor="#c62828" stopOpacity="0" />
              </linearGradient>
            </defs>
            <g stroke="rgba(70,35,20,.1)" strokeWidth="1">
              <path d="M60 220H650M60 172.5H650M60 125H650M60 77.5H650M60 30H650" />
            </g>
            <g fill="#6f615a" fontSize="13" textAnchor="end">
              <text x="48" y="225">
                ฿0
              </text>
              <text x="48" y="177">
                450
              </text>
              <text x="48" y="130">
                900
              </text>
              <text x="48" y="82">
                1,350
              </text>
              <text x="48" y="35">
                1,800
              </text>
            </g>
            <g fill="#6f615a" fontSize="13" textAnchor="middle">
              <text x="80" y="250">
                10:00
              </text>
              <text x="190" y="250">
                11:00
              </text>
              <text x="300" y="250">
                12:00
              </text>
              <text x="410" y="250">
                13:00
              </text>
              <text x="520" y="250">
                14:00
              </text>
              <text x="630" y="250">
                15:00
              </text>
            </g>
            <path
              d="M80 180C125 180 145 129 190 129S255 81 300 81 365 88 410 88 475 152 520 152 585 198 630 198"
              fill="none"
              stroke="#6f615a"
              strokeWidth="2"
              strokeDasharray="6 6"
              strokeLinecap="round"
            />
            <path
              d="M80 176C125 176 145 117 190 117S255 57 300 57 365 95 410 95 475 161 520 161 585 201 630 201V220H80z"
              fill="url(#g-dash-area)"
            />
            <path
              d="M80 176C125 176 145 117 190 117S255 57 300 57 365 95 410 95 475 161 520 161 585 201 630 201"
              fill="none"
              stroke="#c62828"
              strokeWidth="3.5"
              strokeLinecap="round"
            />
            <g fill="#fff" stroke="#c62828" strokeWidth="3">
              <circle className="g-pt" cx="80" cy="176" r="5" />
              <circle className="g-pt" cx="190" cy="117" r="5" />
              <circle className="g-pt" cx="300" cy="57" r="7" fill="#c62828" />
              <circle className="g-pt" cx="410" cy="95" r="5" />
              <circle className="g-pt" cx="520" cy="161" r="5" />
              <circle className="g-pt" cx="630" cy="201" r="5" />
            </g>
            <path
              d="M300 57V220"
              stroke="#c62828"
              strokeWidth="1.5"
              strokeDasharray="3 5"
              opacity=".5"
            />
            <g transform="translate(318 18)">
              <rect width="150" height="50" rx="14" fill="#fff" stroke="rgba(70,35,20,.1)" />
              <text x="14" y="21" fontSize="13" fill="#6f615a">
                12:00 – 13:00
              </text>
              <text x="14" y="40" fontSize="16" fontWeight="600" fill="#1c1411">
                ฿1,540 · 11 ใบ
              </text>
            </g>
          </svg>
        </div>

        <div
          className="g-glass g-rise"
          style={s(
            'flex:1 1 300px;min-width:0;padding:22px 24px;display:flex;flex-direction:column;gap:14px;--d:.23s',
          )}
        >
          <div className="g-t-2">{tr('dash.channels')}</div>
          <div style={s('display:flex;align-items:center;gap:20px;flex-wrap:wrap')}>
            <svg
              viewBox="0 0 140 140"
              width="136"
              height="136"
              role="img"
              aria-label={tr('dash.channelsAlt')}
              style={s('flex:none')}
            >
              <g transform="rotate(-90 70 70)" fill="none" strokeWidth="20">
                {SAMPLE_CHANNELS.map((c) => {
                  const length = (CIRCUMFERENCE * c.share) / 100 - 4.3;
                  const circle = (
                    <circle
                      key={c.key}
                      cx="70"
                      cy="70"
                      r="54"
                      stroke={c.color}
                      strokeDasharray={`${length.toFixed(1)} ${CIRCUMFERENCE}`}
                      strokeDashoffset={-offset}
                    />
                  );
                  offset += (CIRCUMFERENCE * c.share) / 100;
                  return circle;
                })}
              </g>
              <text x="70" y="68" textAnchor="middle" fontSize="22" fontWeight="600" fill="#1c1411">
                {k.orders.value}
              </text>
              <text x="70" y="88" textAnchor="middle" fontSize="13" fill="#6f615a">
                {tr('dash.orders')}
              </text>
            </svg>
            <div
              style={s('flex-grow:1;min-width:150px;display:flex;flex-direction:column;gap:12px')}
            >
              {SAMPLE_CHANNELS.map((c) => (
                <div key={c.key} style={s('display:flex;align-items:center;gap:10px')}>
                  <span
                    style={s(`width:12px;height:12px;border-radius:4px;background:${c.color}`)}
                  />
                  <span className="g-t-s" style={s('flex-grow:1;color:var(--ink)')}>
                    {tr(`dash.channel.${c.key}`)}
                  </span>
                  <span className="g-num g-t-3" style={s('font-size:15px')}>
                    {c.share}% · {c.amount}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div
            className="g-sunk"
            style={s('padding:12px 14px;display:flex;gap:10px;align-items:center')}
          >
            <Gi n="building" size="sm" style={s('color:var(--ink2)')} />
            <div className="g-t-s" style={s('line-height:1.45')}>
              {tr('dash.entranceNote')}
            </div>
          </div>
        </div>
      </div>

      <div style={s('display:flex;flex-wrap:wrap;gap:16px')}>
        <div
          className="g-glass g-rise"
          style={s(
            'flex:1 1 300px;min-width:0;padding:22px 24px;display:flex;flex-direction:column;gap:12px;--d:.27s',
          )}
        >
          <div style={s('display:flex;align-items:baseline')}>
            <div className="g-t-2" style={s('flex-grow:1')}>
              {tr('dash.topItems')}
            </div>
            <span className="g-t-c">{tr('dash.soldQty')}</span>
          </div>
          <div style={s('display:flex;flex-direction:column;gap:11px')}>
            {SAMPLE_TOP_ITEMS.map((item) => (
              <div key={item.name} style={s('display:flex;align-items:center;gap:12px')}>
                <span className="g-t-s" style={s('width:128px;color:var(--ink)')}>
                  {item.name}
                </span>
                <span
                  style={s(
                    'flex-grow:1;height:12px;border-radius:6px;background:rgba(70,35,20,.07);overflow:hidden',
                  )}
                >
                  <span
                    style={s(
                      `display:block;height:100%;width:${Math.round((item.qty / top) * 100)}%;border-radius:6px;background:linear-gradient(90deg,#d63a2e,#c62828)`,
                    )}
                  />
                </span>
                <span
                  className="g-num g-t-3"
                  style={s('width:26px;text-align:right;font-size:15px')}
                >
                  {item.qty}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div
          className="g-glass g-rise"
          style={s(
            'flex:1 1 300px;min-width:0;padding:22px 24px;display:flex;flex-direction:column;gap:12px;--d:.31s',
          )}
        >
          <div style={s('display:flex;align-items:baseline')}>
            <div className="g-t-2" style={s('flex-grow:1')}>
              {tr('dash.pending')}
            </div>
            <a
              className="g-t-s"
              href="#/orders"
              style={s('color:var(--chili);font-weight:600;text-decoration:none')}
            >
              {tr('dash.seeAll')}
            </a>
          </div>
          {SAMPLE_PENDING.map((row) => (
            <div key={row.title} className="g-row" style={s('padding:8px 0')}>
              <div style={s('flex-grow:1')}>
                <div className="g-t-3" style={s('font-size:15px')}>
                  {row.title}
                </div>
                <div className="g-t-c">{row.detail}</div>
              </div>
              {row.kind === 'review' ? (
                <span className="g-badge g-b-info">
                  <Gi n="clock" />
                  {tr('status.payment.awaiting_confirmation')}
                </span>
              ) : (
                <span className="g-badge g-b-warn">
                  <Gi n="pending" />
                  {tr('status.payment.unpaid')}
                </span>
              )}
            </div>
          ))}
        </div>

        <div
          className="g-glass g-rise"
          style={s(
            'flex:1 1 300px;min-width:0;padding:22px 24px;display:flex;flex-direction:column;gap:12px;--d:.35s',
          )}
        >
          <div className="g-t-2">{tr('dash.vat')}</div>
          <div style={s('display:flex;align-items:baseline;gap:8px')}>
            <div className="g-num" style={s('font-size:36px;line-height:1.3;font-weight:600')}>
              {SAMPLE_VAT.percent}%
            </div>
            <div className="g-t-s">{tr('dash.vatOf', { amount: SAMPLE_VAT.limit })}</div>
          </div>
          <div
            style={s('height:14px;border-radius:7px;background:rgba(70,35,20,.08);overflow:hidden')}
          >
            <div
              style={s(
                `height:100%;width:${SAMPLE_VAT.percent}%;border-radius:7px;background:linear-gradient(90deg,#f5a524,#d63a2e)`,
              )}
            />
          </div>
          <div className="g-t-s">{tr('dash.vatNote', { amount: SAMPLE_VAT.year })}</div>
          <div className="g-t-c">{tr('dash.vatDisclaimer')}</div>
        </div>
      </div>
    </section>
  );
}
