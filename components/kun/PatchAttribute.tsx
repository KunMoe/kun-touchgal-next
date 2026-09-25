'use client'

import { KunStaticChip } from '~/components/kun/StaticChip'
import {
  SUPPORTED_EMULATOR_TYPE_MAP,
  SUPPORTED_LANGUAGE_MAP,
  SUPPORTED_PLATFORM_MAP,
  SUPPORTED_TYPE_MAP
} from '~/constants/resource'

interface Props {
  types: string[]
  languages?: string[]
  platforms?: string[]
  emulatorType?: string[]
  modelName?: string
  size?: 'lg' | 'md' | 'sm'
  hidePatchType?: boolean
}

export const KunPatchAttribute = ({
  types,
  languages = [],
  platforms = [],
  emulatorType = [],
  modelName = '',
  size = 'md',
  hidePatchType = false
}: Props) => {
  return (
    <div className="flex flex-wrap gap-2">
      {types.map((type) =>
        hidePatchType && type === 'patch' ? null : (
          <KunStaticChip key={type} color="primary" size={size}>
            {SUPPORTED_TYPE_MAP[type]}
          </KunStaticChip>
        )
      )}
      {languages?.map((lang) => (
        <KunStaticChip key={lang} color="secondary" size={size}>
          {SUPPORTED_LANGUAGE_MAP[lang]}
        </KunStaticChip>
      ))}
      {platforms?.map((platform) => (
        <KunStaticChip key={platform} color="success" size={size}>
          {SUPPORTED_PLATFORM_MAP[platform]}
        </KunStaticChip>
      ))}
      {emulatorType.map((type) => (
        <KunStaticChip key={type} color="warning" size={size}>
          {SUPPORTED_EMULATOR_TYPE_MAP[type] ?? type}
        </KunStaticChip>
      ))}
      {modelName && (
        <KunStaticChip color="danger" size={size}>
          {modelName}
        </KunStaticChip>
      )}
    </div>
  )
}
