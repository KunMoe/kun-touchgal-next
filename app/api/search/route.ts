import { kunRoute } from '~/app/api/utils/kunRoute'
import { parseSearchSuggestions, searchSchema } from '~/validations/search'
import { viewerContextFromRequest } from '~/server/viewer/fromRequest'
import { searchGalgames, toKeywordSearchSpec } from '~/server/galgame/search'
import { MeiliBadRequestError } from '~/server/search/failure'

export const POST = kunRoute.post({
  auth: 'optional',
  input: searchSchema,
  handler: async ({ req, input }) => {
    const suggestions = parseSearchSuggestions(input.queryString)
    if (typeof suggestions === 'string') {
      return suggestions
    }
    const visibility = await viewerContextFromRequest(req).visibility()

    try {
      return await searchGalgames(
        toKeywordSearchSpec(input, suggestions),
        visibility
      )
    } catch (error) {
      // 关键词或筛选值被 Meilisearch 判为非法 (如带孤立代理): 不换引擎, 当业务错误回出
      if (error instanceof MeiliBadRequestError) {
        return '搜索条件格式错误'
      }
      throw error
    }
  }
})
