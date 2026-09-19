import { MOYU_PATCH_RESOURCE_CACHE_DURATION } from '~/config/cache'
import { getKv, setKv } from '~/lib/redis'
import { prisma } from '~/prisma'
import type {
  KunMoyuPatchList,
  KunMoyuPatchResource
} from '~/types/api/kun/moyu-moe'

const MOYU_PATCH_RESOURCE_CACHE_KEY_PREFIX = 'moyu:patch-resource'
const NEXTMOE_API_TIMEOUT_MS = 10 * 1000

const logMoyuError = (message: string, error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(message, error)
}

const fetchMoyuPatchResources = async (
  vndbId: string,
  apiKey: string
): Promise<KunMoyuPatchResource[]> => {
  const url = new URL('/v2/moyu/patches', process.env.KUN_NEXTMOE_API_BASE)
  // nsfw 缺省只回全年龄页, 旧 hikari 不做分级过滤, 须显式放开
  url.search = new URLSearchParams({
    refs: `vndb:${vndbId}`,
    nsfw: 'true',
    include: 'resources,publisher'
  }).toString()

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(NEXTMOE_API_TIMEOUT_MS)
  })
  if (!res.ok) {
    const problem = (await res.json().catch(() => null)) as {
      code?: string
    } | null
    throw new Error(
      `NextMoe moyu API error: ${res.status} ${problem?.code ?? ''}`.trim()
    )
  }

  const list = (await res.json()) as KunMoyuPatchList
  return list.items[0]?.resources ?? []
}

export const getMoyuPatchResources = async (
  vndbId: string
): Promise<KunMoyuPatchResource[] | string> => {
  const apiKey = process.env.KUN_NEXTMOE_API_KEY
  if (!apiKey) {
    return []
  }

  const cacheKey = `${MOYU_PATCH_RESOURCE_CACHE_KEY_PREFIX}:${vndbId}`
  try {
    const cached = await getKv(cacheKey)
    if (cached) {
      return JSON.parse(cached) as KunMoyuPatchResource[]
    }
  } catch (error) {
    logMoyuError('Failed to read moyu patch resource cache:', error)
  }

  // 匿名可调且整站共用一把限流密钥: 只放行本站已收录的 vndb_id, 防枚举耗尽配额
  const patch = await prisma.patch.findFirst({
    where: { vndb_id: vndbId },
    select: { id: true }
  })
  if (!patch) {
    return []
  }

  let resources: KunMoyuPatchResource[]
  try {
    resources = await fetchMoyuPatchResources(vndbId, apiKey)
  } catch (error) {
    logMoyuError('Failed to fetch moyu patch resources:', error)
    return '获取鲲 Galgame 补丁资源失败'
  }

  try {
    await setKv(
      cacheKey,
      JSON.stringify(resources),
      MOYU_PATCH_RESOURCE_CACHE_DURATION
    )
  } catch (error) {
    logMoyuError('Failed to write moyu patch resource cache:', error)
  }

  return resources
}
