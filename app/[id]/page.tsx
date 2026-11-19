import { PatchHeaderContainer } from '~/components/patch/header/Container'
import { KunBreadcrumbTitle } from '~/components/kun/BreadcrumbTitle'
import { generateKunMetadataTemplate } from './metadata'
import {
  kunGetPatchPageDataActions,
  kunUpdatePatchViewsActions
} from './actions'
import { verifyHeaderCookie } from '~/utils/actions/verifyHeaderCookie'
import { getViewerContext } from '~/server/viewer/fromHeaders'
import { getPatchPageTitle } from '~/utils/patch/getPatchPageTitle'
import { after } from 'next/server'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'

const isValidPatchId = (id: string) => /^[A-Za-z0-9]{8}$/.test(id)

const isNsfwAllowed = async () =>
  (await (await getViewerContext()).visibility()).contentLimit !== 'sfw'

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

  const [pageData, nsfwAllowed] = await Promise.all([
    kunGetPatchPageDataActions(id),
    isNsfwAllowed()
  ])

  return generateKunMetadataTemplate(
    pageData.patch,
    pageData.intro,
    nsfwAllowed
  )
}

export default async function Kun({ params }: Props) {
  const { id } = await params
  if (!isValidPatchId(id)) {
    notFound()
  }

  const [pageData, payload, nsfwAllowed] = await Promise.all([
    kunGetPatchPageDataActions(id),
    verifyHeaderCookie(),
    isNsfwAllowed()
  ])

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
      />
    </div>
  )
}
