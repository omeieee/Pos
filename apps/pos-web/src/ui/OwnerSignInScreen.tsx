import { Gi } from '../design/icons.tsx';
import { s } from '../design/style.ts';
import { AuthCard, AuthFrame } from './AuthFrame.tsx';
import { useAuthStore, useT } from './hooks.ts';
import { OwnerSignInForm } from './OwnerFields.tsx';

/** The owner's password sign-in on a registered device. Back goes to the staff cards. */
export function OwnerSignInScreen({ onBack }: { onBack: () => void }) {
  const auth = useAuthStore();
  const tr = useT();
  return (
    <AuthFrame compactHero>
      <AuthCard>
        <button type="button" className="gauth__back" onClick={onBack}>
          <Gi n="chevronLeft" />
          {tr('auth.owner.backToPin')}
        </button>
        <h1 className="g-t-1" style={s('margin:0')}>
          {tr('auth.owner.title')}
        </h1>
        <div className="g-t-s" style={s('margin-top:-8px')}>
          {tr('auth.owner.subtitle')}
        </div>
        <OwnerSignInForm
          submitLabel={tr('auth.owner.submit')}
          onSubmit={(request) => auth.signInOwner(request)}
        />
      </AuthCard>
    </AuthFrame>
  );
}
