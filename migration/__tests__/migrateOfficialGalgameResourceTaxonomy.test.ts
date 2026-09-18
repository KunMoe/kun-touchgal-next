import { describe, expect, it } from 'vitest'
import {
  buildAiUserContent,
  decideResource,
  matchRule,
  parseAiVerdict,
  ruleNeedsAi
} from '~/migration/migrateOfficialGalgameResourceTaxonomy'

describe('matchRule', () => {
  it('匹配与 type 顺序无关', () => {
    expect(matchRule(['chinese', 'pc'])).toBe('R1')
    expect(matchRule(['pc', 'chinese'])).toBe('R1')
    expect(matchRule(['mobile', 'emulator', 'chinese'])).toBe('R4')
  })

  it('覆盖计划中的五条规则', () => {
    expect(matchRule(['pc', 'row'])).toBe('R2')
    expect(matchRule(['app', 'chinese', 'mobile'])).toBe('R3')
    expect(matchRule(['app', 'mobile', 'row'])).toBe('R3')
    expect(matchRule(['emulator', 'mobile', 'row'])).toBe('R4')
    expect(matchRule(['chinese', 'mobile'])).toBe('R5')
  })

  it('未覆盖的组合返回 null', () => {
    expect(matchRule(['chinese', 'emulator', 'mobile', 'pc'])).toBeNull()
    expect(matchRule(['tool'])).toBeNull()
    expect(matchRule([])).toBeNull()
  })

  it('只有 R4/R5 需要 AI', () => {
    expect(ruleNeedsAi('R4')).toBe(true)
    expect(ruleNeedsAi('R5')).toBe(true)
    expect(ruleNeedsAi('R1')).toBe(false)
    expect(ruleNeedsAi('R3')).toBe(false)
    expect(ruleNeedsAi(null)).toBe(false)
  })
})

describe('decideResource', () => {
  it('已是新词表的资源判为 done, 使脚本可重跑', () => {
    expect(decideResource(['game'], ['apk'], null)).toEqual({ action: 'done' })
    expect(decideResource(['game', 'video'], ['windows'], null)).toEqual({
      action: 'done'
    })
  })

  it('R1/R2 只改 type, platform 保持不动', () => {
    expect(decideResource(['chinese', 'pc'], ['macos'], null)).toEqual({
      action: 'migrate',
      rule: 'R1',
      update: { type: ['game'] }
    })
    expect(decideResource(['pc', 'row'], ['windows'], null)).toEqual({
      action: 'migrate',
      rule: 'R2',
      update: { type: ['game'] }
    })
  })

  it('R3 覆写 platform 为 apk, windows 误标一并覆写', () => {
    expect(
      decideResource(['app', 'chinese', 'mobile'], ['android'], null)
    ).toEqual({
      action: 'migrate',
      rule: 'R3',
      update: { type: ['game'], platform: ['apk'] }
    })
    expect(
      decideResource(['app', 'mobile', 'row'], ['windows'], null)
    ).toMatchObject({
      action: 'migrate',
      update: { platform: ['apk'] }
    })
  })

  it('R3 含 ios 时不迁移, 记 r3-ios', () => {
    const decision = decideResource(
      ['app', 'chinese', 'mobile'],
      ['android', 'ios'],
      null
    )
    expect(decision).toMatchObject({
      action: 'skip',
      rule: 'R3',
      report: { bucket: 'r3-ios' }
    })
  })

  it('R4 按 AI 型号填 emulator_type', () => {
    expect(
      decideResource(['chinese', 'emulator', 'mobile'], ['android'], {
        k: 'emulator',
        t: ['krkr']
      })
    ).toEqual({
      action: 'migrate',
      rule: 'R4',
      update: {
        type: ['game'],
        platform: ['emulator'],
        emulator_type: ['krkr']
      },
      report: undefined
    })
  })

  it('AI 判出多个型号时全部填入 emulator_type', () => {
    expect(
      decideResource(['chinese', 'mobile'], ['android'], {
        k: 'emulator',
        t: ['krkr', 'joiplay']
      })
    ).toMatchObject({
      action: 'migrate',
      rule: 'R5',
      update: {
        type: ['game'],
        platform: ['emulator'],
        emulator_type: ['krkr', 'joiplay']
      }
    })
  })

  it('R4 判不出型号仍迁移, 填 other 并记报告', () => {
    for (const verdict of [{ k: 'uncertain' }, { k: 'apk' }] as const) {
      expect(
        decideResource(
          ['emulator', 'mobile', 'row'],
          ['android', 'ios'],
          verdict
        )
      ).toMatchObject({
        action: 'migrate',
        rule: 'R4',
        update: {
          type: ['game'],
          platform: ['emulator'],
          emulator_type: ['other']
        },
        report: { bucket: 'r4-unknown-emulator' }
      })
    }
  })

  it('R5 明确模拟器走 R4 形态, 明确直装走 R3 形态', () => {
    expect(
      decideResource(['chinese', 'mobile'], ['android'], {
        k: 'emulator',
        t: ['joiplay']
      })
    ).toMatchObject({
      action: 'migrate',
      rule: 'R5',
      update: {
        type: ['game'],
        platform: ['emulator'],
        emulator_type: ['joiplay']
      }
    })
    expect(
      decideResource(['chinese', 'mobile'], ['android'], { k: 'apk' })
    ).toEqual({
      action: 'migrate',
      rule: 'R5',
      update: { type: ['game'], platform: ['apk'] }
    })
  })

  it('R5 无法确定时不迁移', () => {
    expect(
      decideResource(['chinese', 'mobile'], ['android'], { k: 'uncertain' })
    ).toMatchObject({
      action: 'skip',
      rule: 'R5',
      report: { bucket: 'r5-uncertain' }
    })
  })

  it('R4/R5 在 AI 调用失败时不迁移', () => {
    expect(
      decideResource(['chinese', 'emulator', 'mobile'], ['android'], null)
    ).toMatchObject({ action: 'skip', report: { bucket: 'ai-failed' } })
    expect(
      decideResource(['chinese', 'mobile'], ['android'], null)
    ).toMatchObject({ action: 'skip', report: { bucket: 'ai-failed' } })
  })

  it('未覆盖的组合只记边角', () => {
    expect(
      decideResource(['chinese', 'emulator', 'mobile', 'pc'], ['windows'], null)
    ).toMatchObject({
      action: 'skip',
      rule: null,
      report: { bucket: 'other-combo' }
    })
    expect(decideResource(['tool'], ['other'], null)).toMatchObject({
      report: { reason: '未覆盖的 type 组合 {tool}' }
    })
  })
})

describe('parseAiVerdict', () => {
  it('解析裸 JSON 与 markdown 围栏', () => {
    expect(parseAiVerdict('{"k":"emulator","t":["ons"]}')).toEqual({
      k: 'emulator',
      t: ['ons']
    })
    expect(parseAiVerdict('{"k":"emulator","t":["krkr","joiplay"]}')).toEqual({
      k: 'emulator',
      t: ['krkr', 'joiplay']
    })
    expect(parseAiVerdict('```json\n{"k":"apk"}\n```')).toEqual({ k: 'apk' })
    expect(parseAiVerdict('```\n{"k":"uncertain"}\n```')).toEqual({
      k: 'uncertain'
    })
  })

  it('剥离多余字段并对型号去重', () => {
    expect(
      parseAiVerdict(
        '{"k":"emulator","t":["krkr","krkr"],"reason":"文件名以 .xp3 结尾"}'
      )
    ).toEqual({ k: 'emulator', t: ['krkr'] })
  })

  it('兼容旧版单型号输出', () => {
    expect(parseAiVerdict('{"k":"emulator","t":"krkr"}')).toEqual({
      k: 'emulator',
      t: ['krkr']
    })
  })

  it('非法输出一律降级为 uncertain', () => {
    expect(parseAiVerdict('这是一个模拟器资源')).toEqual({ k: 'uncertain' })
    expect(parseAiVerdict('')).toEqual({ k: 'uncertain' })
    expect(parseAiVerdict('{"k":"emulator","t":["renpy"]}')).toEqual({
      k: 'uncertain'
    })
    expect(parseAiVerdict('{"k":"emulator","t":[]}')).toEqual({
      k: 'uncertain'
    })
    expect(parseAiVerdict('{"k":"emulator"}')).toEqual({ k: 'uncertain' })
    expect(parseAiVerdict('{"k":"game"}')).toEqual({ k: 'uncertain' })
  })
})

describe('buildAiUserContent', () => {
  it('空标题/备注/文件名有占位, 备注截断到 500 字', () => {
    expect(buildAiUserContent('', '', [])).toBe(
      '标题: (空)\n备注: (空)\n网盘文件名:\n(无)'
    )
    expect(
      buildAiUserContent('手机版', 'x'.repeat(600), ['a.apk', 'b.zip'])
    ).toBe(
      `标题: 手机版\n备注: ${'x'.repeat(500)}\n网盘文件名:\n- a.apk\n- b.zip`
    )
  })
})
