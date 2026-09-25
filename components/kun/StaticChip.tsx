import type { ReactNode } from 'react'

// HeroUI Chip 每个实例都要跑 usePress / useFocusRing 与 3 次 tailwind-variants
// 类名计算, /resource 首屏 225 个、/company 300 个, 是这两页卡片水合与 SSR 的主成本
// (C34: 50 卡水合任务 144ms → 88ms, SSR 8.0ms → 2.2ms)。纯展示的徽章改用静态类名;
// 下表逐字取自 @heroui/theme `chip({ variant: 'flat' })` 的 base + content 输出
// (base 与 content 两层 padding 合并为一层), 守护测试比对色板与尺寸 token 防止漂移
export type KunStaticChipColor =
  'default' | 'primary' | 'secondary' | 'success' | 'warning' | 'danger'

export type KunStaticChipSize = 'sm' | 'md' | 'lg'

export const KUN_STATIC_CHIP_COLOR_CLASS: Record<KunStaticChipColor, string> = {
  default: 'bg-default/40 text-default-700',
  primary: 'bg-primary/20 text-primary-600',
  secondary: 'bg-secondary/20 text-secondary-600',
  success: 'bg-success/20 text-success-700 dark:text-success',
  warning: 'bg-warning/20 text-warning-700 dark:text-warning',
  danger: 'bg-danger/20 text-danger-600 dark:text-danger-500'
}

export const KUN_STATIC_CHIP_SIZE_CLASS: Record<KunStaticChipSize, string> = {
  sm: 'h-6 px-2 text-tiny',
  md: 'h-7 px-3 text-small',
  lg: 'h-8 px-4 text-medium'
}

const KUN_STATIC_CHIP_BASE_CLASS =
  'inline-flex max-w-fit min-w-min items-center whitespace-nowrap rounded-full font-normal'

interface Props {
  color?: KunStaticChipColor
  size?: KunStaticChipSize
  className?: string
  children: ReactNode
}

export const KunStaticChip = ({
  color = 'default',
  size = 'md',
  className,
  children
}: Props) => {
  const classes = `${KUN_STATIC_CHIP_BASE_CLASS} ${KUN_STATIC_CHIP_SIZE_CLASS[size]} ${KUN_STATIC_CHIP_COLOR_CLASS[color]}`

  return (
    <span className={className ? `${classes} ${className}` : classes}>
      {children}
    </span>
  )
}
