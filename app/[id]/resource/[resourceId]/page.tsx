import { ResourceDetail } from '~/components/patch/resource-detail/ResourceDetail'
import { KunBreadcrumbTitle } from '~/components/kun/BreadcrumbTitle'
import { KunNull } from '~/components/kun/Null'
import { generateKunMetadataTemplate } from './metadata'
import { getResourcePageTitle } from '~/utils/patch/getResourcePageTitle'
import { kunGetResourceDetailActions } from './actions'
import { verifyHeaderCookie } from '~/utils/actions/verifyHeaderCookie'
import { getViewerContext } from '~/server/viewer/fromHeaders'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'

const isValidPatchId = (id: string) => /^[A-Za-z0-9]{8}$/.test(id)
const isValidResourceId = (resourceId: string) => /^\d{1,7}$/.test(resourceId)

const isNsfwAllowed = async () =>
  (await (await getViewerContext()).visibility()).contentLimit !== 'sfw'

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

  const [detail, nsfwAllowed] = await Promise.all([
    kunGetResourceDetailActions(Number(resourceId)),
    isNsfwAllowed()
  ])
  if (detail.resource.uniqueId !== id) {
    return {}
  }

  return generateKunMetadataTemplate(detail, nsfwAllowed)
}

export default async function Kun({ params }: Props) {
  const { id, resourceId } = await params
  if (!isValidPatchId(id) || !isValidResourceId(resourceId)) {
    notFound()
  }

  const [detail, payload, nsfwAllowed] = await Promise.all([
    kunGetResourceDetailActions(Number(resourceId)),
    verifyHeaderCookie(),
    isNsfwAllowed()
  ])
  // 资源存在但不属于 URL 中的 patch: 与不存在等同, 防跨 patch 拼接链接
  if (detail.resource.uniqueId !== id) {
    notFound()
  }

  const isNsfwBlocked = detail.contentLimit === 'nsfw' && !nsfwAllowed

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
