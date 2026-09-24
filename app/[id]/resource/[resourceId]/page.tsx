import { ResourceDetail } from '~/components/patch/resource-detail/ResourceDetail'
import { ErrorComponent } from '~/components/error/ErrorComponent'
import { KunBreadcrumbTitle } from '~/components/kun/BreadcrumbTitle'
import { KunNull } from '~/components/kun/Null'
import { generateKunMetadataTemplate } from './metadata'
import { getResourcePageTitle } from '~/utils/patch/getResourcePageTitle'
import { kunGetResourceDetailActions } from './actions'
import { verifyHeaderCookie } from '~/utils/actions/verifyHeaderCookie'
import { getNSFWHeader } from '~/utils/actions/getNSFWHeader'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'

const isValidPatchId = (id: string) => /^[A-Za-z0-9]{8}$/.test(id)
const isValidResourceId = (resourceId: string) => /^\d{1,7}$/.test(resourceId)

const isNsfwAllowed = (nsfwHeader: { content_limit?: string }) =>
  nsfwHeader.content_limit !== 'sfw'

interface Props {
  params: Promise<{ id: string; resourceId: string }>
}

export const generateMetadata = async ({
  params
}: Props): Promise<Metadata> => {
  const { id, resourceId } = await params
  if (!isValidPatchId(id) || !isValidResourceId(resourceId)) {
    return {}
  }

  const [detail, nsfwHeader] = await Promise.all([
    kunGetResourceDetailActions(Number(resourceId)),
    getNSFWHeader()
  ])
  if (typeof detail === 'string' || detail.resource.uniqueId !== id) {
    return {}
  }

  return generateKunMetadataTemplate(detail, isNsfwAllowed(nsfwHeader))
}

export default async function Kun({ params }: Props) {
  const { id, resourceId } = await params
  if (!isValidPatchId(id) || !isValidResourceId(resourceId)) {
    notFound()
  }

  const [detail, payload, nsfwHeader] = await Promise.all([
    kunGetResourceDetailActions(Number(resourceId)),
    verifyHeaderCookie(),
    getNSFWHeader()
  ])
  if (typeof detail === 'string') {
    return <ErrorComponent error={detail} />
  }
  // 资源存在但不属于 URL 中的 patch: 与不存在等同, 防跨 patch 拼接链接
  if (detail.resource.uniqueId !== id) {
    notFound()
  }

  const isNsfwBlocked =
    detail.contentLimit === 'nsfw' && !isNsfwAllowed(nsfwHeader)

  return (
    <div className="container pt-4 pb-6 mx-auto space-y-6">
      <KunBreadcrumbTitle
        routeKey={`/${id}`}
        title={isNsfwBlocked ? '' : detail.patchName}
      />
      <KunBreadcrumbTitle
        routeKey={`/${id}/resource/${detail.resource.id}`}
        title={isNsfwBlocked ? '' : getResourcePageTitle(detail.resource)}
      />
      {isNsfwBlocked ? (
        <KunNull
          message={
            !payload?.uid
              ? '请登录后查看'
              : '请在右上角菜单开启 NSFW 内容显示后查看'
          }
        />
      ) : (
        <ResourceDetail detail={detail} isLoggedIn={!!payload?.uid} />
      )}
    </div>
  )
}
