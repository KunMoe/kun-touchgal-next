import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  expectAggregatePushdown,
  wholeTableAggregates
} from '~/prisma/__tests__/support/sqlShape'

// 列表里的关系 _count 依赖的编译器输出, 不连库。Prisma 把关系 _count 编译成对子表的
// 聚合子查询, 外层的条件下推不进去; 各站点靠一个「对返回行恒真」的关系过滤 (源码里标着
// 「勿删」) 让聚合带上条件。各站点自己的单测只锁得住传给 Prisma 的参数, 这里看的是
// 编译出来的 SQL 里聚合子查询到底带没带条件

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
      relationTable: 'user_patch_comment_like_relation',
      predicateColumn: 'patch_id'
    },
    {
      site: '评价列表',
      run: () =>
        getPatchRating(
          { patchId: PATCH_ID, ...page, onlyWithShortSummary: false },
          guest
        ),
      relationTable: 'patch_rating_like',
      predicateColumn: 'patch_id'
    },
    {
      site: '资源 tab (公开视角)',
      run: () => getPatchResource({ patchId: PATCH_ID }, null),
      relationTable: 'user_patch_resource_like_relation',
      predicateColumn: 'patch_id'
    },
    {
      site: '资源 tab (可见待审核内容的视角)',
      run: () => getPatchResource({ patchId: PATCH_ID }, moderator),
      relationTable: 'user_patch_resource_like_relation',
      predicateColumn: 'patch_id'
    },
    {
      site: '用户主页的评论',
      run: () => getUserComment({ uid: USER_ID, ...page }, guest),
      relationTable: 'user_patch_comment_like_relation',
      predicateColumn: 'user_id'
    },
    {
      site: '用户主页的评价',
      run: () => getUserPatchRating({ uid: USER_ID, ...page }, guest),
      relationTable: 'patch_rating_like',
      predicateColumn: 'user_id'
    },
    {
      site: '收藏夹列表',
      run: () => getFolders({ patchId: PATCH_ID }, USER_ID, USER_ID),
      relationTable: 'user_patch_favorite_folder_relation',
      predicateColumn: 'user_id'
    }
  ])('$site', async ({ run, relationTable, predicateColumn }) => {
    await run()

    expectAggregatePushdown(recorder.take(), { relationTable, predicateColumn })
  })
})

// 这些查询每次都把所列的表整个 GROUP BY 一遍。登记在这里是为了让它成为看得见的、有人
// 裁定过的状态: 清单只减不增。修掉一处 (加过滤、改读计数列) 之后这里会红, 把那一项删掉;
// 新增一处也会红, 那就得先说明为什么可以接受
describe('已知的整表聚合', () => {
  it.each([
    {
      // C15 裁定保留: 上传者的资源总数, 没有可下推的条件
      site: '资源 tab 的上传者资源数',
      run: () => getPatchResource({ patchId: PATCH_ID }, null),
      wholeTable: ['patch_resource']
    },
    {
      site: '后台评论列表的点赞数',
      run: () => getAdminComment({ ...page, searchType: 'content' }),
      wholeTable: ['user_patch_comment_like_relation']
    },
    {
      site: '后台评价列表的点赞数',
      run: () => getAdminRating({ ...page, searchType: 'content' }),
      wholeTable: ['patch_rating_like']
    },
    {
      site: '后台资源列表的上传者资源数',
      run: () => getAdminResource({ ...page, searchType: 'content' }, null),
      wholeTable: ['patch_resource']
    },
    {
      site: '后台用户列表的资源数与 Galgame 数',
      run: () => getAdminUser({ ...page, searchType: 'name' }),
      wholeTable: ['patch_resource', 'patch']
    }
  ])('$site', async ({ run, wholeTable }) => {
    await run()

    expect(wholeTableAggregates(recorder.take())).toEqual(wholeTable)
  })
})
