export const PATCH_CACHE_DURATION = 300
export const PATCH_INTRODUCTION_CACHE_DURATION = 300
export const PATCH_FAVORITE_CACHE_DURATION = 60
export const HOME_CACHE_DURATION = 60
export const GALGAME_LIST_CACHE_DURATION = 60
export const RESOURCE_LIST_CACHE_DURATION = 60
export const PATCH_RESOURCE_DETAIL_CACHE_DURATION = 60
// 鲲补丁资源 (NextMoe /v2/moyu): 上游按应用限流 60 次/分, 与其 s-maxage=1800 对齐
export const MOYU_PATCH_RESOURCE_CACHE_DURATION = 30 * 60
// 详情缓存按 patch 分片的版本键 TTL: 生产 Redis 为 volatile-lfu, 无 TTL 键永不被
// 驱逐, 分片键会随 patch 数无界积累; 带 TTL 即进入可驱逐集合, 过期与驱逐的安全性
// 均靠读侧 miss 时铸造随机新命名空间 (见 getPatchResourceDetailCacheKey), 不靠
// TTL 大小关系
export const PATCH_RESOURCE_DETAIL_VERSION_DURATION = 24 * 60 * 60
export const USER_PENDING_RESOURCE_CACHE_DURATION = 60
// 跳转配置缓存 (写侧与两级读回填共用): 事实源在 admin_setting 表, 驱逐后回源 DB
export const ADMIN_REDIRECT_CONFIG_CACHE_DURATION = 24 * 60 * 60
export const TAG_LIST_CACHE_DURATION = 300
export const COMPANY_LIST_CACHE_DURATION = 300
// 关键词搜索的精确 totalHits：与页码无关，翻页/热词重复查询共享，短 TTL 兜住索引更新
export const SEARCH_TOTAL_HITS_CACHE_DURATION = 60
export const COMMENT_CACHE_DURATION = 60
// 下载计数去重窗口: 同一 (用户或 IP, 链接) 在此时间内只计一次, 防脚本刷量与缓存抖动
export const DOWNLOAD_DEDUP_CACHE_DURATION = 60 * 60
export const MARKDOWN_HTML_CACHE_DURATION = 5 * 60
export const MARKDOWN_HTML_CACHE_MAX_MARKDOWN_BYTES = 128 * 1024
export const MARKDOWN_HTML_CACHE_MAX_HTML_BYTES = 256 * 1024
