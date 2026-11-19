import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('useCreatePatchStore 草稿恢复', () => {
  // 草稿按整份 data 持久化, 新增字段之前存下的旧草稿缺这些键; 默认浅合并会让它们
  // 变成 undefined, BatchTag 遍历 dlsiteTags 时整页崩溃
  it('旧草稿缺少的字段回落为初始值, 已有字段照常恢复', async () => {
    const entries: Record<string, string> = {}
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => entries[key] ?? null,
        setItem: (key: string, value: string) => {
          entries[key] = value
        },
        removeItem: (key: string) => {
          delete entries[key]
        }
      }
    })
    const { useCreatePatchStore, createPatchEditStoreKey } =
      await import('~/store/editStore')
    entries[createPatchEditStoreKey] = JSON.stringify({
      state: { data: { name: '旧草稿', tag: ['纯爱'] } },
      version: 0
    })

    await useCreatePatchStore.persist.rehydrate()

    const { data } = useCreatePatchStore.getState()
    expect(data.name).toBe('旧草稿')
    expect(data.tag).toEqual(['纯爱'])
    expect(data.dlsiteTags).toEqual([])
    expect(data.contentLimit).toBe('sfw')
  })
})

// 写接口只收「要改的字段」。原先的 setData 收整个对象, 抓取组件在 await 之后拿点击
// 时刻的快照整份回写, 请求期间的输入与另一路抓取的结果被一并抹掉
describe('useCreatePatchStore.update', () => {
  const load = async () => {
    vi.stubGlobal('window', {
      localStorage: { getItem: () => null, setItem: () => {} }
    })
    return (await import('~/store/editStore')).useCreatePatchStore
  }

  it('只覆盖传入的字段, 其余字段原样保留', async () => {
    const store = await load()

    store.getState().update({ name: '游戏名' })
    store.getState().update({ bangumiId: '123' })

    expect(store.getState().data).toMatchObject({
      name: '游戏名',
      bangumiId: '123',
      contentLimit: 'sfw'
    })
  })

  it('函数式写入拿到的是调用那一刻的最新状态', async () => {
    const store = await load()
    const { update } = store.getState()

    // 应答在途时用户又加了一个别名
    update({ alias: ['点击时已有'] })
    update((prev) => ({ alias: [...prev.alias, '请求期间新增'] }))
    update((prev) => ({ alias: [...prev.alias, '抓取结果'] }))

    expect(store.getState().data.alias).toEqual([
      '点击时已有',
      '请求期间新增',
      '抓取结果'
    ])
  })

  it('没有整对象写入与读取快照的接口', async () => {
    const store = await load()

    expect(Object.keys(store.getState()).sort()).toEqual([
      'data',
      'resetData',
      'update'
    ])
  })

  it('resetData 回到初始值', async () => {
    const store = await load()

    store.getState().update({ name: '游戏名', tag: ['纯爱'] })
    store.getState().resetData()

    expect(store.getState().data).toMatchObject({ name: '', tag: [] })
  })
})
