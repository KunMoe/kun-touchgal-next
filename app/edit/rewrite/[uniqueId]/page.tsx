import { RewritePatch } from '~/components/edit/rewrite/RewritePatch'
import { verifyHeaderCookie } from '~/utils/actions/verifyHeaderCookie'
import { notFound, redirect } from 'next/navigation'
import { kunMetadata } from '../metadata'
import { kunGetRewriteDataActions } from './actions'
import { can } from '~/constants/permission'
import type { Metadata } from 'next'

export const metadata: Metadata = kunMetadata

// 表单基线每次都现读库: 它会被原样写回数据库, 不能来自任何一层缓存
export const dynamic = 'force-dynamic'

interface Props {
  params: Promise<{ uniqueId: string }>
}

export default async function Kun({ params }: Props) {
  const payload = await verifyHeaderCookie()
  if (!can(payload, 'galgame.rewrite')) {
    redirect('/')
  }

  const { uniqueId } = await params
  const initial = await kunGetRewriteDataActions(uniqueId)
  if (!initial) {
    notFound()
  }

  return (
    <div className="flex items-center justify-center flex-1 max-w-5xl mx-auto w-96">
      {/* key: 换一个游戏就重建表单, 否则沿用上一个游戏的 store */}
      <RewritePatch key={initial.uniqueId} initial={initial} />
    </div>
  )
}
