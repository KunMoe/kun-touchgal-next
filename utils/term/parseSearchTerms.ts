// 标签 / 会社搜索框的切词: 按任意空白 (含全角空格) 切分, 上限与服务端
// validations 里的 query.max(10) 一致。超过上限返回错误消息, 调用方直接提示, 不发请求
export const KUN_MAX_SEARCH_TERMS = 10

export const parseSearchTerms = (
  query: string,
  max = KUN_MAX_SEARCH_TERMS
): string[] | string => {
  const terms = query
    .trim()
    .split(/\s+/u, max + 1)
    .filter(Boolean)
  return terms.length > max ? `您最多使用 ${max} 组关键词` : terms
}
