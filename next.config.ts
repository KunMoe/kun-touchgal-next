// import { fileURLToPath } from 'url'
import { env } from './validations/dotenv-check'
import { kunRscCacheHeaders } from './config/rsc-cache-headers'
import createMDX from '@next/mdx'
import type { NextConfig } from 'next'
// import remarkGfm from 'remark-gfm'
// import rehypeSlug from 'rehype-slug'
// import rehypeAutolinkHeadings from 'rehype-autolink-headings'
// import rehypePrettyCode from 'rehype-pretty-code'

// const __filename = fileURLToPath(import.meta.url)
// const __dirname = path.dirname(__filename)

const skipDeployBuildChecks =
  process.env.KUN_DEPLOY_BUILD_SKIP_CHECKS === 'true'

const nextConfig: NextConfig = {
  distDir: process.env.KUN_NEXT_DIST_DIR ?? '.next',
  devIndicators: false,
  pageExtensions: ['ts', 'tsx', 'js', 'jsx', 'md', 'mdx'],
  transpilePackages: ['next-mdx-remote'],
  typescript: {
    ignoreBuildErrors: skipDeployBuildChecks
  },
  sassOptions: {
    silenceDeprecations: ['legacy-js-api']
  },
  images: {
    formats: ['image/avif', 'image/webp'],
    minimumCacheTTL: 60 * 60 * 24 * 7,
    remotePatterns: [
      {
        protocol: 'https',
        hostname: env.data!.KUN_VISUAL_NOVEL_IMAGE_BED_HOST,
        port: '',
        pathname: '/**'
      },
      {
        protocol: 'https',
        hostname: 'cloud.touchgaloss.com',
        port: '',
        pathname: '/**'
      }
    ]
  },

  output: 'standalone',
  // Turbopack 的文件追踪看不见 sharp .node 二进制 dlopen 的 libvips 动态库, 须显式包含;
  // 同时它会把整个项目目录复制进 standalone (runtimePaths 动态 fs 探测所致), 排除私有内容。
  // .env 不在排除之列: 那是 Next writeStandaloneDirectory 的刻意复制, 与追踪无关且 webpack 时代已如此
  outputFileTracingIncludes: {
    '*': ['node_modules/.pnpm/@img+sharp-libvips-*/**']
  },
  outputFileTracingExcludes: {
    '*': ['docs/**', 'migration/backup/**', '.playwright-mcp/**']
  },
  serverExternalPackages: ['oidc-provider', 'capjs-core'],
  headers: async () => kunRscCacheHeaders,
  experimental: {
    optimizePackageImports: ['@heroui/react', 'framer-motion']
    // turbotrace: {
    //   logLevel: 'error',
    //   logDetail: false,
    //   contextDirectory: path.join(__dirname, '/'),
    //   memoryLimit: 1024
    // }
  }
}

// Turbopack compatible errors
const withMDX = createMDX({
  extension: /\.mdx?$/,
  options: {
    // remarkPlugins: [remarkGfm],
    rehypePlugins: [
      // rehypeSlug,
      // [
      //   rehype - autolink - headings,
      //   {
      //     properties: {
      //       className: ['anchor'],
      //     },
      //   },
      // ],
      // [
      //   rehypePrettyCode,
      //   {
      //     theme: 'github-dark',
      //   },
      // ],
    ]
  }
})

export default withMDX(nextConfig)
