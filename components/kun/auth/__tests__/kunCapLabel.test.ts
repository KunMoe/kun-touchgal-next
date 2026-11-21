import { describe, expect, it } from 'vitest'
import {
  changeKunCapLines,
  initialKunCapLines,
  removeKunCapLine,
  settleKunCapLines
} from '~/components/kun/auth/kunCapLabel'
import type { KunCapLine } from '~/components/kun/auth/kunCapLabel'

const line = (
  id: number,
  text: string,
  phase: KunCapLine['phase']
): KunCapLine => ({ id, text, phase })

describe('验证按钮上的字: 各行的进退', () => {
  it('一开始只有一行, 已经就位', () => {
    expect(initialKunCapLines('我是真人')).toEqual([
      line(0, '我是真人', 'active')
    ])
  })

  it('换字: 在场的那行转为滑出, 新的一行排在末尾等着滑入', () => {
    expect(
      changeKunCapLines(initialKunCapLines('我是真人'), '正在验证...', false)
    ).toEqual([line(0, '我是真人', 'exit'), line(1, '正在验证...', 'enter')])
  })

  it('字没变就原样返回 (不重新滑一遍)', () => {
    const lines = [
      line(0, '我是真人', 'exit'),
      line(1, '正在验证...', 'active')
    ]
    expect(changeKunCapLines(lines, '正在验证...', false)).toBe(lines)
    expect(changeKunCapLines(lines, '正在验证...', true)).toBe(lines)
  })

  it('上一行还没滑完又换字: 两行都在滑出, 第三行滑入, 编号不重复', () => {
    const lines = [
      line(0, '我是真人', 'exit'),
      line(1, '正在验证...', 'active')
    ]
    expect(changeKunCapLines(lines, '验证出错, 请点击重试', false)).toEqual([
      line(0, '我是真人', 'exit'),
      line(1, '正在验证...', 'exit'),
      line(2, '验证出错, 请点击重试', 'enter')
    ])
  })

  it('换回一行正在滑出的字: 另起一行滑入, 不把滑出的那行拉回来', () => {
    const lines = [
      line(3, '正在验证...', 'exit'),
      line(4, '验证出错', 'active')
    ]
    expect(changeKunCapLines(lines, '正在验证...', false)).toEqual([
      line(3, '正在验证...', 'exit'),
      line(4, '验证出错', 'exit'),
      line(5, '正在验证...', 'enter')
    ])
  })

  it('不做动画时只剩新的一行, 还在滑出的旧行一并拿掉, 编号照样往后排', () => {
    const lines = [
      line(0, '验证通过', 'exit'),
      line(1, '正在加载...', 'active')
    ]
    expect(changeKunCapLines(lines, '我是真人', true)).toEqual([
      line(2, '我是真人', 'active')
    ])
  })

  it('放行到位: 只动等着滑入的那行; 没有这样的行就原样返回', () => {
    const waiting = [
      line(0, '我是真人', 'exit'),
      line(1, '正在验证...', 'enter')
    ]
    expect(settleKunCapLines(waiting)).toEqual([
      line(0, '我是真人', 'exit'),
      line(1, '正在验证...', 'active')
    ])
    const settled = [
      line(0, '我是真人', 'exit'),
      line(1, '正在验证...', 'active')
    ]
    expect(settleKunCapLines(settled)).toBe(settled)
  })

  it('滑出完毕的行被拿掉; 没在滑出的行拿不掉', () => {
    const lines = [
      line(0, '我是真人', 'exit'),
      line(1, '正在验证...', 'active')
    ]
    expect(removeKunCapLine(lines, 0)).toEqual([
      line(1, '正在验证...', 'active')
    ])
    expect(removeKunCapLine(lines, 1)).toEqual(lines)
  })
})
