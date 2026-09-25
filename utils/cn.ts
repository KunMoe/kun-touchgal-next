import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'
import { twMergeConfig } from '@heroui/theme'

// 默认配置不认识 HeroUI 的 text-small / border-small 等, 会把它们当成颜色类删掉
const twMerge = extendTailwindMerge({ extend: twMergeConfig })

export const cn = (...inputs: ClassValue[]) => {
  return twMerge(clsx(inputs))
}
