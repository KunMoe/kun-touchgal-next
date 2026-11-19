// kunRoute 迁移期的过渡清单 (T10): 还没改成 kunRoute 的 route 文件。只减不增,
// 清空后连同 kun/inv-route-02 一起删除。清单里的文件不受 inv-route-01 约束, 改由 inv-route-02
// 要求每个导出的 handler 体内都有身份闸门调用, 所以第一天起就没有「整段没写」的入口
export const LEGACY_ROUTE_FILES = [
  'app/api/apply/route.ts',
  'app/api/apply/status/route.ts',
  'app/api/galgame/route.ts',
  'app/api/home/random/route.ts',
  'app/api/home/route.ts',
  'app/api/resource/route.ts',
  'app/api/search/route.ts',
  'app/api/upload/complete/route.ts',
  'app/api/upload/init/route.ts',
  'app/oidc/interaction/[uid]/confirm/route.ts'
]
