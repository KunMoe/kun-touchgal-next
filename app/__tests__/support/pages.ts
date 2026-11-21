import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const APP_DIR = fileURLToPath(new URL('../../', import.meta.url))

export interface KunPageFile {
  // 相对 app 的路径, 如 login/2fa/page.tsx
  file: string
  segments: string[]
  // 路由写法保留方括号, 如 /message/chat/[conversationId]
  route: string
}

const appFiles = () =>
  readdirSync(APP_DIR, { recursive: true, encoding: 'utf-8' }).sort()

// app 下全部页面。路由直接取目录, 页面与 layout 只认 .tsx: 仓库里没有路由组 (xxx)、并行路由 @xxx,
// 也没有别的扩展名的 page / layout。出现之后这里要跟着改 (config/__tests__/routePolicy.test.ts 会先红)
export const listKunPages = (): KunPageFile[] =>
  appFiles()
    .filter((entry) => /(^|\/)page\.tsx$/.test(entry))
    .map((file) => {
      const dir = file.replace(/\/?page\.tsx$/, '')
      return { file, segments: dir ? dir.split('/') : [], route: `/${dir}` }
    })

// next.config.ts 的 pageExtensions 还允许 ts / js / jsx / md / mdx 写 page 与 layout
export const listNonTsxRouteFiles = (): string[] =>
  appFiles().filter((entry) =>
    /(^|\/)(page|layout)\.(ts|jsx?|mdx?)$/.test(entry)
  )
