import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import '../estilo.css';

export const metadata: Metadata = {
  title: 'Radar',
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
