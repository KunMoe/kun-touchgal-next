import { beforeEach, describe, expect, it, vi } from 'vitest'

const { patchFindUniqueMock } = vi.hoisted(() => ({
  patchFindUniqueMock: vi.fn()
}))

vi.mock('~/prisma/index', () => ({
  prisma: { patch: { findUnique: patchFindUniqueMock } }
}))

import { getGalgameForRewrite } from '../rewriteData'
import {
  galgameEditFieldsFromRow,
  galgameEditFingerprint
} from '../_editFields'

const makeRow = () => ({
  id: 5,
  unique_id: 'abcd1234',
  name: '测试 Galgame',
  introduction: '# 标题\n\n这是一段足够长的游戏介绍文本',
  content_limit: 'nsfw',
  released: '2026-01-01',
  vndb_id: 'v19658' as string | null,
  vndb_relation_id: null as string | null,
  bangumi_id: 123456 as number | null,
  steam_id: null as number | null,
  dlsite_code: 'RJ123456' as string | null,
  alias: [{ name: 'ルーパーズ' }, { name: 'LOOPERS' }],
  tag: [
    { tag: { id: 12, name: '治愈，催泪' } },
    { tag: { id: 3, name: '纯爱' } }
  ]
})

beforeEach(() => {
  vi.resetAllMocks()
})

describe('getGalgameForRewrite', () => {
  it('把库里的行映射成表单基线', async () => {
    patchFindUniqueMock.mockResolvedValue(makeRow())

    expect(await getGalgameForRewrite('abcd1234')).toEqual({
      id: 5,
      uniqueId: 'abcd1234',
      name: '测试 Galgame',
      introduction: '# 标题\n\n这是一段足够长的游戏介绍文本',
      released: '2026-01-01',
      contentLimit: 'nsfw',
      alias: ['ルーパーズ', 'LOOPERS'],
      externalIds: {
        vndbId: 'v19658',
        vndbRelationId: '',
        bangumiId: '123456',
        steamId: '',
        dlsiteCode: 'RJ123456'
      },
      // 现存标签带 id, 名字原样 (含逗号的不拆)
      tags: [
        { id: 12, name: '治愈，催泪' },
        { id: 3, name: '纯爱' }
      ],
      baseFingerprint: galgameEditFingerprint(
        galgameEditFieldsFromRow(makeRow())
      )
    })
  })

  // 别名的顺序进指纹, 标签按关联的先后展示: 两处都要显式排序, 不能靠库的默认顺序
  it('按 unique_id 直接读库, 别名与标签关联都按 id 升序', async () => {
    patchFindUniqueMock.mockResolvedValue(makeRow())

    await getGalgameForRewrite('abcd1234')

    expect(patchFindUniqueMock).toHaveBeenCalledTimes(1)
    const args = patchFindUniqueMock.mock.calls[0][0]
    expect(args.where).toEqual({ unique_id: 'abcd1234' })
    expect(args.select.alias).toEqual({
      select: { name: true },
      orderBy: { id: 'asc' }
    })
    expect(args.select.tag).toEqual({
      select: { tag: { select: { id: true, name: true } } },
      orderBy: { id: 'asc' }
    })
  })

  it('没有外部 ID、别名与标签的条目映射成空串与空数组', async () => {
    patchFindUniqueMock.mockResolvedValue({
      ...makeRow(),
      vndb_id: null,
      bangumi_id: null,
      dlsite_code: null,
      alias: [],
      tag: []
    })

    const initial = await getGalgameForRewrite('abcd1234')

    expect(initial?.externalIds).toEqual({
      vndbId: '',
      vndbRelationId: '',
      bangumiId: '',
      steamId: '',
      dlsiteCode: ''
    })
    expect(initial?.alias).toEqual([])
    expect(initial?.tags).toEqual([])
  })

  it('条目不存在时返回 null', async () => {
    patchFindUniqueMock.mockResolvedValue(null)

    expect(await getGalgameForRewrite('deadbeef')).toBeNull()
  })
})
