import { describe, expect, it } from 'vitest'
import {
  REMOVED_EMULATOR_TYPES,
  decideResource
} from '~/migration/removeWinlatorGaishiEmulatorType'

describe('REMOVED_EMULATOR_TYPES', () => {
  it('待删词表恰为 winlator 与 gaishi', () => {
    expect(REMOVED_EMULATOR_TYPES).toEqual(['winlator', 'gaishi'])
  })
})

describe('decideResource', () => {
  it('仍有其他模拟器类型时只裁剪 emulator_type, platform 不动', () => {
    expect(
      decideResource(['emulator', 'windows'], ['winlator', 'krkr'])
    ).toEqual({
      kind: 'trim-only',
      emulator_type: ['krkr'],
      platform: ['emulator', 'windows']
    })
  })

  it('模拟器类型清空且仍有其他平台时去掉 emulator 平台', () => {
    expect(decideResource(['windows', 'emulator'], ['winlator'])).toEqual({
      kind: 'drop-emulator',
      emulator_type: [],
      platform: ['windows']
    })
  })

  it('模拟器类型清空且 platform 随之为空时标记需人工处理', () => {
    expect(decideResource(['emulator'], ['gaishi', 'winlator'])).toEqual({
      kind: 'drop-emulator-empty-platform',
      emulator_type: [],
      platform: []
    })
  })

  it('平台本就不含 emulator 时只裁剪 emulator_type', () => {
    expect(decideResource(['windows'], ['gaishi'])).toEqual({
      kind: 'trim-only',
      emulator_type: [],
      platform: ['windows']
    })
  })

  it('不含待删值时返回 null', () => {
    expect(decideResource(['emulator'], ['krkr', 'ons'])).toBeNull()
  })

  it('保留剩余模拟器类型的原有顺序', () => {
    expect(
      decideResource(['emulator'], ['ons', 'winlator', 'krkr', 'gaishi'])
    ).toMatchObject({ emulator_type: ['ons', 'krkr'] })
  })
})
