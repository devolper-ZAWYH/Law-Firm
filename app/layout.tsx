import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AlBaker Law Firm — Portal',
  description: 'Secure client & staff portal for Ali AlBaker Law Firm.',
  robots: { index: false, follow: false },
  icons: { icon: '/albaker-logo.png' },
};

export const viewport: Viewport = {
  themeColor: '#14212d',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" dir="ltr">
      <body>{children}</body>
    </html>
  );
}
