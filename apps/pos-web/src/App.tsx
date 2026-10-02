import { useEffect } from 'react';
import type { Services } from './services.ts';
import { pickDevice, tokensCss } from './theme/device.ts';
import { Brand } from './ui/Brand.tsx';
import { AuthContext, ServicesContext, useAuthState, useT, useViewport } from './ui/hooks.ts';
import { PinScreen } from './ui/PinScreen.tsx';
import { RegisterDeviceScreen } from './ui/RegisterDeviceScreen.tsx';
import { Shell } from './ui/Shell.tsx';
import { StepUpDialog } from './ui/StepUpDialog.tsx';

/** Writes the design tokens for this device (A4) onto the page. */
function useApplyTokens() {
  const viewport = useViewport();
  const kind = useAuthState().device?.kind ?? null;
  const device = pickDevice(kind, viewport);
  useEffect(() => {
    let style = document.getElementById('sds-tokens');
    if (!style) {
      style = document.createElement('style');
      style.id = 'sds-tokens';
      document.head.append(style);
    }
    style.textContent = tokensCss(device);
    document.documentElement.dataset.device = device;
  }, [device]);
}

function Screen() {
  useApplyTokens();
  const tr = useT();
  const { phase } = useAuthState();
  switch (phase) {
    case 'booting':
      return (
        <main className="auth">
          <div className="card card--splash">
            <Brand />
            <p className="muted" role="status">
              {tr('common.loading')}
            </p>
          </div>
        </main>
      );
    case 'unregistered':
      return <RegisterDeviceScreen />;
    case 'locked':
      return <PinScreen />;
    case 'signedIn':
      return <Shell />;
  }
}

export function App({ services }: { services: Services }) {
  return (
    <ServicesContext.Provider value={services}>
      <AuthContext.Provider value={services.auth}>
        <Screen />
        <StepUpDialog />
      </AuthContext.Provider>
    </ServicesContext.Provider>
  );
}
