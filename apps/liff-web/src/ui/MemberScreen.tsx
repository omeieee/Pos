import type { MemberProfile } from '@sds/shared';
import { useCallback, useEffect, useState } from 'react';
import { Gi } from '../design/icons.tsx';
import { s } from '../design/style.ts';
import { type MemberForm, memberFormOf, memberInput, memberProblems } from '../model/member.ts';
import { errorKey, useApp, useT } from './app-context.tsx';
import { BarButton, Body, Header, Notice } from './Chrome.tsx';
import { MemberSection } from './MemberSection.tsx';

/** The member page ("ข้อมูลสมาชิก"), opened from the rich menu: the optional form on its own. */
export function MemberScreen() {
  const tr = useT();
  const { api, go } = useApp();
  const [saved, setSaved] = useState<MemberProfile | null>(null);
  const [form, setForm] = useState<MemberForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    api
      .member()
      .then(({ member }) => {
        setSaved(member);
        setForm(memberFormOf(member));
      })
      .catch((e: unknown) => setError(tr(errorKey(e))));
  }, [api, tr]);
  useEffect(load, [load]);

  const change = (next: MemberForm) => {
    setForm(next);
    setDone(false);
  };

  async function save() {
    if (!form || !saved || busy) return;
    setTried(true);
    const input = memberInput(form, saved);
    if (memberProblems(form).length > 0 || !input) return;
    setBusy(true);
    setError(null);
    try {
      const { member } = await api.saveMember(input);
      setSaved(member);
      setForm(memberFormOf(member));
      setDone(true);
      setTried(false);
    } catch (e) {
      // PRIVACY_NOT_ACKNOWLEDGED gets its own message here, like everywhere else in the app.
      setError(tr(errorKey(e)));
    }
    setBusy(false);
  }

  return (
    <MemberView
      form={form}
      saved={saved}
      busy={busy}
      tried={tried}
      done={done}
      error={error}
      onChange={change}
      onSave={() => void save()}
      onRetry={load}
      onBack={() => go('/menu')}
    />
  );
}

/** What the page looks like for a state; no I/O, so it can be rendered in a test. */
export function MemberView({
  form,
  saved,
  busy,
  tried,
  done,
  error,
  onChange,
  onSave,
  onRetry,
  onBack,
}: {
  form: MemberForm | null;
  saved: MemberProfile | null;
  busy: boolean;
  tried: boolean;
  done: boolean;
  error: string | null;
  onChange: (next: MemberForm) => void;
  onSave: () => void;
  onRetry: () => void;
  onBack: () => void;
}) {
  const tr = useT();
  const dirty = form !== null && memberInput(form, saved ?? undefined) !== undefined;
  return (
    <>
      <Header
        left={<BarButton icon="chevronLeft" label={tr('liff.back')} onClick={onBack} />}
        title={tr('liff.member.page')}
      />
      <Body label={tr('liff.member.page')}>
        {form === null ? (
          error ? (
            <>
              <Notice tone="bad" icon="warn" alert>
                {error}
              </Notice>
              <button
                type="button"
                className="g-btn g-btn-p g-btn-block"
                style={s('margin-top:14px')}
                onClick={onRetry}
              >
                {tr('liff.retry')}
              </button>
            </>
          ) : (
            <Notice icon="clock">{tr('liff.loading')}</Notice>
          )
        ) : (
          <div style={s('display:flex;flex-direction:column;gap:14px')}>
            <MemberSection value={form} onChange={onChange} showErrors={tried} />
            {error ? (
              <Notice tone="bad" icon="warn" alert>
                {error}
              </Notice>
            ) : null}
            {done ? (
              <Notice tone="ok" icon="check">
                {tr('liff.member.saved')}
              </Notice>
            ) : null}
            <button
              type="button"
              className="g-btn g-btn-p g-btn-lg g-btn-block"
              disabled={busy || !dirty}
              aria-busy={busy}
              onClick={onSave}
            >
              {busy ? tr('liff.member.saving') : tr('liff.member.save')}
              <Gi n="chevronRight" size="sm" />
            </button>
          </div>
        )}
      </Body>
    </>
  );
}
