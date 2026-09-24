'use client'

import { Card, CardBody, CardFooter } from '@heroui/react'
import { ArrowRight, Calendar, Type } from 'lucide-react'
import { Image } from '@heroui/image'
import { KunPostMetadata } from '~/lib/mdx/types'
import { KunTimeAgo } from '~/components/kun/TimeAgo'
import Link from 'next/link'

interface Props {
  post: KunPostMetadata
}

export const KunAboutCard = ({ post }: Props) => {
  const textCount = Math.max(post.textCount, 0)

  return (
    <Card
      isPressable
      as={Link}
      href={`/doc/${post.slug}`}
      className="group w-full overflow-hidden rounded-[22px] border border-default-200/60 bg-background shadow-[0_12px_32px_rgba(15,23,42,0.05)] transition-[box-shadow,transform,scale] duration-300 hover:shadow-[0_16px_42px_rgba(15,23,42,0.08)] motion-reduce:transition-none dark:bg-content1 dark:shadow-[0_12px_32px_rgba(0,0,0,0.15)]"
    >
      <CardBody className="p-0">
        <div
          className="relative w-full overflow-hidden bg-default-100"
          style={{ aspectRatio: '16/9' }}
        >
          {/* opacity-95 经 twMerge 顶掉 HeroUI img slot 的 opacity-0, 否则 SSR 头图要等水合才可见 */}
          <Image
            removeWrapper
            radius="none"
            alt={post.title}
            className="absolute inset-0 block size-full object-cover opacity-95 transition-all duration-300 group-hover:scale-105"
            loading="lazy"
            src={post.banner}
          />
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-background/70 via-transparent to-transparent opacity-0 transition-opacity duration-200 group-hover:opacity-100" />
        </div>

        <div className="space-y-3 p-4">
          <h2 className="text-lg font-bold leading-snug transition-colors line-clamp-2 group-hover:text-primary-500">
            {post.title}
          </h2>
          <div className="flex flex-wrap items-center gap-2 text-xs text-default-500">
            <div className="flex items-center gap-1">
              <Calendar className="size-3.5 text-primary-400" />
              <time>
                <KunTimeAgo date={post.date} />
              </time>
            </div>
            <div className="flex items-center gap-1">
              <Type className="size-3.5 text-secondary-400" />
              <span>{textCount} 字</span>
            </div>
          </div>
        </div>
      </CardBody>
      <CardFooter className="justify-between border-t border-default-200/60 bg-default-50/60 px-4 py-3 dark:bg-default-100/10">
        <span className="text-sm font-medium text-default-600">阅读文档</span>
        <ArrowRight className="size-4 text-primary-500 transition-transform duration-200 group-hover:translate-x-0.5 motion-reduce:transition-none" />
      </CardFooter>
    </Card>
  )
}
