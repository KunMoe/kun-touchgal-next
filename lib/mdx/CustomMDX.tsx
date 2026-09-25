import { MDXRemote, MDXRemoteProps } from 'next-mdx-remote/rsc'
import remarkGfm from 'remark-gfm'
import { KunLink } from './element/KunLink'
import { KunTable } from './element/KunTable'
import { KunCode } from './element/KunCode'
import { createKunHeading } from './element/kunHeading'
import type { ComponentPropsWithoutRef } from 'react'

const NativeTable = (props: ComponentPropsWithoutRef<'table'>) => (
  <div className="overflow-x-auto">
    <table {...props} />
  </div>
)

// fetchPriority="low" 让 React 不为正文图发 image preload (Flight 的 :HL 提示与 head 里的 link),
// 否则 /doc 链接一被预取就会下载整篇正文图, 月报目录侧栏一次近 2MB
const NativeImage = ({ alt, ...props }: ComponentPropsWithoutRef<'img'>) => (
  <img alt={alt} {...props} fetchPriority="low" />
)

const components = {
  h1: createKunHeading(1),
  h2: createKunHeading(2),
  h3: createKunHeading(3),
  h4: createKunHeading(4),
  h5: createKunHeading(5),
  h6: createKunHeading(6),
  a: KunLink,
  code: KunCode,
  table: NativeTable,
  img: NativeImage,
  Table: KunTable
}

export const CustomMDX = (props: MDXRemoteProps) => {
  return (
    <MDXRemote
      {...props}
      options={{
        ...(props.options || {}),
        mdxOptions: {
          ...(props.options?.mdxOptions || {}),
          remarkPlugins: [
            ...((props.options?.mdxOptions?.remarkPlugins as []) || []),
            remarkGfm
          ]
        }
      }}
      components={{ ...components, ...(props.components || {}) }}
    />
  )
}
