/** @type {import('next').NextConfig} */
// PENTEST 2026-10-13: browser content policy.
// Next.js needs inline bootstrap scripts (no nonce support in this version), so
// script-src allows 'unsafe-inline'. It still blocks third-party script hosts.
const supabaseOrigin = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL || '').origin;
  } catch {
    return 'https://*.supabase.co';
  }
})();
const supabaseWs = supabaseOrigin.replace(/^https:/, 'wss:');
const isDev = process.env.NODE_ENV !== 'production';
// Clickjacking protection in production. Set ALLOW_FRAMING=true to allow embedding
// (for example the Arena live preview iframe) without changing the code.
const allowFraming = process.env.ALLOW_FRAMING === 'true' || isDev;
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://picsum.photos",
  "font-src 'self' data:",
  `connect-src 'self' ${supabaseOrigin} ${supabaseWs}${isDev ? ' ws: wss:' : ''}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  allowFraming ? '' : "frame-ancestors 'self'",
].filter(Boolean).join('; ');

const nextConfig = {
  reactStrictMode: true,
  typescript: {
    ignoreBuildErrors: false,
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'picsum.photos',
        port: '',
        pathname: '/**',
      },
    ],
  },
  experimental: {
    cpus: 1,
    workerThreads: false,
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'X-XSS-Protection',
            value: '1; mode=block',
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
          {
            key: 'Content-Security-Policy',
            value: contentSecurityPolicy,
          },
          ...(allowFraming ? [] : [{ key: 'X-Frame-Options', value: 'SAMEORIGIN' }]),
          {
            // PENTEST 2026-10-13: force HTTPS for returning browsers.
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains',
          },
          {
            // PENTEST 2026-10-13: the app does not use these browser features.
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
          },
        ],
      },
    ];
  },
  transpilePackages: ['motion'],
  webpack: (config, {dev}) => {
    if (dev && process.env.DISABLE_HMR === 'true') {
      config.watchOptions = {
        ignored: /.*/,
      };
    }
    return config;
  },
};

export default nextConfig;
