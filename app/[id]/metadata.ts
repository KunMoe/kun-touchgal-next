import { kunMoyuMoe } from '~/config/moyu-moe'
import { convert } from 'html-to-text'
import { getPatchPageTitle } from '~/utils/patch/getPatchPageTitle'
import { generateNullMetadata } from '~/utils/noIndex'
import { kunPageMetadata } from '~/utils/pageMetadata'
import type { Metadata } from 'next'
import type { Patch, PatchIntroduction } from '~/types/api/patch'

export const generateKunMetadataTemplate = (
  patch: Patch,
  intro: PatchIntroduction,
  nsfwAllowed: boolean
): Metadata => {
  if (patch.contentLimit === 'nsfw' && !nsfwAllowed) {
    return generateNullMetadata('')
  }

  return {
    ...kunPageMetadata({
      title: getPatchPageTitle(patch),
      description: convert(intro.introduction, {
        wordwrap: false,
        selectors: [{ selector: 'p', format: 'inline' }]
      }).slice(0, 170),
      keywords: [patch.name, ...patch.alias],
      canonicalPath: `/${patch.uniqueId}`,
      social: {
        title: patch.alias.length
          ? `${patch.name} | ${patch.alias[0]}`
          : `${patch.name}`,
        description: convert(intro.introduction).slice(0, 170),
        images: [
          { url: patch.banner, width: 1920, height: 1080, alt: patch.name }
        ],
        article: {
          publishedTime: patch.created,
          modifiedTime: patch.updated
        },
        card: 'summary'
      }
    }),
    authors: kunMoyuMoe.author,
    creator: patch.user.name,
    publisher: patch.user.name
  }
}
