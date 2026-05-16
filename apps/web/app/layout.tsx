import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AntdRegistry } from '@ant-design/nextjs-registry';
import 'antd/dist/reset.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'RelayDesk',
  description: 'NewAPI relay channel operations console',
  icons: {
    icon: '/icon.svg'
  }
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <AntdRegistry>{children}</AntdRegistry>
      </body>
    </html>
  );
}
