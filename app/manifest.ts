import type { MetadataRoute } from 'next';

// PWA manifest. Served by Next at /manifest.webmanifest and linked from the
// root layout's metadata. Installability criteria (Chrome/Edge): HTTPS,
// a service worker with a fetch handler (public/sw.js), and this manifest
// with name, start_url, display, and icons including a 192px and a 512px
// entry (maskable included so Android adaptive launchers crop cleanly).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'SaccoOs',
    short_name: 'SaccoOs',
    description:
      'Manage Sacco wallets, savings, loans, and transaction tracking with ease.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#FEF6EE',
    theme_color: '#7C2D12',
    icons: [
      {
        src: '/icons/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-maskable-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: '/icons/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
