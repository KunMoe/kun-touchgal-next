import { SITEMAP_CACHE_DURATION } from '~/config/cache'
import { getAllPosts } from '~/lib/mdx/getPosts'
import { prisma } from '~/prisma/index'
import {
  PUBLIC_VISIBILITY,
  toPatchWhere
} from '~/server/viewer/patchVisibility'
import { buildKunSitemap } from './entries'
import type { MetadataRoute } from 'next'

const loadKunSitemap = async () => {
  const [patches, companies] = await Promise.all([
    // 站点地图只收游客能看到的作品, 与游客打开详情页时的视角是同一个
    prisma.patch.findMany({
      where: toPatchWhere(PUBLIC_VISIBILITY),
      select: { unique_id: true, resource_update_time: true }
    }),
    prisma.patch_company.findMany({ select: { id: true } })
  ])

  return buildKunSitemap({
    patches: patches.map((patch) => ({
      uniqueId: patch.unique_id,
      resourceUpdateTime: patch.resource_update_time
    })),
    companyIds: companies.map((company) => company.id),
    // 读文件放在 await 之后: 若在查询发出后、await 之前同步抛错, 查询的 rejection 就没人接
    posts: getAllPosts()
  })
}

// 库里的查询没有语句超时: 连接半开、或排在一把长锁后面时它可以一直不返回。记忆里存的是
// promise, 不设上限的话这个进程此后的站点地图请求都跟着空等, 库恢复了也要等到记忆过期。
// 到点按失败处理 (路由回 500), 下一个请求重新加载
const LOAD_TIMEOUT_MS = 30 * 1000

const withLoadTimeout = <T>(work: Promise<T>): Promise<T> => {
  let timer: NodeJS.Timeout
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('站点地图加载超时')),
        LOAD_TIMEOUT_MS
      )
    })
  ]).finally(() => clearTimeout(timer))
}

// 记的是 promise: 加载期间到达的请求共用同一次加载。过期时刻从发起加载算起,
// 加载成功后每个进程每个 TTL 至多整表扫描一次
let memo: {
  sitemap: Promise<MetadataRoute.Sitemap>
  expiresAt: number
} | null = null

export const kunGetSitemap = (): Promise<MetadataRoute.Sitemap> => {
  const now = Date.now()
  if (memo && now < memo.expiresAt) {
    return memo.sitemap
  }

  const sitemap = withLoadTimeout(loadKunSitemap())
  memo = { sitemap, expiresAt: now + SITEMAP_CACHE_DURATION * 1000 }
  // 失败 (含超时) 不记: 下一个请求重新加载; 旧的记忆在发起这次加载时已被替换, 不会被当成
  // 兜底返回。加载至多挂 LOAD_TIMEOUT_MS, 远短于 TTL, 所以失败时记忆里一定还是这一次加载。
  // 错误本身由调用方收到 (路由回 500)
  sitemap.catch(() => {
    memo = null
  })
  return sitemap
}
