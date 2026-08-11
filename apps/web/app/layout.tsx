import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import '../src/index.css'

export const metadata: Metadata = {
  title: 'Vibe Writer',
  description: '可中断、可恢复的 AI 写作工作台',
}

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <main id="app-root">{children}</main>
      </body>
    </html>
  )
}
