import { describe, expect, it } from 'vitest'
import { keyFromContent } from '~/server/storage/references'

describe('keyFromContent', () => {
  it('取存储地址之后的对象 key', () => {
    expect(
      keyFromContent('https://cloud.example.test/patch/12/resource/abc/f.zip')
    ).toBe('patch/12/resource/abc/f.zip')
  })

  it('换过域名、带子路径的存储地址照样取得出', () => {
    expect(
      keyFromContent('https://cdn.example.test/kun/patch/3/resource/h/a b.7z')
    ).toBe('patch/3/resource/h/a b.7z')
  })

  it('取第一个「/patch/<数字>/resource/」起的尾段', () => {
    expect(
      keyFromContent('https://x.test/patch/1/resource/h/patch/2/resource/f')
    ).toBe('patch/1/resource/h/patch/2/resource/f')
  })

  it('要求前面是路径分隔符, 段号必须是数字', () => {
    expect(keyFromContent('https://x.test/xpatch/1/resource/h/f')).toBeNull()
    expect(keyFromContent('https://x.test/patch/tmp/resource/h/f')).toBeNull()
    expect(keyFromContent('patch/1/resource/h/f')).toBeNull()
  })

  it('不是资源前缀的地址返回 null', () => {
    expect(keyFromContent('https://x.test/patch/1/banner/b.avif')).toBeNull()
    expect(keyFromContent('https://x.test/patch/1/resource/')).toBeNull()
    expect(keyFromContent('')).toBeNull()
  })
})
