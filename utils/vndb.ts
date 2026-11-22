'use client'

import { kunFetchPost } from '~/utils/kunFetch'

interface VNDBDetailsResponse {
  titles: string[]
  released: string
  tags: string[]
  developers: string[]
}

// 失败时是服务端或 kunFetch 给出的文案 (未收录、上游失败、请求过于频繁、断网), 调用点原样提示
export const fetchVNDBDetails = (vnId: string) =>
  kunFetchPost<VNDBDetailsResponse | string>('/edit/vndb/details', {
    vndbId: vnId
  })
