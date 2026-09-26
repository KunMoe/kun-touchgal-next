import { PatchHeaderContainer } from '~/components/patch/header/Container'
import { ErrorComponent } from '~/components/error/ErrorComponent'
import { KunBreadcrumbTitle } from '~/components/kun/BreadcrumbTitle'
import { generateKunMetadataTemplate } from './metadata'
import {
  kunGetPatchPageDataActions,
  kunUpdatePatchViewsActions
} from './actions'
import { verifyHeaderCookie } from '~/utils/actions/verifyHeaderCookie'
import { getNSFWHeader } from '~/utils/actions/getNSFWHeader'
import { getPatchPageTitle } from '~/utils/patch/getPatchPageTitle'
import { after } from 'next/server'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'

const isValidPatchId = (id: string) => /^[A-Za-z0-9]{8}$/.test(id)

const isNsfwAllowed = (nsfwHeader: { content_limit?: string }) =>
  nsfwHeader.content_limit !== 'sfw'

interface Props {
  params: Promise<{ id: string }>
}

export const generateMetadata = async ({
  params
}: Props): Promise<Metadata> => {
  const { id } = await params
  if (!isValidPatchId(id)) {
    return {}
  }

  const [pageData, nsfwHeader] = await Promise.all([
    kunGetPatchPageDataActions(id),
    getNSFWHeader()
  ])
  if (typeof pageData === 'string') {
    return {}
  }

  return generateKunMetadataTemplate(
    pageData.patch,
    pageData.intro,
    isNsfwAllowed(nsfwHeader)
  )
}

export default async function Kun({ params }: Props) {
  const { id } = await params
  if (!isValidPatchId(id)) {
    notFound()
  }

  const [pageData, payload, nsfwHeader] = await Promise.all([
    kunGetPatchPageDataActions(id),
    verifyHeaderCookie(),
    getNSFWHeader()
  ])
  const nsfwAllowed = isNsfwAllowed(nsfwHeader)
  if (typeof pageData === 'string') {
    return <ErrorComponent error={pageData} />
  }

  after(() => kunUpdatePatchViewsActions({ uniqueId: id }))

  const isNsfwBlocked = pageData.patch.contentLimit === 'nsfw' && !nsfwAllowed

  return (
    <div className="container pt-4 pb-6 mx-auto space-y-6">
      <KunBreadcrumbTitle
        routeKey={`/${pageData.patch.uniqueId}`}
        title={isNsfwBlocked ? '' : getPatchPageTitle(pageData.patch)}
      />
      <PatchHeaderContainer
        patch={pageData.patch}
        intro={pageData.intro}
        uid={payload?.uid}
        nsfwAllowed={nsfwAllowed}
        canRewrite={!!payload && payload.role >= 3}
      />
    </div>
  )
}
