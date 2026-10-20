import { isBuyingGoods } from '@sds/shared';
import { useState } from 'react';
import { errorText } from '../../api/errors.ts';
import { useLocale, useT } from '../../ui/hooks.ts';
import { TextField } from '../../ui/TextField.tsx';
import {
  addCategory,
  categoryName,
  setCategoryActive,
  setCategoryBuyingGoods,
} from './expense-model.ts';
import type { CategoryState } from './use-finance.ts';

/**
 * The shop's expense categories. A category is added with a Thai name (and an English one if
 * wished) and can be switched off or on again, but never removed: an old expense always has a
 * category to point at. Each one has a "counts as buying goods" box (the receipts-payments report
 * puts ticked categories in its goods column). Every change replaces the whole list with the version
 * the screen read.
 */
export function CategoriesPanel({ state }: { state: CategoryState }) {
  const tr = useT();
  const locale = useLocale();
  const [names, setNames] = useState({ nameTh: '', nameEn: '' });
  const [addGoods, setAddGoods] = useState(true);
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function change(next: ReturnType<typeof addCategory>) {
    if (!next || saving) return false;
    setSaving(true);
    setMessage(null);
    const failure = await state.save(next);
    setSaving(false);
    if (failure === null) {
      setMessage({ ok: true, text: tr('exp.cat.saved') });
      return true;
    }
    setMessage({ ok: false, text: errorText(tr, failure) });
    return false;
  }

  async function add() {
    setTried(true);
    const next = addCategory(state.categories, { ...names, buyingGoods: addGoods });
    if (next && (await change(next))) {
      setNames({ nameTh: '', nameEn: '' });
      setAddGoods(true);
      setTried(false);
    }
  }

  return (
    <div className="g-glass fin-card">
      <div className="g-t-2">{tr('exp.cat.title')}</div>
      <fieldset aria-label={tr('exp.cat.title')} className="fin-stack fin-fieldset">
        <p className="g-t-s fin-note">{tr('exp.cat.hint')}</p>
        <p className="g-t-s fin-note">{tr('exp.cat.buyingGoodsHint')}</p>
        {state.load === 'error' ? (
          <div role="alert" className="g-sunk fin-error">
            <span>{tr('fin.error')}</span>
            <button type="button" className="g-btn" onClick={state.reload}>
              {tr('common.retry')}
            </button>
          </div>
        ) : null}
        <ul className="fin-cats">
          {state.categories.map((c) => {
            const name = categoryName(state.categories, c.key, locale);
            return (
              <li key={c.key} className="fin-cat">
                <span className={`fin-cat__name${c.active ? '' : ' fin-struck'}`}>{name}</span>
                {c.active ? null : <span className="g-badge g-b-mute">{tr('exp.cat.off')}</span>}
                <label className="fin-check">
                  <input
                    type="checkbox"
                    checked={isBuyingGoods(c)}
                    disabled={saving}
                    aria-label={tr('exp.cat.buyingGoodsOf', { name })}
                    onChange={(event) =>
                      void change(
                        setCategoryBuyingGoods(state.categories, c.key, event.target.checked),
                      )
                    }
                  />
                  {tr('exp.cat.buyingGoodsHead')}
                </label>
                <button
                  type="button"
                  className="g-btn"
                  disabled={saving}
                  aria-label={tr(c.active ? 'exp.cat.switchOff' : 'exp.cat.switchOn', { name })}
                  onClick={() => void change(setCategoryActive(state.categories, c.key, !c.active))}
                >
                  {tr(c.active ? 'exp.cat.actionOff' : 'exp.cat.actionOn')}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="g-t-3">{tr('exp.cat.addTitle')}</div>
        <div className="fin-cat__add">
          <TextField
            label={tr('exp.cat.nameTh')}
            value={names.nameTh}
            maxLength={80}
            error={tried && names.nameTh.trim() === '' ? tr('exp.cat.error.nameTh') : undefined}
            onChange={(nameTh) => setNames({ ...names, nameTh })}
          />
          <TextField
            label={tr('exp.cat.nameEn')}
            value={names.nameEn}
            maxLength={80}
            onChange={(nameEn) => setNames({ ...names, nameEn })}
          />
        </div>
        <label className="fin-check">
          <input
            type="checkbox"
            checked={addGoods}
            aria-label={tr('exp.cat.addBuyingGoods')}
            onChange={(event) => setAddGoods(event.target.checked)}
          />
          {tr('exp.cat.addBuyingGoods')}
        </label>
        <div className="fin-actions">
          <button
            type="button"
            className="g-btn g-btn-p"
            disabled={saving || state.load !== 'ok'}
            onClick={() => void add()}
          >
            {tr('exp.cat.add')}
          </button>
        </div>
        {message ? (
          <p role={message.ok ? 'status' : 'alert'} className="g-t-s fin-note">
            {message.text}
          </p>
        ) : null}
      </fieldset>
    </div>
  );
}
