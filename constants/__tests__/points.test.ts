import { describe, expect, it } from 'vitest'
import { meetsPointGate, POINT_GATE_MESSAGE } from '~/constants/points'
import { canPublishResource } from '~/constants/permission'

describe('meetsPointGate: 门槛是「不少于 minBalance」', () => {
  it.each([
    { gate: 'publishResource', below: 19, at: 20 },
    { gate: 'conversation', below: 19, at: 20 },
    { gate: 'rename', below: 29, at: 30 }
  ] as const)('$gate: $below 不过, $at 过', ({ gate, below, at }) => {
    expect(meetsPointGate(gate, { moemoepoint: below })).toBe(false)
    expect(meetsPointGate(gate, { moemoepoint: at })).toBe(true)
  })

  it('负余额不过', () => {
    expect(meetsPointGate('publishResource', { moemoepoint: -5 })).toBe(false)
  })

  it('提示里的数值取自规则表', () => {
    expect(POINT_GATE_MESSAGE).toEqual({
      publishResource: '仅限萌萌点不少于 20 的用户才可以发布资源',
      conversation: '萌萌点不足，发起私聊需要至少 20 萌萌点',
      rename: '更改用户名最少需要 30 萌萌点, 您的萌萌点不足'
    })
  })
})

describe('canPublishResource: 管理员豁免, 其余按门槛', () => {
  it.each([
    { role: 3, moemoepoint: 10, expected: true },
    { role: 4, moemoepoint: -1, expected: true },
    { role: 2, moemoepoint: 19, expected: false },
    { role: 2, moemoepoint: 20, expected: true },
    { role: 1, moemoepoint: 19, expected: false },
    { role: 1, moemoepoint: 20, expected: true }
  ])(
    'role $role、萌萌点 $moemoepoint → $expected',
    ({ role, moemoepoint, expected }) => {
      expect(canPublishResource({ uid: 1, role, moemoepoint })).toBe(expected)
    }
  )

  it('游客与空主体不能发布', () => {
    expect(canPublishResource(null)).toBe(false)
    expect(canPublishResource({ uid: 0, role: 3, moemoepoint: 100 })).toBe(
      false
    )
  })
})
