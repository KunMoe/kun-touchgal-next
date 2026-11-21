import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

// cap-widget 的源码写死了它要哪个版本的 @cap.js/wasm, 而本仓把那份 wasm 自托管在 public/cap/
// (useKunCap 用 CAP_CUSTOM_WASM_URL 指过去)。wasm 取不到或初始化不了时 widget 不报错, 只是静默换成
// 慢得多的 JS 解题器, 所以两边有没有对上只能在这里拦。package.json 把 cap-widget 钉成精确版本也是为了这一条。
//
// 升级 cap-widget 时如果它换了 wasm 版本, 这里会变红: 到 npm 取 @cap.js/wasm 那个版本的
// browser/cap_wasm_bg.wasm 算 sha256; 与 public/cap/ 那份相同就只在表里加一行, 不同则先替换文件再加
const KUN_CAP_WASM_SHA256: Record<string, string> = {
  '0.0.8': 'e4f3c00246a775193661f9277ca1288cd310a6514de166ecc2176ccd26fb06a9'
}

const root = process.cwd()
const sha256 = (path: string) =>
  createHash('sha256')
    .update(readFileSync(join(root, path)))
    .digest('hex')

describe('cap-widget 与自托管 wasm 的版本契约', () => {
  it('widget 要的 @cap.js/wasm 版本登记在表里, public/cap/ 下就是那一份', () => {
    // 版本从可读源码里读: 压缩后的变量名每个版本都在变
    const read = (file: string) =>
      readFileSync(join(root, 'node_modules/cap-widget', file), 'utf8')
    const versions = [
      ...read('src/cap.js').matchAll(/const WASM_VERSION = "([^"]+)"/g)
    ]
    expect(versions).toHaveLength(1)

    const version = versions[0][1]
    // 浏览器实际加载的是压缩产物, 它得与可读源码说的是同一个版本
    expect(read('cap.min.js')).toContain(`"${version}"`)
    expect(
      Object.keys(KUN_CAP_WASM_SHA256),
      `cap-widget 现在要 @cap.js/wasm@${version}, 表里没有登记`
    ).toContain(version)
    expect(sha256('public/cap/cap_wasm_bg.wasm')).toBe(
      KUN_CAP_WASM_SHA256[version]
    )
  })
})
