import { describe, expect, it } from 'vitest'
import { createStore } from 'zustand/vanilla'
import {
  applyFetchMerge,
  buildDuplicateCheckQuery,
  combineVndbRelationFetch,
  fetchedForCurrentId,
  mergeBangumiFetch,
  mergeDlsiteFetch,
  mergeSteamFetch,
  mergeVndbFetch,
  mergeVndbRelationFetch
} from '~/components/edit/form/merge'
import type { KunFormUpdate, PatchFormDataShape } from '~/components/edit/types'

const form = (
  overrides: Partial<PatchFormDataShape> = {}
): PatchFormDataShape => ({
  name: '',
  vndbId: '',
  vndbRelationId: '',
  bangumiId: '',
  steamId: '',
  dlsiteCode: '',
  dlsiteCircleName: '',
  dlsiteCircleLink: '',
  vndbTags: [],
  vndbDevelopers: [],
  bangumiTags: [],
  bangumiDevelopers: [],
  steamTags: [],
  steamDevelopers: [],
  dlsiteTags: [],
  alias: [],
  tag: [],
  released: '',
  ...overrides
})

// 与两个表单 store 同形的写接口
const createForm = (initial: PatchFormDataShape) => {
  const store = createStore<{
    data: PatchFormDataShape
    update: KunFormUpdate<PatchFormDataShape>
  }>()((set) => ({
    data: initial,
    update: (patch) =>
      set((state) => ({
        data: {
          ...state.data,
          ...(typeof patch === 'function' ? patch(state.data) : patch)
        }
      }))
  }))
  return {
    data: () => store.getState().data,
    update: store.getState().update
  }
}

const vndbResult = {
  titles: ['VNDB 标题'],
  released: '2020-01-01',
  tags: ['ADV'],
  developers: ['Key']
}

const bangumiResult = {
  name: 'バンガミ',
  nameCn: '番组名',
  released: '2021-02-02',
  tags: ['纯爱'],
  developers: ['AliceSoft']
}

describe('抓取结果只并入发起请求时的那个 ID', () => {
  it('请求期间 ID 被改掉: 不写任何字段', () => {
    expect(mergeVndbFetch(form({ vndbId: 'v2' }), 'v1', vndbResult)).toBeNull()
    expect(
      mergeVndbRelationFetch(form({ vndbRelationId: 'r2' }), 'r1', {
        ...vndbResult,
        vndbId: 'v1'
      })
    ).toBeNull()
    expect(
      mergeBangumiFetch(form({ bangumiId: '2' }), '1', bangumiResult)
    ).toBeNull()
    expect(
      mergeSteamFetch(form({ steamId: '2' }), '1', {
        name: 'Steam',
        aliases: {},
        releaseDate: '',
        tags: [],
        developers: []
      })
    ).toBeNull()
    expect(
      mergeDlsiteFetch(form({ dlsiteCode: 'RJ2' }), 'RJ1', {
        rj_code: 'RJ1',
        title_default: 'DL'
      })
    ).toBeNull()
  })

  it('表单里的 ID 只是写法不同 (大小写、首尾空白) 时照常并入, 并回写规范化后的 ID', () => {
    expect(
      mergeVndbFetch(form({ vndbId: ' V1 ' }), 'v1', vndbResult)
    ).toMatchObject({ vndbId: 'v1' })
    expect(
      mergeDlsiteFetch(form({ dlsiteCode: 'rj01405813' }), 'RJ01405813', {
        rj_code: 'RJ01405813',
        title_default: 'DL'
      })
    ).toMatchObject({ dlsiteCode: 'RJ01405813' })
  })

  // Bangumi / Steam 原先不回写: 带空格的 ID 抓得到数据, 原样提交却被格式校验拒绝
  it('Bangumi 与 Steam 也回写规范化后的 ID', () => {
    expect(
      mergeBangumiFetch(
        form({ bangumiId: ' 172612 ' }),
        '172612',
        bangumiResult
      )
    ).toMatchObject({ bangumiId: '172612' })
    expect(
      mergeSteamFetch(form({ steamId: ' 3655150 ' }), '3655150', {
        name: 'Steam',
        aliases: {},
        releaseDate: '',
        tags: [],
        developers: []
      })
    ).toMatchObject({ steamId: '3655150' })
  })
})

describe('并入规则', () => {
  it('别名追加在既有别名之后、去重、剔除游戏名; 标签与会社整组替换', () => {
    const prev = form({
      vndbId: 'v1',
      name: '游戏名',
      alias: ['手工别名'],
      vndbTags: ['旧标签'],
      vndbDevelopers: ['旧会社']
    })

    expect(
      mergeVndbFetch(prev, 'v1', {
        ...vndbResult,
        titles: ['手工别名', '游戏名', 'VNDB 标题']
      })
    ).toEqual({
      vndbId: 'v1',
      alias: ['手工别名', 'VNDB 标题'],
      released: '2020-01-01',
      vndbTags: ['ADV'],
      vndbDevelopers: ['Key']
    })
  })

  it('发售日期以抓取结果为准, 抓取结果为空时保留表单里的值', () => {
    const prev = form({ vndbId: 'v1', released: '2019-10-07' })

    expect(mergeVndbFetch(prev, 'v1', vndbResult)?.released).toBe('2020-01-01')
    expect(
      mergeVndbFetch(prev, 'v1', { ...vndbResult, released: '' })?.released
    ).toBe('2019-10-07')
  })

  it('Release: 自己的标题与发售日期排在所属 VN 之前, 并写入所属 VN 的 ID', () => {
    const result = combineVndbRelationFetch(
      { vndbId: 'v9', titles: ['移植版标题', '共同标题'], released: '' },
      { ...vndbResult, titles: ['共同标题', 'VN 标题'] }
    )

    expect(result.titles).toEqual(['移植版标题', '共同标题', 'VN 标题'])
    // Release 没有发售日期时退回 VN 的
    expect(result.released).toBe('2020-01-01')
    expect(
      mergeVndbRelationFetch(form({ vndbRelationId: 'R5' }), 'r5', result)
    ).toEqual({
      vndbId: 'v9',
      vndbRelationId: 'r5',
      alias: ['移植版标题', '共同标题', 'VN 标题'],
      released: '2020-01-01',
      vndbTags: ['ADV'],
      vndbDevelopers: ['Key']
    })
  })

  it('Bangumi: 原名与中文名并入别名', () => {
    expect(
      mergeBangumiFetch(
        form({ bangumiId: '1', name: '番组名', alias: ['A'] }),
        '1',
        bangumiResult
      )
    ).toEqual({
      bangumiId: '1',
      alias: ['A', 'バンガミ'],
      released: '2021-02-02',
      bangumiTags: ['纯爱'],
      bangumiDevelopers: ['AliceSoft']
    })
  })

  it('Steam: 别名按日文、英文、繁中的顺序并入, 会社只取名字', () => {
    expect(
      mergeSteamFetch(form({ steamId: '1', alias: ['A'] }), '1', {
        name: 'Steam 名',
        aliases: { english: 'EN', japanese: ' JP ', tchinese: '' },
        releaseDate: '2022-03-03',
        tags: ['Visual Novel'],
        developers: [{ name: 'Navel', link: 'https://example.com' }]
      })
    ).toEqual({
      steamId: '1',
      alias: ['A', 'JP', 'EN'],
      released: '2022-03-03',
      steamTags: ['Visual Novel'],
      steamDevelopers: ['Navel']
    })
  })

  it('DLsite: 标签串按半角与全角逗号拆开, 社团名与链接一并写入', () => {
    expect(
      mergeDlsiteFetch(form({ dlsiteCode: 'RJ1', alias: ['A'] }), 'RJ1', {
        rj_code: 'RJ1',
        title_default: '默认标题',
        title_jp: ' 日文标题 ',
        release_date: '2023-04-04',
        tags: '純愛, 学園，純愛',
        circle_name: ' 社团 ',
        circle_link: ' https://example.com '
      })
    ).toEqual({
      dlsiteCode: 'RJ1',
      dlsiteCircleName: '社团',
      dlsiteCircleLink: 'https://example.com',
      alias: ['A', '日文标题'],
      dlsiteTags: ['純愛', '学園'],
      released: '2023-04-04'
    })
  })
})

describe('applyFetchMerge: 基于响应到达时的表单状态并入', () => {
  it('请求期间的输入不被抓取结果抹掉', () => {
    const target = createForm(form({ vndbId: 'v1' }))

    // 点了「获取」之后、应答回来之前, 用户继续填表
    target.update({ name: '用户输入的游戏名' })
    target.update({ bangumiId: '123' })
    target.update((prev) => ({ alias: [...prev.alias, '手工别名'] }))

    const applied = applyFetchMerge(target.update, (prev) =>
      mergeVndbFetch(prev, 'v1', vndbResult)
    )

    expect(applied).toBe(true)
    expect(target.data()).toMatchObject({
      name: '用户输入的游戏名',
      bangumiId: '123',
      alias: ['手工别名', 'VNDB 标题'],
      vndbTags: ['ADV']
    })
  })

  it('两路抓取同时在途: 先后到达的结果都保留', () => {
    const target = createForm(form({ vndbId: 'v1', bangumiId: '1' }))

    applyFetchMerge(target.update, (prev) =>
      mergeBangumiFetch(prev, '1', bangumiResult)
    )
    applyFetchMerge(target.update, (prev) =>
      mergeVndbFetch(prev, 'v1', vndbResult)
    )

    expect(target.data()).toMatchObject({
      alias: ['バンガミ', '番组名', 'VNDB 标题'],
      bangumiTags: ['纯爱'],
      bangumiDevelopers: ['AliceSoft'],
      vndbTags: ['ADV'],
      vndbDevelopers: ['Key']
    })
  })

  it('这份结果已不属于当前表单: 不写入并返回 false', () => {
    const target = createForm(form({ vndbId: 'v1', alias: ['A'] }))
    target.update({ vndbId: 'v2' })
    const before = target.data()

    const applied = applyFetchMerge(target.update, (prev) =>
      mergeVndbFetch(prev, 'v1', vndbResult)
    )

    expect(applied).toBe(false)
    expect(target.data()).toEqual(before)
  })

  // Release 抓取会回写所属 VN 的 ID: 较早发出的 VNDB 抓取此时已不对应表单
  it('另一路抓取改写了 ID 之后, 旧 ID 的应答被丢弃', () => {
    const target = createForm(form({ vndbId: 'v1', vndbRelationId: 'r5' }))

    applyFetchMerge(target.update, (prev) =>
      mergeVndbRelationFetch(prev, 'r5', {
        ...vndbResult,
        vndbId: 'v9',
        tags: ['来自 v9']
      })
    )
    const applied = applyFetchMerge(target.update, (prev) =>
      mergeVndbFetch(prev, 'v1', { ...vndbResult, tags: ['来自 v1'] })
    )

    expect(applied).toBe(false)
    expect(target.data()).toMatchObject({ vndbId: 'v9', vndbTags: ['来自 v9'] })
  })
})

describe('buildDuplicateCheckQuery: 阻断式查重只看外部 ID', () => {
  it('每一路只带自己的 ID, 不带标题', () => {
    expect(buildDuplicateCheckQuery('bangumi', '172612')).toEqual({
      bangumiId: '172612'
    })
    expect(buildDuplicateCheckQuery('steam', '3655150')).toEqual({
      steamId: '3655150'
    })
    expect(buildDuplicateCheckQuery('dlsite', 'RJ01405813')).toEqual({
      dlsiteCode: 'RJ01405813'
    })
    expect(buildDuplicateCheckQuery('vndb', 'v1')).toEqual({ vndbId: 'v1' })
  })

  it('Release 与所属 VN 成对查', () => {
    expect(
      buildDuplicateCheckQuery('vndbRelation', 'r5879', { vndbId: 'v19658' })
    ).toEqual({ vndbRelationId: 'r5879', vndbId: 'v19658' })
  })

  it('重写页排除正在编辑的游戏自身', () => {
    expect(
      buildDuplicateCheckQuery('bangumi', '172612', { excludeId: 5 })
    ).toEqual({ bangumiId: '172612', excludeId: '5' })
    expect(
      buildDuplicateCheckQuery('bangumi', '172612', { excludeId: undefined })
    ).toEqual({ bangumiId: '172612' })
  })
})

describe('fetchedForCurrentId: 预览只在它对应的 ID 仍是当前 ID 时显示', () => {
  const entry = { forId: 'v1', data: vndbResult }

  it('回写规范化 ID 不影响显示', () => {
    expect(fetchedForCurrentId(entry, 'vndb', 'V1')).toBe(vndbResult)
    expect(fetchedForCurrentId(entry, 'vndb', ' v1 ')).toBe(vndbResult)
  })

  it('ID 改成别的值后不显示, 还没有抓取过也不显示', () => {
    expect(fetchedForCurrentId(entry, 'vndb', 'v2')).toBeNull()
    expect(fetchedForCurrentId(null, 'vndb', 'v1')).toBeNull()
  })
})
