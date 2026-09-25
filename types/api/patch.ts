import { Tag } from './tag'
import { Company } from './company'

export interface Patch {
  id: number
  uniqueId: string
  vndbId: string | null
  vndbRelationId: string | null
  bangumiId: number | null
  steamId: number | null
  dlsiteCode: string | null
  name: string
  banner: string
  introduction: string
  status: number
  view: number
  download: number
  alias: string[]
  type: string[]
  language: string[]
  platform: string[]
  tags: string[]
  isFavorite: boolean
  contentLimit: string
  ratingSummary: PatchRatingSummary
  user: {
    id: number
    name: string
    avatar: string
  }
  created: string
  updated: string
  _count: {
    favorite_folder: number
    resource: number
    comment: number
  }
}

export interface PatchRatingSummary {
  average: number
  count: number
  histogram: { score: number; count: number }[]
  recommend: {
    strong_no: number
    no: number
    neutral: number
    yes: number
    strong_yes: number
  }
}

export interface PatchIntroduction {
  vndbId: string | null
  vndbRelationId?: string | null
  bangumiId?: number | null
  steamId?: number | null
  dlsiteCode?: string | null
  introduction: string
  released: string
  alias: string[]
  tag: Tag[]
  company: Company[]
  resourceUpdateTime: Date | string
  created: Date | string
  updated: Date | string
}

export interface PatchUpdate {
  name: string
  alias: string[]
  introduction: string
}

export interface PatchResourceLink {
  id: number
  storage: string
  size: string
  code: string
  password: string
  hash: string
  content: string
  sortOrder: number
  download: number
}

export interface PatchResource {
  id: number
  name: string
  section: string
  uniqueId: string
  type: string[]
  language: string[]
  note: string
  platform: string[]
  emulatorType: string[]
  modelName: string
  download: number
  links: PatchResourceLink[]
  likeCount: number
  isLike: boolean
  status: number
  userId: number
  patchId: number
  created: string
  user: KunUser & {
    patchCount: number
    role: number
  }
}

export interface PatchComment {
  id: number
  uniqueId: string
  content: string
  contentPreview?: string
  isLike: boolean
  isSpoiler: boolean
  status: number
  likeCount: number
  parentId: number | null
  userId: number
  patchId: number
  created: string
  updated: string
  reply: PatchComment[]
  user: KunUser
  quotedContent?: string | null
  quotedUsername?: string | null
  // 直接父评论 id (根评论为 null); 缓存里升级前写入的旧页面缺此字段
  replyToId?: number | null
  replyToUser?: KunUser | null
}

export interface PatchCommentResponse {
  comments: PatchComment[]
  total: number
  currentPage: number
}
