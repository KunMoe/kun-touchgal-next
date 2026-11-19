'use client'

import { Chip } from '@heroui/react'
import type { KunFormUpdate, PatchFormDataShape } from '~/components/edit/types'
import { removeExternalCompany } from '~/utils/removeExternalPatchData'

interface Props {
  data: PatchFormDataShape
  update: KunFormUpdate<PatchFormDataShape>
}

interface CompanyEntry {
  name: string
  source: string
}

export const CompanySummary = ({ data, update }: Props) => {
  const entries: CompanyEntry[] = []

  for (const name of data.vndbDevelopers) {
    if (name.trim()) entries.push({ name: name.trim(), source: 'VNDB' })
  }
  for (const name of data.bangumiDevelopers) {
    if (name.trim()) entries.push({ name: name.trim(), source: 'Bangumi' })
  }
  for (const name of data.steamDevelopers) {
    if (name.trim()) entries.push({ name: name.trim(), source: 'Steam' })
  }
  if (data.dlsiteCircleName?.trim()) {
    entries.push({ name: data.dlsiteCircleName.trim(), source: 'DLsite' })
  }

  const unique = entries.filter(
    (entry, i, arr) => arr.findIndex((e) => e.name === entry.name) === i
  )

  if (!unique.length) return null

  return (
    <div className="w-full space-y-2">
      <h2 className="text-xl">游戏会社 (自动获取)</h2>
      <p className="text-sm text-default-500">
        以下会社信息来自各外部数据源，将在提交时自动关联
      </p>
      <div className="flex flex-wrap gap-2">
        {unique.map((entry) => (
          <Chip
            key={`${entry.source}-${entry.name}`}
            variant="flat"
            size="sm"
            onClose={() =>
              update((prev) => removeExternalCompany(prev, entry.name))
            }
          >
            {entry.name}
            <span className="ml-1 text-default-400">({entry.source})</span>
          </Chip>
        ))}
      </div>
    </div>
  )
}
