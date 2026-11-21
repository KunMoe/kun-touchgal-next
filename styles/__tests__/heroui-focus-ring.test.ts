import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile } from 'tailwindcss'
import { describe, expect, it } from 'vitest'

// HeroUI 控件的键盘焦点环在 Tailwind 4.3 下画不出来, styles/index.css 里有一条规则把它救回来
// (原因写在那条规则的注释里)。这里钉住它成立的两个前提和它本身。哪一条变红, 先判断那条规则
// 还需不需要、还够不够, 再改断言
const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const read = (path: string) => readFileSync(join(repoRoot, path), 'utf-8')

describe('HeroUI 键盘焦点环', () => {
  it('前提一: HeroUI 的基类是 outline-hidden 加按 data-focus-visible 画的 outline', () => {
    const dist = 'node_modules/@heroui/theme/dist'
    const definitions = readdirSync(join(repoRoot, dist))
      .filter((file) => /^chunk-.*\.mjs$/.test(file))
      .flatMap((file) => [
        ...read(join(dist, file)).matchAll(
          /var dataFocusVisibleClasses = \[([\s\S]*?)\n\];/g
        )
      ])
    expect(definitions).toHaveLength(1)

    const classes = [...definitions[0][1].matchAll(/"([^"]+)"/g)].map(
      ([, name]) => name
    )
    expect(classes).toContain('outline-hidden')
    expect(classes).toContain('data-[focus-visible=true]:outline-2')
  })

  it('前提二: Tailwind 的 outline-hidden 把线型变量置为 none, outline-2 的线型取自这个变量', async () => {
    const { build } = await compile('@tailwind utilities;')
    const css = build(['outline-hidden', 'data-[focus-visible=true]:outline-2'])
    const rule = (selector: string) =>
      css.slice(css.indexOf(selector)).split('}')[0]

    expect(rule('.outline-hidden {')).toContain('--tw-outline-style: none')
    expect(rule('[data-focus-visible="true"] {')).toContain(
      'outline-style: var(--tw-outline-style)'
    )
  })

  it('styles/index.css 在键盘聚焦时把线型变量还原, 且这条规则不在任何 @layer 里', () => {
    const css = read('styles/index.css').replace(/\/\*[\s\S]*?\*\//g, '')
    const rule =
      /\[data-focus-visible='true'\]\s*\{\s*--tw-outline-style:\s*solid;\s*\}/
    const at = css.search(rule)
    expect(at).toBeGreaterThan(-1)

    // 规则之前的花括号全部配平 = 它在样式表的顶层
    const before = css.slice(0, at)
    expect(before.split('{').length).toBe(before.split('}').length)
  })
})
