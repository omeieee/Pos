/**
 * App lifecycle seam: is the device online, is the page in front, and tell me when either
 * changes. The realtime client uses it to reconnect when an iPad wakes up (Safari suspends a
 * background tab and the socket dies without a close event) or the network returns. The P10
 * shells map this onto their own app-state events.
 */
export interface LifecycleHandlers {
  online?: () => void;
  offline?: () => void;
  /** The page came back to the front. */
  visible?: () => void;
}

export interface Lifecycle {
  isOnline(): boolean;
  isVisible(): boolean;
  subscribe(handlers: LifecycleHandlers): () => void;
}

export const webLifecycle: Lifecycle = {
  isOnline: () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false),
  isVisible: () => (typeof document === 'undefined' ? true : document.visibilityState !== 'hidden'),
  subscribe(handlers) {
    const onOnline = () => handlers.online?.();
    const onOffline = () => handlers.offline?.();
    const onVisibility = () => {
      if (document.visibilityState !== 'hidden') handlers.visible?.();
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  },
};
