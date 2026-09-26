// TODO: type
// type SelectFieldKey = Exclude<keyof GalgameCard, '_count'> & {
//   select: {
//     favorite_by: boolean
//     resource: boolean
//     comment: boolean
//   }
// }

export const PatchRefSelectField = {
  unique_id: true,
  name: true
}

export const GalgameCardSelectField = {
  id: true,
  unique_id: true,
  name: true,
  banner: true,
  view: true,
  download: true,
  type: true,
  language: true,
  platform: true,
  created: true,
  favorite_count: true,
  resource_count: true,
  comment_count: true,
  rating_stat: {
    select: {
      avg_overall: true
    }
  }
}

type GalgameCardCountShape = {
  favorite_folder: number
  resource: number
  comment: number
}

interface GalgameCardCounters {
  favorite_count: number
  resource_count: number
  comment_count: number
}

export const toGalgameCardCount = (
  row: GalgameCardCounters
): GalgameCardCountShape => ({
  favorite_folder: row.favorite_count,
  resource: row.resource_count,
  comment: row.comment_count
})

interface GalgameCardRow extends GalgameCardCounters {
  id: number
  unique_id: string
  name: string
  banner: string
  view: number
  download: number
  type: string[]
  language: string[]
  platform: string[]
  created: Date
  rating_stat: { avg_overall: number } | null
}

// 逐字段映射, 勿改回展开行: 展开会把 unique_id / rating_stat 以及日后加进
// select 的字段 (如 content_limit) 静默带进 HTML 与公开 API
export const toGalgameCard = (row: GalgameCardRow): GalgameCard => ({
  id: row.id,
  uniqueId: row.unique_id,
  name: row.name,
  banner: row.banner,
  view: row.view,
  download: row.download,
  type: row.type,
  language: row.language,
  platform: row.platform,
  created: row.created,
  _count: toGalgameCardCount(row),
  averageRating: row.rating_stat?.avg_overall
    ? Math.round(row.rating_stat.avg_overall * 10) / 10
    : 0
})
