import Image from 'next/image'
import Link from 'next/link'
import { generateNullMetadata } from '~/utils/noIndex'
import type { Metadata } from 'next'

// 不沿用根布局的 index / follow 与指向首页的 canonical
export const metadata: Metadata = generateNullMetadata('页面不存在')

// 全站未匹配的地址与页面读取器的 notFound() 都渲染这里。Next 会把本文件连同它引用的客户端组件
// 随每个路由下发, 所以保持 Server Component, 只用 next/link 与 next/image
export default function NotFound() {
  return (
    <div className="flex flex-col items-center gap-4 p-8 m-auto text-center">
      <Image
        className="rounded-2xl"
        src="/null.webp"
        alt=""
        width={150}
        height={150}
      />
      <h1 className="text-2xl font-bold">页面不存在</h1>
      <p className="text-default-500">
        您访问的页面不存在, 可能已被删除或地址有误
      </p>
      <Link
        href="/"
        className="inline-flex items-center justify-center h-10 px-4 transition-opacity rounded-medium bg-primary text-small text-primary-foreground hover:opacity-80"
      >
        返回首页
      </Link>
    </div>
  )
}
