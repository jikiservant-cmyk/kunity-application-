'use client';

// Install prompt. MUST ask every user to install the app:
//   - shows on every visit (dismissal only hides it for the current session),
//   - never again once the app is actually installed,
//   - Chrome/Edge/Android: taps the captured beforeinstallprompt event so the
//     browser runs its native install flow,
//   - iOS Safari (no beforeinstallprompt): shows the manual
//     Share -> "Add to Home Screen" steps,
//   - other browsers: menu-based install guidance.
import { useEffect, useState } from 'react';
import { Download, X, Share, PlusSquare } from 'lucide-react';

type Platform = 'prompt' | 'ios' | 'generic';

const INSTALLED_KEY = 'kunity-pwa-installed';
const DISMISSED_KEY = 'kunity-pwa-dismissed';

export default function InstallPrompt() {
  const [visible, setVisible] = useState(false);
  const [platform, setPlatform] = useState<Platform>('generic');
  const [deferred, setDeferred] = useState<any>(null);

  useEffect(() => {
    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
    // iOS reports Safari (not CriOS) — treat any iOS without standalone as Safari.
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as any).standalone === true;

    if (standalone || localStorage.getItem(INSTALLED_KEY) === '1') return;

    const onBeforeInstall = (e: Event) => {
      // Keep the browser's own mini-infobar quiet; OUR banner does the asking.
      e.preventDefault();
      setDeferred(e);
      setPlatform('prompt');
    };
    const onInstalled = () => {
      localStorage.setItem(INSTALLED_KEY, '1');
      setVisible(false);
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);

    // Ask on every visit (dismissal is per-session only).
    if (!sessionStorage.getItem(DISMISSED_KEY)) {
      const show = window.setTimeout(() => {
        setPlatform((p) => (p === 'generic' && isIos ? 'ios' : p));
        setVisible(true);
      }, 1200);
      return () => {
        window.clearTimeout(show);
        window.removeEventListener('beforeinstallprompt', onBeforeInstall);
        window.removeEventListener('appinstalled', onInstalled);
      };
    }
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const dismiss = () => {
    sessionStorage.setItem(DISMISSED_KEY, '1');
    setVisible(false);
  };

  const install = async () => {
    if (deferred) {
      deferred.prompt();
      const choice = await deferred.userChoice?.catch(() => null);
      if (choice?.outcome === 'accepted') {
        localStorage.setItem(INSTALLED_KEY, '1');
        setVisible(false);
      } else {
        dismiss();
      }
    }
  };

  if (!visible) return null;

  return (
    <div
      role="dialog"
      aria-label="Install the app"
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 90,
        display: 'flex',
        justifyContent: 'center',
        padding: '0 12px 12px',
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          pointerEvents: 'auto',
          width: 'min(100%, 440px)',
          background: '#FFFFFF',
          border: '1px solid #F0E8DF',
          borderRadius: 20,
          boxShadow: '0 18px 48px rgba(28,25,23,0.25)',
          padding: '16px 16px 14px',
        }}
      >
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 14,
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'linear-gradient(135deg, #7C2D12, #F97316)',
            }}
          >
            <Download size={22} color="#fff" />
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: '#1C1917' }}>
              Install the Sacco Connect app
            </div>
            <div style={{ fontSize: 12.5, color: '#78716C', marginTop: 3, lineHeight: 1.45 }}>
              {platform === 'prompt' &&
                'Full-screen, works faster, and sits on your home screen right next to your other apps.'}
              {platform === 'ios' && (
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  Tap <Share size={14} color="#78716C" /> Share, then
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <PlusSquare size={14} color="#78716C" /> Add to Home Screen
                  </span>
                  to install the app.
                </span>
              )}
              {platform === 'generic' &&
                'Install it from your browser menu: "Install app" or "Add to Home screen".'}
            </div>
          </div>
          <button
            onClick={dismiss}
            aria-label="Dismiss"
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: 4,
              flexShrink: 0,
              color: '#A8A29E',
            }}
          >
            <X size={18} />
          </button>
        </div>
        {platform === 'prompt' && (
          <button
            onClick={install}
            style={{
              marginTop: 12,
              width: '100%',
              border: 'none',
              borderRadius: 14,
              padding: '12px 16px',
              background: 'linear-gradient(135deg, #7C2D12, #F97316)',
              color: '#fff',
              fontSize: 14,
              fontWeight: 800,
              cursor: 'pointer',
            }}
          >
            Install App
          </button>
        )}
      </div>
    </div>
  );
}
