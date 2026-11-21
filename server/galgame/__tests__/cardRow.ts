// 测试夹具 (不是测试文件): GalgameCardSelectField 选出的一行
export const cardRow = (id: number) => ({
  id,
  unique_id: `uid${id}`,
  name: `galgame ${id}`,
  banner: `banner-${id}.avif`,
  view: id * 10,
  download: id,
  type: ['pc'],
  language: ['zh-Hans'],
  platform: ['windows'],
  created: new Date('2026-11-21T00:00:00Z'),
  favorite_count: 1,
  resource_count: 2,
  comment_count: 3,
  rating_stat: { avg_overall: 8.567 }
})
