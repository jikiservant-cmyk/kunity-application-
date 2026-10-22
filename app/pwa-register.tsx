'use client';

// Registers the service worker (public/sw.js). Production only, so local
// development never serves stale build chunks from the cache.
export default function PwaRegister() {
  if (typeof window !== 'undefined') {
    if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch((err) => {
          console.warn('[PWA] Service worker registration failed:', err);
        });
      });
    }
  }
  return null;
}
