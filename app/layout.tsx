import type {Metadata, Viewport} from 'next';
import { Inter, Space_Grotesk } from 'next/font/google';
import './globals.css'; // Global styles
import PwaRegister from './pwa-register';
import InstallPrompt from './install-prompt';

const inter = Inter({ subsets: ['latin'], variable: '--font-sans' });
const spaceGrotesk = Space_Grotesk({ subsets: ['latin'], variable: '--font-display' });

export const metadata: Metadata = {
  title: 'SaccoOs',
  description: 'Manage Sacco wallets, loans, and transaction tracking with ease.',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    title: 'SaccoOs',
    statusBarStyle: 'default',
  },
  openGraph: {
    title: 'SaccoOs',
    description: 'Manage Sacco wallets, loans, and transaction tracking with ease.',
  },
};

export const viewport: Viewport = {
  themeColor: '#7C2D12',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';

  return (
    <html lang="en" className={`${inter.variable} ${spaceGrotesk.variable}`} suppressHydrationWarning>
      <body className="font-sans antialiased bg-zinc-50 text-zinc-900" suppressHydrationWarning>
        <script
          id="env-init"
          dangerouslySetInnerHTML={{
            __html: `window.ENV = ${JSON.stringify({
              NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
              NEXT_PUBLIC_SUPABASE_ANON_KEY: supabaseAnonKey
            }).replace(/</g, '\\u003c')};`,
          }}
        />
        {children}
        <PwaRegister />
        <InstallPrompt />
      </body>
    </html>
  );
}
