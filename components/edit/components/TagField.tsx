'use client'

import { useEffect, useState } from 'react'
import { Chip, Textarea } from '@heroui/react'
import { Undo2, X } from 'lucide-react'
import { cn } from '~/utils/cn'
import {
  normalizeStringArray,
  parseCommaSeparatedStringArray
} from '~/utils/normalizeStringArray'
import { removeExternalTag } from '~/utils/removeExternalPatchData'
import type { KunFormUpdate, PatchFormDataShape } from '~/components/edit/types'

interface TagEntry {
  name: string
  source: string
}

const SOURCE_COLORS: Record<
  string,
  'primary' | 'secondary' | 'success' | 'warning'
> = {
  VNDB: 'secondary',
  Bangumi: 'success',
  Steam: 'warning',
  DLsite: 'primary'
}

const collectExternalTags = (data: PatchFormDataShape): TagEntry[] => {
  const entries: TagEntry[] = []

  for (const name of data.vndbTags) {
    if (name.trim()) entries.push({ name: name.trim(), source: 'VNDB' })
  }
  for (const name of data.bangumiTags) {
    if (name.trim()) entries.push({ name: name.trim(), source: 'Bangumi' })
  }
  for (const name of data.steamTags) {
    if (name.trim()) entries.push({ name: name.trim(), source: 'Steam' })
  }
  for (const name of data.dlsiteTags) {
    if (name.trim()) entries.push({ name: name.trim(), source: 'DLsite' })
  }

  return entries.filter(
    (entry, i, arr) => arr.findIndex((e) => e.name === entry.name) === i
  )
}

// 游戏现有的标签。按 id 标记移除, 不进文本框: 名字经逗号文本往返会被拆开
// (名字里可以有逗号), 提交时就成了「删掉原标签、新建几个碎片」
interface ExistingTags {
  tags: { id: number; name: string }[]
  removeTagIds: number[]
  onToggleRemove: (id: number) => void
}

interface Props {
  data: PatchFormDataShape
  update: KunFormUpdate<PatchFormDataShape>
  errors?: string
  // 只有重写页传: 建档时游戏还没有标签
  existing?: ExistingTags
}

export const TagField = ({ data, update, errors, existing }: Props) => {
  const externalTags = collectExternalTags(data)
  const [manualTagInput, setManualTagInput] = useState(() =>
    normalizeStringArray(data.tag).join(',')
  )

  useEffect(() => {
    const normalizedTags = normalizeStringArray(data.tag)
    const currentInputTags = parseCommaSeparatedStringArray(manualTagInput)

    if (normalizedTags.join(',') !== currentInputTags.join(',')) {
      setManualTagInput(normalizedTags.join(','))
    }
  }, [data.tag, manualTagInput])

  const removedIds = new Set(existing?.removeTagIds)

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <h2 className="text-xl">游戏标签 (可选)</h2>
        {errors && <p className="text-xs text-danger-500">{errors}</p>}
      </div>

      {existing && existing.tags.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm text-default-500">
            游戏现有的标签, 点击标记移除, 再次点击撤销
            {removedIds.size > 0 &&
              ` (已标记移除 ${removedIds.size} 个, 提交后生效)`}
          </p>
          {/* 存量最多的游戏有 165 个标签, 限高滚动 */}
          <ul
            role="list"
            className="flex flex-wrap gap-2 overflow-y-auto max-h-48"
          >
            {existing.tags.map((tag) => {
              const removed = removedIds.has(tag.id)
              return (
                <li key={tag.id}>
                  <button
                    type="button"
                    aria-pressed={removed}
                    aria-label={`移除标签 ${tag.name}`}
                    onClick={() => existing.onToggleRemove(tag.id)}
                    className={cn(
                      'inline-flex min-h-7 items-center gap-1 rounded-full border px-2.5 text-tiny',
                      'outline-offset-2 focus-visible:outline-2 focus-visible:outline-focus',
                      removed
                        ? 'border-default-300 text-default-400'
                        : 'border-transparent bg-default/40 text-default-700'
                    )}
                  >
                    <span className={cn(removed && 'line-through')}>
                      {tag.name}
                    </span>
                    {removed ? (
                      <Undo2 aria-hidden="true" className="size-3.5" />
                    ) : (
                      <X aria-hidden="true" className="size-3.5" />
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {externalTags.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm text-default-500">
            以下标签来自外部数据源，将在提交时自动关联
          </p>
          <div className="flex flex-wrap gap-2">
            {externalTags.map((entry) => (
              <Chip
                key={`${entry.source}-${entry.name}`}
                variant="flat"
                size="sm"
                color={SOURCE_COLORS[entry.source]}
                onClose={() =>
                  update((prev) => removeExternalTag(prev, entry.name))
                }
              >
                {entry.name}
                <span className="ml-1 opacity-60">({entry.source})</span>
              </Chip>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-2">
        <p className="text-sm text-default-500">手动添加标签</p>
        <Textarea
          aria-label="手动添加标签"
          placeholder="批量添加标签, 每个标签需要使用英语逗号 ( , ) 分隔"
          value={manualTagInput}
          onChange={(e) => {
            const input = e.target.value
            setManualTagInput(input)
            update({ tag: parseCommaSeparatedStringArray(input) })
          }}
          className="w-full"
          minRows={3}
        />
        <p className="text-sm text-default-500">
          {existing
            ? '这里只填写要新增的标签, 无该标签时将会自动创建标签'
            : '无该标签时将会自动创建标签'}
        </p>
      </div>
    </div>
  )
}
