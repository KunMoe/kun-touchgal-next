'use client'

import { useLayoutEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Card, CardBody } from '@heroui/card'
import { Chip } from '@heroui/chip'
import { Image } from '@heroui/image'
import { SUPPORTED_TYPE_MAP } from '~/constants/resource'
import { cn } from '~/utils/cn'
import { kunCjkIndentClass } from '~/utils/kunCjkIndent'

// 分类 chip 最多两行, 溢出时去掉第二行末位 chip 腾位, 以省略号 chip 收尾;
// 隐藏测量层渲染全部 chip, 显示层按测量结果截断, 宽度变化时经 ResizeObserver 重算;
// 截断要到水合才发生, SSR 首帧显示层是全量 chip, 靠 max-h-14 封顶到两行,
// 否则移动端水合时卡片变矮、下方主列整体上移 32px/行 (CLS 0.03–0.06);
// 56px = 2 × h-6 (Chip size="sm") + gap-2, 与 chip 尺寸耦合; 测量层不能封顶, 否则测不出溢出
const TypeChips = ({ types }: { types: string[] }) => {
  const measureRef = useRef<HTMLDivElement>(null)
  const [visibleCount, setVisibleCount] = useState(types.length)

  useLayoutEffect(() => {
    const measure = measureRef.current
    if (!measure) {
      return
    }

    const compute = () => {
      const chips = Array.from(measure.children) as HTMLElement[]
      if (!chips.length) {
        return
      }
      const rowTops: number[] = []
      for (const chip of chips) {
        if (!rowTops.includes(chip.offsetTop)) {
          rowTops.push(chip.offsetTop)
        }
      }
      if (rowTops.length <= 2) {
        setVisibleCount(chips.length)
        return
      }
      const firstTwoRowCount = chips.filter(
        (chip) => chip.offsetTop <= rowTops[1]
      ).length
      setVisibleCount(Math.max(1, firstTwoRowCount - 1))
    }

    compute()
    const observer = new ResizeObserver(compute)
    observer.observe(measure)
    return () => observer.disconnect()
  }, [types])

  const renderChip = (type: string) => (
    <Chip key={type} variant="flat" color="primary" size="sm">
      {SUPPORTED_TYPE_MAP[type] ?? type}
    </Chip>
  )

  return (
    <div className="relative">
      <div
        ref={measureRef}
        aria-hidden
        className="pointer-events-none invisible absolute inset-x-0 top-0 flex flex-wrap gap-2"
      >
        {types.map(renderChip)}
      </div>
      <div className="flex max-h-14 flex-wrap gap-2 overflow-hidden">
        {types.slice(0, visibleCount).map(renderChip)}
        {visibleCount < types.length && (
          <Chip variant="flat" color="primary" size="sm">
            …
          </Chip>
        )}
      </div>
    </div>
  )
}

interface Props {
  galgame: GalgameCard
}

// 资源页顶部的所属游戏简版卡片: 仅封面 / 游戏名 / 分类, 点击返回游戏详情页;
// 封面贴卡片上左下边缘 (右侧无圆角), hover 蓝边与游戏页资源卡一致;
// 边线必须经 after 伪元素叠画在内容之上: 占位 border 会把封面推出 1px 缝,
// 盒外 ring 在深色封面旁读作白缝, 普通 inset ring 会被贴边封面遮住;
// 线色必须半透明 (divider): 不透明浅灰压在深色封面上仍读作白线;
// rounded-large 与 HeroUI Card 默认圆角耦合 (rounded-[inherit] 在 v4 不生成);
// after:z-20 必须压过 HeroUI Image 自带的 z-10, 否则线在封面区域被图片盖住
export const GalgameSummaryCard = ({ galgame }: Props) => {
  const [bannerFailed, setBannerFailed] = useState(false)

  return (
    <Card
      isPressable
      as={Link}
      href={`/${galgame.uniqueId}`}
      className="group w-full after:pointer-events-none after:absolute after:inset-0 after:z-20 after:rounded-large after:ring-1 after:ring-inset after:ring-divider after:transition hover:after:ring-primary-400"
    >
      <CardBody className="flex flex-row items-stretch gap-4 p-0 sm:gap-6">
        <div className="relative aspect-video w-32 shrink-0 bg-default-100 sm:w-48">
          {/* opacity-100 经 twMerge 顶掉 HeroUI img slot 的 opacity-0, 否则 SSR 封面要等水合才可见 */}
          <Image
            radius="none"
            removeWrapper
            alt={galgame.name}
            className="absolute inset-0 size-full object-cover opacity-100"
            src={
              galgame.banner && !bannerFailed
                ? galgame.banner.replace(/\.avif$/, '-mini.avif')
                : '/touchgal.avif'
            }
            onError={() => setBannerFailed(true)}
          />
        </div>

        <div className="flex min-w-0 flex-1 flex-col justify-center gap-2 py-3 pr-3 text-left sm:py-4 sm:pr-4">
          <h2
            className={cn(
              'line-clamp-2 break-all text-lg font-bold leading-snug transition-colors group-hover:text-primary-500 sm:text-xl',
              kunCjkIndentClass(galgame.name)
            )}
          >
            {galgame.name}
          </h2>
          <TypeChips types={galgame.type} />
        </div>
      </CardBody>
    </Card>
  )
}
