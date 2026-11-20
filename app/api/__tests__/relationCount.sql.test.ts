import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  expectAggregatePushdown,
  wholeTableAggregates
} from '~/prisma/__tests__/support/sqlShape'

// 列表里的关系 _count 依赖的编译器输出, 不连库。Prisma 把关系 _count 编译成对子表的
// 聚合子查询, 外层的条件下推不进去; 各站点靠一个「对返回行恒真」的关系过滤 (源码里标着
// 「勿删」) 让聚合带上条件。各站点自己的单测只锁得住传给 Prisma 的参数, 这里看的是
// 编译出来的 SQL 里聚合子查询到底带没带条件。
//
// 每条用例同时钉住这次查询里「整表聚合」的全集 (wholeTable): 在这些查询上再加一个不带
// 过滤的 _count 会红。它只管本文件驱动的查询 —— 别处的列表 (首页与 /resource 的资源列表、
// 关注与粉丝列表等) 没有在这里驱动, 新写的列表也不会自动进来

const recorder = await vi.hoisted(async () =>
  (await import('~/prisma/__tests__/support/sqlRecorder')).createSqlRecorder()
)

vi.mock('~/prisma/index', () => recorder.module)

// 直通缓存层: 这里只看查询
vi.mock('~/app/api/patch/comment/cache', () => ({
  withPatchCommentPageCache: (
    _patchId: number,
    _resourceId: number | null,
    _page: number,
    _limit: number,
    query: () => Promise<unknown>
  ) => query()
}))

vi.mock('~/app/api/patch/resource/cache', () => ({
  getPatchResourceDetailCacheKey: async () => null,
  getCachedPatchResourceDetail: async () => ({
    response: null,
    canWrite: false
  })
}))

import { getComment as getAdminComment } from '~/app/api/admin/comment/get'
import { getRating as getAdminRating } from '~/app/api/admin/rating/get'
import { getPatchResource as getAdminResource } from '~/app/api/admin/resource/get'
import { getUserInfo as getAdminUser } from '~/app/api/admin/user/get'
import { getPatchComment } from '~/app/api/patch/comment/get'
import { getPatchRating } from '~/app/api/patch/rating/get'
import { getPatchResource } from '~/app/api/patch/resource/get'
import { getUserComment } from '~/app/api/user/profile/comment/service'
import { getFolders } from '~/app/api/user/profile/favorite/folder/get'
import { getUserPatchRating } from '~/app/api/user/profile/rating/service'

const PATCH_ID = 9
const USER_ID = 7
const guest = { uid: 0, role: 0 }
// 看得到待审核内容的视角不走共享缓存, 是另一处调用
const moderator = { uid: 5, role: 3 }
const page = { page: 1, limit: 10 }

const commentLikes = {
  relationTable: 'user_patch_comment_like_relation',
  parentTable: 'patch_comment'
}
const ratingLikes = {
  relationTable: 'patch_rating_like',
  parentTable: 'patch_rating'
}
const resourceLikes = {
  relationTable: 'user_patch_resource_like_relation',
  parentTable: 'patch_resource'
}

beforeEach(() => {
  recorder.reset()
  // 列表都带一次总数查询, 它要有一行结果
  recorder.reply(/^SELECT COUNT\(\*\)/, { rows: [{ _count$_all: 0n }] })
})

describe('带恒真过滤的关系 _count: 条件下推进聚合子查询', () => {
  it.each([
    {
      site: '评论列表',
      run: () => getPatchComment({ patchId: PATCH_ID, ...page }, guest),
      pushdown: { ...commentLikes, predicateColumn: 'patch_id' },
      wholeTable: []
    },
    {
      site: '评价列表',
      run: () =>
        getPatchRating(
          { patchId: PATCH_ID, ...page, onlyWithShortSummary: false },
          guest
        ),
      pushdown: { ...ratingLikes, predicateColumn: 'patch_id' },
      wholeTable: []
    },
    {
      // 上传者的资源总数没有可下推的条件, C15 裁定保留
      site: '资源 tab (公开视角)',
      run: () => getPatchResource({ patchId: PATCH_ID }, null),
      pushdown: { ...resourceLikes, predicateColumn: 'patch_id' },
      wholeTable: ['patch_resource']
    },
    {
      site: '资源 tab (可见待审核内容的视角)',
      run: () => getPatchResource({ patchId: PATCH_ID }, moderator),
      pushdown: { ...resourceLikes, predicateColumn: 'patch_id' },
      wholeTable: ['patch_resource']
    },
    {
      site: '用户主页的评论',
      run: () => getUserComment({ uid: USER_ID, ...page }, guest),
      pushdown: { ...commentLikes, predicateColumn: 'user_id' },
      wholeTable: []
    },
    {
      site: '用户主页的评价',
      run: () => getUserPatchRating({ uid: USER_ID, ...page }, guest),
      pushdown: { ...ratingLikes, predicateColumn: 'user_id' },
      wholeTable: []
    },
    {
      site: '收藏夹列表',
      run: () => getFolders({ patchId: PATCH_ID }, USER_ID, USER_ID),
      pushdown: {
        relationTable: 'user_patch_favorite_folder_relation',
        parentTable: 'user_patch_favorite_folder',
        predicateColumn: 'user_id'
      },
      wholeTable: []
    }
  ])('$site', async ({ run, pushdown, wholeTable }) => {
    await run()

    const statements = recorder.take()
    expectAggregatePushdown(statements, pushdown)
    expect(wholeTableAggregates(statements)).toEqual(wholeTable)
  })
})

// 后台这四个列表的关系 _count 没有带过滤, 每次查询都把所列的表整个 GROUP BY 一遍。
// 登记在这里是为了让它成为看得见、等裁定的状态: 修掉一处 (加过滤、改读计数列) 之后这里
// 会红, 把那一项删掉; 给这些查询再加一个也会红
describe('后台列表里已知的整表聚合', () => {
  it.each([
    {
      site: '评论列表的点赞数',
      run: () => getAdminComment({ ...page, searchType: 'content' }),
      wholeTable: ['user_patch_comment_like_relation']
    },
    {
      site: '评价列表的点赞数',
      run: () => getAdminRating({ ...page, searchType: 'content' }),
      wholeTable: ['patch_rating_like']
    },
    {
      site: '资源列表的上传者资源数',
      run: () => getAdminResource({ ...page, searchType: 'content' }, null),
      wholeTable: ['patch_resource']
    },
    {
      site: '用户列表的资源数与 Galgame 数',
      run: () => getAdminUser({ ...page, searchType: 'name' }),
      wholeTable: ['patch_resource', 'patch']
    }
  ])('$site', async ({ run, wholeTable }) => {
    await run()

    expect(wholeTableAggregates(recorder.take())).toEqual(wholeTable)
  })
})
