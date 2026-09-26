import {
  getAdjacentPosts,
  getAllPosts,
  getPostBySlug
} from '~/lib/mdx/getPosts'
import { CustomMDX } from '~/lib/mdx/CustomMDX'
import { extractKunHeadings } from '~/lib/mdx/extractHeadings'
import { TableOfContents } from '~/components/doc/TableOfContents'
import { KunMobileTOC } from '~/components/doc/MobileTOC'
import { KunBottomNavigation } from '~/components/doc/Navigation'
import { generateKunMetadataTemplate } from './metadata'
import { BlogHeader } from '~/components/doc/BlogHeader'
import { KunBreadcrumbTitle } from '~/components/kun/BreadcrumbTitle'
import type { Metadata } from 'next'

export const dynamic = 'force-static'
export const dynamicParams = false

interface Props {
  params: Promise<{
    slug: string[]
  }>
}

export const generateStaticParams = async () => {
  const posts = getAllPosts()
  return posts.map((post) => ({
    slug: post.slug.split('/')
  }))
}

export const generateMetadata = async ({
  params
}: Props): Promise<Metadata> => {
  const { slug } = await params
  const url = slug.join('/')
  const blog = getPostBySlug(url)
  return generateKunMetadataTemplate(blog)
}

export default async function Kun({ params }: Props) {
  const { slug } = await params
  const url = slug.join('/')
  const { content, frontmatter } = getPostBySlug(url)
  const { prev, next } = getAdjacentPosts(url)
  const headings = extractKunHeadings(content)

  return (
    <div className="flex w-full min-w-0 gap-6">
      <KunBreadcrumbTitle routeKey={`/doc/${url}`} title={frontmatter.title} />
      <div className="min-w-0 flex-1">
        <div className="space-y-6">
          <BlogHeader frontmatter={frontmatter} />
          <KunMobileTOC headings={headings} />
          <article className="kun-prose rounded-[22px] border border-default-200/60 bg-background p-5 shadow-[0_12px_32px_rgba(15,23,42,0.05)] dark:bg-content1 dark:shadow-[0_12px_32px_rgba(0,0,0,0.15)] sm:p-8">
            <CustomMDX source={content} />
          </article>
          <KunBottomNavigation prev={prev} next={next} />
        </div>
      </div>

      <TableOfContents headings={headings} />
    </div>
  )
}
