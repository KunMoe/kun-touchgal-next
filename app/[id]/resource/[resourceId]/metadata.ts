import { convert } from 'html-to-text'
import { generateNullMetadata } from '~/utils/noIndex'
import { kunPageMetadata } from '~/utils/pageMetadata'
import { getResourcePageTitle } from '~/utils/patch/getResourcePageTitle'
import type { Metadata } from 'next'
import type { PatchResourceDetail } from '~/app/api/patch/resource/detail'

export const generateKunMetadataTemplate = (
  detail: PatchResourceDetail,
  nsfwAllowed: boolean
): Metadata => {
  if (detail.contentLimit === 'nsfw' && !nsfwAllowed) {
    return generateNullMetadata('')
  }

  const { resource } = detail

  return kunPageMetadata({
    title: `${getResourcePageTitle(resource)} | ${detail.patchName}`,
    description: convert(resource.noteHtml, {
      wordwrap: false,
      selectors: [{ selector: 'p', format: 'inline' }]
    }).slice(0, 170),
    canonicalPath: `/${resource.uniqueId}/resource/${resource.id}`,
    social: { article: {}, card: 'summary' }
  })
}
