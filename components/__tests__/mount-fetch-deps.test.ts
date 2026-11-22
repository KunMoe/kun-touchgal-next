import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const readSource = (file: string) =>
  readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf-8')

// 这些列表容器的首屏都由 page.tsx 用相同参数取好 initial* props 水合。
// fetch effect 的依赖一旦含 isMounted, useMounted 翻转就会让 effect 重跑, 对首屏
// 发一次与 SSR 完全相同的请求 (message 容器还会让 loading 骨架整体替换已渲染列表)。
// c551e0bd 曾把 message/Container 的 [page] 改成 [isMounted, page], admin/report
// 自建功能起就带着 isMounted。正确形态是体内 !isMounted 早退 + 依赖数组不含 isMounted。
// 无 SSR 数据、纯客户端首取的组件 (如 settings/user/appeal) 不在此列。
const containers = [
  '../message/Container.tsx',
  '../message/chat/ConversationList.tsx',
  '../admin/appeal/Container.tsx',
  '../admin/creator/Container.tsx',
  '../admin/feedback/Container.tsx',
  '../admin/galgame/Container.tsx',
  '../admin/log/Container.tsx',
  '../admin/resource-apply/Container.tsx',
  '../admin/user/Container.tsx'
]

// 迁到 useKunPagedList 的容器 (T17): 不再自己在 effect 里首取, SSR 数据经 initial 交给
// 状态机, 「有 initial 时挂载不请求」由 utils/list/__tests__/kunListMachine.test.ts 的
// 用例守护。这里钉住容器确实把首屏数据交了出去, 而不是退回不给 initial、挂载后再取一遍
const pagedListContainers = [
  '../admin/comment/Container.tsx',
  '../admin/moderation/Container.tsx',
  '../admin/rating/Container.tsx',
  '../admin/report/Container.tsx',
  '../admin/resource/Container.tsx'
]

const fetchEffectPattern =
  /useEffect\(\(\) => \{\s*if \(!isMounted\) \{\s*return\s*\}[\s\S]*?\}, \[([^\]]*)\]\)/g

describe('initial* 水合的列表容器, fetch effect 不得因 isMounted 翻转而重跑', () => {
  it.each(containers)('%s 的依赖数组不含 isMounted', (file) => {
    const source = readSource(file)
    const matches = [...source.matchAll(fetchEffectPattern)]
    expect(
      matches.length,
      '应存在以 !isMounted 早退开头的 fetch effect'
    ).toBeGreaterThan(0)

    for (const match of matches) {
      const deps = match[1].split(',').map((dep) => dep.trim())
      expect(deps).not.toContain('isMounted')
    }
  })
})

// 只看 useKunPagedList 调用自己的参数对象 (到调用处缩进的 `})` 为止), 文件里别处的 initial: 不算。
// 挂载时宿主把属性 / 防抖值同步进查询是空操作, 靠的是查询的值只能是原始值 (KunListQuery 的类型约束)
const pagedListOptions = (source: string) => {
  const call =
    /^( *)(?:const|let) \w+ = useKunPagedList(?:<[^>]*>)?\(\{$/m.exec(source)
  if (!call) {
    return null
  }
  const close = source.indexOf(`\n${call[1]}})`, call.index)
  return close < 0 ? null : source.slice(call.index, close)
}

describe('迁到 useKunPagedList 的容器把 SSR 首屏数据交给状态机', () => {
  it.each(pagedListContainers)(
    '%s 传入 initial 且不再按挂载门控取数',
    (file) => {
      const source = readSource(file)
      const options = pagedListOptions(source)
      expect(options, '应存在 useKunPagedList 调用').not.toBeNull()
      expect(options).toMatch(/\n\s+initial: /)
      expect(source).not.toMatch(/\buseMounted\b/)
    }
  )
})

// initial* 已随 SSR 下发, 渲染层再按 !isMounted 返回骨架会让列表推迟到水合 + 一次重渲染后才可见
// (C58: 1x CPU 晚 43~61ms, 4x CPU 晚 260~376ms); isMounted 只用于跳过首屏 fetch
const renderGatePattern = /^\s*if \(!isMounted\) \{\s*return \(/m

describe('initial* 水合的列表容器, 首屏渲染不得被 isMounted 门控', () => {
  it.each([...containers, ...pagedListContainers])(
    '%s 不在渲染层按 !isMounted 返回占位',
    (file) => {
      expect(readSource(file)).not.toMatch(renderGatePattern)
    }
  )
})
