import { Brand } from './Brand.tsx';
import { useAuthStore, useT } from './hooks.ts';
import { Icon } from './Icon.tsx';
import { OwnerSignInForm } from './OwnerFields.tsx';

/** The owner's password sign-in on a registered device. Back goes to the PIN tiles. */
export function OwnerSignInScreen({ onBack }: { onBack: () => void }) {
  const auth = useAuthStore();
  const tr = useT();
  return (
    <main className="auth">
      <div className="card">
        <header className="card__head">
          <Brand />
        </header>
        <button type="button" className="link link--back" onClick={onBack}>
          <Icon name="back" />
          {tr('auth.owner.backToPin')}
        </button>
        <h1 className="card__title">{tr('auth.owner.title')}</h1>
        <OwnerSignInForm
          submitLabel={tr('auth.owner.submit')}
          onSubmit={(request) => auth.signInOwner(request)}
        />
      </div>
    </main>
  );
}
