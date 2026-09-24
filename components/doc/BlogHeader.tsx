import { Card, CardBody, CardHeader } from '@heroui/card'
import { Chip } from '@heroui/chip'
import { Image } from '@heroui/image'
import { CalendarDays, UserRound } from 'lucide-react'
import { formatDate } from '~/utils/time'
import { KunAvatar } from '~/components/kun/floating-card/KunAvatar'
import type { KunFrontmatter } from '~/lib/mdx/types'

interface BlogHeaderProps {
  frontmatter: KunFrontmatter
}

export const BlogHeader = ({ frontmatter }: BlogHeaderProps) => {
  return (
    <Card className="overflow-hidden rounded-[22px] border border-default-200/60 bg-background shadow-[0_12px_32px_rgba(15,23,42,0.05)] dark:bg-content1 dark:shadow-[0_12px_32px_rgba(0,0,0,0.15)]">
      <CardHeader className="block p-0">
        <div className="relative aspect-[16/9] w-full overflow-hidden bg-default-100 sm:aspect-[16/7]">
          {/* opacity-100 经 twMerge 顶掉 HeroUI img slot 的 opacity-0, 否则静态页头图 (LCP) 要等水合才可见 */}
          <Image
            removeWrapper
            radius="none"
            alt={frontmatter.title}
            className="absolute inset-0 block size-full object-cover opacity-100"
            src={frontmatter.banner}
            width="100%"
            height="100%"
          />
          <div className="pointer-events-none absolute inset-0 z-10 hidden bg-gradient-to-t from-black/80 via-black/35 to-transparent sm:block" />
          <div className="absolute inset-x-0 bottom-0 z-20 hidden p-5 sm:block sm:p-8">
            <Chip color="primary" variant="flat" className="bg-white/85">
              帮助文档
            </Chip>
            <h1 className="mt-3 max-w-4xl text-3xl font-bold leading-tight tracking-tight text-white drop-shadow-sm sm:text-5xl">
              {frontmatter.title}
            </h1>
            {frontmatter.description && (
              <p className="mt-3 max-w-3xl text-sm leading-6 text-white/85 sm:text-base">
                {frontmatter.description}
              </p>
            )}
          </div>
        </div>
      </CardHeader>

      <CardBody className="p-5 sm:p-6">
        <div className="mb-5 space-y-3 sm:hidden">
          <Chip color="primary" variant="flat">
            帮助文档
          </Chip>
          <h1 className="text-2xl font-bold leading-tight tracking-tight text-foreground">
            {frontmatter.title}
          </h1>
          {frontmatter.description && (
            <p className="text-sm leading-6 text-default-600">
              {frontmatter.description}
            </p>
          )}
        </div>
        <div className="flex items-center justify-between gap-3 sm:gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <KunAvatar
              uid={frontmatter.authorUid}
              avatarProps={{
                isBordered: true,
                radius: 'full',
                size: 'md',
                name: frontmatter.authorName,
                src: frontmatter.authorAvatar,
                className: 'shrink-0'
              }}
            />
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-small text-default-500">
                <UserRound className="size-4" />
                <span>作者</span>
              </div>
              <h2 className="mt-1 font-semibold leading-none text-foreground">
                {frontmatter.authorName}
              </h2>
            </div>
          </div>

          <span
            aria-label="文章发布时间"
            className="inline-flex h-7 w-fit shrink-0 items-center gap-1.5 rounded-full bg-secondary-500/10 px-3 text-sm font-medium leading-none text-secondary-600 dark:text-secondary-400"
          >
            <CalendarDays className="size-4 shrink-0" aria-hidden="true" />
            <time dateTime={new Date(frontmatter.date).toISOString()}>
              {formatDate(frontmatter.date, {
                isShowYear: true
              })}
            </time>
          </span>
        </div>
      </CardBody>
    </Card>
  )
}
