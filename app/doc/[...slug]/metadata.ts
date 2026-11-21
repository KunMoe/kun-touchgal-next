import { kunPageMetadata } from '~/utils/pageMetadata'
import type { Metadata } from 'next'
import type { KunBlog } from '~/lib/mdx/types'

export const generateKunMetadataTemplate = (blog: KunBlog): Metadata => {
  const { slug, frontmatter } = blog

  return kunPageMetadata({
    title: frontmatter.title,
    description: frontmatter.description,
    canonicalPath: `/doc/${slug}`,
    social: {
      images: [
        {
          url: frontmatter.banner,
          width: 1920,
          height: 1080,
          alt: frontmatter.title
        }
      ],
      article: {
        publishedTime: frontmatter.date,
        modifiedTime: frontmatter.date
      }
    }
  })
}
