'use client'

import { useShallow } from 'zustand/react/shallow'
import { Switch } from '@heroui/react'
import { useCreatePatchStore } from '~/store/editStore'
import { GALGAME_AGE_LIMIT_MAP } from '~/constants/galgame'

interface Props {
  errors: string | undefined
}

export const ContentLimit = ({ errors }: Props) => {
  const { data, update } = useCreatePatchStore(
    useShallow((state) => ({ data: state.data, update: state.update }))
  )

  return (
    <div className="space-y-2">
      <h2 className="text-xl">文章内容分级</h2>
      <Switch
        defaultSelected
        color="danger"
        size="lg"
        isSelected={data.contentLimit === 'nsfw'}
        onValueChange={(value) => {
          if (value) {
            update({ contentLimit: 'nsfw' })
          } else {
            update({ contentLimit: 'sfw' })
          }
        }}
      >
        {GALGAME_AGE_LIMIT_MAP[data.contentLimit]}
      </Switch>

      {errors && <p className="text-xs text-danger-500">{errors}</p>}
    </div>
  )
}
