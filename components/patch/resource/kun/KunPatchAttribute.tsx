import { Chip } from '@heroui/chip'
import { SUPPORTED_LANGUAGE_MAP } from '~/constants/resource'
import { cn } from '~/utils/cn'

// 词表取自 moyu 站自身 (与 TouchGal 的类型/平台体系不同)
const SUPPORTED_TYPE_MAP: Record<string, string> = {
  all: '全部类型',
  manual: '人工翻译补丁',
  ai: 'AI 翻译补丁',
  machine_polishing: '机翻润色',
  machine: '机翻补丁',
  save: '全 CG 存档',
  crack: '破解补丁',
  fix: '修正补丁',
  mod: '魔改补丁',
  r18: 'R18 成人内容补丁',
  decensor: '去马赛克补丁',
  image: '修图补丁',
  other: '其它'
}

const SUPPORTED_PLATFORM_MAP: Record<string, string> = {
  windows: 'Windows',
  android: 'Android',
  macos: 'MacOS',
  ios: 'iOS',
  linux: 'Linux',
  other: '其它'
}

interface Props {
  types: string[]
  languages: string[]
  platforms: string[]
  modelName?: string
  className?: string
  size?: 'lg' | 'md' | 'sm'
}

export const KunPatchAttribute = ({
  types,
  languages,
  platforms,
  modelName = '',
  className = '',
  size = 'md'
}: Props) => {
  return (
    <div className={cn('flex flex-wrap gap-2', className)}>
      {types.map((type) => (
        <Chip key={type} variant="flat" color="primary" size={size}>
          {SUPPORTED_TYPE_MAP[type]}
        </Chip>
      ))}
      {languages.map((lang) => (
        <Chip key={lang} variant="flat" color="secondary" size={size}>
          {SUPPORTED_LANGUAGE_MAP[lang]}
        </Chip>
      ))}
      {platforms.map((platform) => (
        <Chip key={platform} variant="flat" color="success" size={size}>
          {SUPPORTED_PLATFORM_MAP[platform]}
        </Chip>
      ))}
      {modelName && (
        <Chip variant="flat" color="danger" size={size}>
          {modelName}
        </Chip>
      )}
    </div>
  )
}
