'use client'

import { Switch } from '@heroui/react'
import { GALGAME_AGE_LIMIT_MAP } from '~/constants/galgame'

interface Props {
  contentLimit: string
  onChange: (contentLimit: string) => void
  errors: string | undefined
}

export const ContentLimit = ({ contentLimit, onChange, errors }: Props) => {
  return (
    <div className="space-y-2">
      <h2 className="text-xl">文章内容分级</h2>
      <Switch
        defaultSelected
        color="danger"
        size="lg"
        isSelected={contentLimit === 'nsfw'}
        onValueChange={(value) => onChange(value ? 'nsfw' : 'sfw')}
      >
        {GALGAME_AGE_LIMIT_MAP[contentLimit]}
      </Switch>

      {errors && <p className="text-xs text-danger-500">{errors}</p>}
    </div>
  )
}
