import { describe, expect, it } from 'vitest'
import {
  aiKindForPlan,
  buildAiUserContent,
  decideResource,
  extractS3FileName,
  parseAiVerdict,
  planResource
} from '~/migration/migrateCommunityGalgameResourceTaxonomy'

describe('planResource', () => {
  it('R15 删除优先级最高, 混入 patch/tool/notice 即删除', () => {
    expect(planResource(['patch'])).toEqual({ kind: 'delete' })
    expect(planResource(['tool'])).toEqual({ kind: 'delete' })
    expect(planResource(['chinese', 'patch', 'pc'])).toEqual({
      kind: 'delete'
    })
    expect(planResource(['notice', 'other'])).toEqual({ kind: 'delete' })
  })

  it('纯 other 先于 done 判定, 交给内容分流', () => {
    expect(planResource(['other'])).toEqual({ kind: 'content' })
  })

  it('已是新词表的组合判为 done', () => {
    expect(planResource(['game'])).toEqual({ kind: 'done' })
    expect(planResource(['audio'])).toEqual({ kind: 'done' })
    expect(planResource(['game', 'video'])).toEqual({ kind: 'done' })
  })

  it('精确规则匹配与 type 顺序无关', () => {
    expect(planResource(['pc', 'chinese'])).toMatchObject({
      kind: 'spec',
      spec: { rule: 'R1', platform: 'keep', ai: null }
    })
    expect(planResource(['mobile', 'emulator', 'chinese'])).toMatchObject({
      spec: { rule: 'R4', platform: ['emulator'], ai: 'emu-type' }
    })
  })

  it('覆盖用户给定的精确规则', () => {
    expect(planResource(['pc', 'row'])).toMatchObject({ spec: { rule: 'R2' } })
    expect(planResource(['app', 'chinese', 'mobile'])).toMatchObject({
      spec: { rule: 'R3', platform: ['apk'], ai: null }
    })
    expect(planResource(['chinese', 'mobile'])).toMatchObject({
      spec: { rule: 'R5', platform: [], ai: 'apk-or-emu' }
    })
    expect(planResource(['chinese', 'emulator', 'mobile', 'pc'])).toMatchObject(
      {
        spec: { rule: 'R6', platform: ['windows', 'emulator'], ai: 'emu-type' }
      }
    )
    expect(planResource(['pc'])).toMatchObject({
      spec: { rule: 'R8', platform: 'keep', ai: null }
    })
    expect(
      planResource(['app', 'chinese', 'emulator', 'mobile', 'pc'])
    ).toMatchObject({
      spec: {
        rule: 'R9',
        platform: ['windows', 'apk', 'emulator'],
        ai: 'emu-type'
      }
    })
    expect(planResource(['app', 'chinese', 'mobile', 'pc'])).toMatchObject({
      spec: { rule: 'R10', platform: ['windows', 'apk'], ai: null }
    })
    expect(planResource(['emulator'])).toMatchObject({
      spec: { rule: 'R11', platform: ['emulator'], ai: 'emu-type' }
    })
    expect(planResource(['emulator', 'mobile'])).toMatchObject({
      spec: { rule: 'R11' }
    })
    expect(planResource(['chinese', 'emulator', 'pc'])).toMatchObject({
      spec: { rule: 'R12', platform: ['windows', 'emulator'], ai: 'emu-type' }
    })
    expect(planResource(['chinese'])).toMatchObject({
      spec: { rule: 'R13', ai: 'platform' }
    })
    expect(planResource(['mobile'])).toMatchObject({
      spec: { rule: 'R13', ai: 'platform' }
    })
    expect(planResource(['app', 'chinese'])).toMatchObject({
      spec: { rule: 'R14', platform: ['apk'], ai: null }
    })
  })

  it('other 与游戏标记混杂进边角报告', () => {
    expect(planResource(['app', 'chinese', 'mobile', 'other'])).toMatchObject({
      kind: 'edge',
      reason: '含 other 的混合组合 {app,chinese,mobile,other}'
    })
    expect(planResource(['chinese', 'other', 'pc'])).toMatchObject({
      kind: 'edge'
    })
  })

  it('新旧词表之外的取值进边角报告', () => {
    expect(planResource(['weird'])).toMatchObject({
      kind: 'edge',
      reason: '词表外的 type 值 {weird}'
    })
  })

  it('泛化拆解: 纯 pc 组合保持 platform 不动', () => {
    expect(planResource(['chinese', 'pc', 'row'])).toMatchObject({
      spec: { rule: 'G-pc', platform: 'keep', ai: null }
    })
  })

  it('泛化拆解: 仅语言标记时交给 AI 判平台', () => {
    expect(planResource(['row'])).toMatchObject({
      spec: { rule: 'G-lang', ai: 'platform' }
    })
    expect(planResource(['chinese', 'row'])).toMatchObject({
      spec: { rule: 'G-lang', ai: 'platform' }
    })
  })

  it('泛化拆解: 标记并集映射到平台', () => {
    expect(planResource(['app', 'chinese', 'emulator', 'pc'])).toMatchObject({
      spec: {
        rule: 'G-emu',
        platform: ['windows', 'apk', 'emulator'],
        ai: 'emu-type'
      }
    })
    expect(
      planResource(['app', 'chinese', 'emulator', 'mobile'])
    ).toMatchObject({
      spec: { rule: 'G-emu', platform: ['apk', 'emulator'] }
    })
    expect(planResource(['app', 'chinese', 'pc'])).toMatchObject({
      spec: { rule: 'G-flags', platform: ['windows', 'apk'], ai: null }
    })
    // mobile 与 app 并存时安卓形态已确定为直装, 不需要 AI
    expect(planResource(['app', 'mobile', 'pc'])).toMatchObject({
      spec: { rule: 'G-flags', platform: ['windows', 'apk'], ai: null }
    })
  })

  it('泛化拆解: mobile 无 app/emulator 佐证时由 AI 分流', () => {
    expect(planResource(['chinese', 'mobile', 'pc'])).toMatchObject({
      spec: { rule: 'G-mobile', platform: ['windows'], ai: 'apk-or-emu' }
    })
    expect(planResource(['mobile', 'row'])).toMatchObject({
      spec: { rule: 'G-mobile', platform: [], ai: 'apk-or-emu' }
    })
  })
})

describe('aiKindForPlan', () => {
  it('按判定种类映射到对应 prompt', () => {
    expect(aiKindForPlan(planResource(['other']))).toBe('content')
    expect(aiKindForPlan(planResource(['chinese', 'emulator', 'mobile']))).toBe(
      'p1'
    )
    expect(aiKindForPlan(planResource(['chinese', 'mobile']))).toBe('p1')
    expect(aiKindForPlan(planResource(['chinese']))).toBe('platform')
  })

  it('无需 AI 的计划返回 null', () => {
    expect(aiKindForPlan(planResource(['chinese', 'pc']))).toBeNull()
    expect(aiKindForPlan(planResource(['patch']))).toBeNull()
    expect(aiKindForPlan(planResource(['game']))).toBeNull()
    expect(
      aiKindForPlan(planResource(['app', 'chinese', 'mobile', 'other']))
    ).toBeNull()
  })
})

describe('decideResource', () => {
  it('done 与 delete 直接透传', () => {
    expect(decideResource(['game'], null)).toEqual({ action: 'done' })
    expect(decideResource(['chinese', 'patch', 'pc'], null)).toEqual({
      action: 'delete'
    })
  })

  it('R1/R2/R8 只改 type, platform 保持不动', () => {
    expect(decideResource(['chinese', 'pc'], null)).toEqual({
      action: 'migrate',
      rule: 'R1',
      update: { type: ['game'] }
    })
    expect(decideResource(['pc'], null)).toEqual({
      action: 'migrate',
      rule: 'R8',
      update: { type: ['game'] }
    })
  })

  it('R3/R10/R14 覆写 platform, 无需 AI', () => {
    expect(decideResource(['app', 'chinese', 'mobile'], null)).toEqual({
      action: 'migrate',
      rule: 'R3',
      update: { type: ['game'], platform: ['apk'] }
    })
    expect(decideResource(['app', 'chinese', 'mobile', 'pc'], null)).toEqual({
      action: 'migrate',
      rule: 'R10',
      update: { type: ['game'], platform: ['windows', 'apk'] }
    })
  })

  it('emu-type 规则按 AI 型号填 emulator_type', () => {
    expect(
      decideResource(['chinese', 'emulator', 'mobile', 'pc'], {
        k: 'emulator',
        t: ['krkr', 'joiplay']
      })
    ).toEqual({
      action: 'migrate',
      rule: 'R6',
      update: {
        type: ['game'],
        platform: ['windows', 'emulator'],
        emulator_type: ['krkr', 'joiplay']
      }
    })
  })

  it('emu-type 规则判不出型号仍迁移, 填 other 并记报告', () => {
    for (const verdict of [{ k: 'uncertain' }, { k: 'apk' }] as const) {
      expect(decideResource(['chinese', 'emulator'], verdict)).toMatchObject({
        action: 'migrate',
        rule: 'R11',
        update: {
          type: ['game'],
          platform: ['emulator'],
          emulator_type: ['other']
        },
        report: { bucket: 'emu-unknown' }
      })
    }
  })

  it('R5 由 AI 在直装与模拟器间分流, 判不出则不迁移', () => {
    expect(decideResource(['chinese', 'mobile'], { k: 'apk' })).toEqual({
      action: 'migrate',
      rule: 'R5',
      update: { type: ['game'], platform: ['apk'] }
    })
    expect(
      decideResource(['chinese', 'mobile'], { k: 'emulator', t: ['ons'] })
    ).toMatchObject({
      update: { platform: ['emulator'], emulator_type: ['ons'] }
    })
    expect(
      decideResource(['chinese', 'mobile'], { k: 'both', t: ['krkr'] })
    ).toEqual({
      action: 'migrate',
      rule: 'R5',
      update: {
        type: ['game'],
        platform: ['apk', 'emulator'],
        emulator_type: ['krkr']
      }
    })
    expect(
      decideResource(['chinese', 'mobile'], { k: 'uncertain' })
    ).toMatchObject({
      action: 'skip',
      rule: 'R5',
      report: { bucket: 'platform-uncertain' }
    })
  })

  it('G-mobile 的 AI 结果并入基础平台集', () => {
    expect(decideResource(['chinese', 'mobile', 'pc'], { k: 'apk' })).toEqual({
      action: 'migrate',
      rule: 'G-mobile',
      update: { type: ['game'], platform: ['windows', 'apk'] }
    })
    expect(
      decideResource(['chinese', 'mobile', 'pc'], {
        k: 'emulator',
        t: ['krkr']
      })
    ).toMatchObject({
      update: {
        platform: ['windows', 'emulator'],
        emulator_type: ['krkr']
      }
    })
    expect(
      decideResource(['chinese', 'mobile', 'pc'], { k: 'both', t: ['ons'] })
    ).toEqual({
      action: 'migrate',
      rule: 'G-mobile',
      update: {
        type: ['game'],
        platform: ['windows', 'apk', 'emulator'],
        emulator_type: ['ons']
      }
    })
  })

  it('R13 平台三选一, 判不出则不迁移', () => {
    expect(decideResource(['chinese'], { k: 'windows' })).toEqual({
      action: 'migrate',
      rule: 'R13',
      update: { type: ['game'], platform: ['windows'] }
    })
    expect(decideResource(['mobile'], { k: 'apk' })).toMatchObject({
      update: { platform: ['apk'] }
    })
    expect(
      decideResource(['chinese'], { k: 'emulator', t: ['joiplay'] })
    ).toMatchObject({
      update: { platform: ['emulator'], emulator_type: ['joiplay'] }
    })
    expect(decideResource(['chinese'], { k: 'uncertain' })).toMatchObject({
      action: 'skip',
      rule: 'R13',
      report: { bucket: 'platform-uncertain' }
    })
  })

  it('R7 按内容分流, 兜底 other 时记报告', () => {
    expect(decideResource(['other'], { k: 'audio' })).toEqual({
      action: 'migrate',
      rule: 'R7',
      update: { type: ['audio'] }
    })
    expect(decideResource(['other'], { k: 'video' })).toMatchObject({
      update: { type: ['video'] }
    })
    expect(decideResource(['other'], { k: 'other' })).toMatchObject({
      action: 'migrate',
      update: { type: ['other'] },
      report: { bucket: 'content-fallback-other' }
    })
  })

  it('需要 AI 的规则在调用失败时不迁移', () => {
    expect(decideResource(['chinese', 'emulator'], null)).toMatchObject({
      action: 'skip',
      report: { bucket: 'ai-failed' }
    })
    expect(decideResource(['other'], null)).toMatchObject({
      action: 'skip',
      rule: 'R7',
      report: { bucket: 'ai-failed' }
    })
    expect(decideResource(['chinese'], null)).toMatchObject({
      action: 'skip',
      report: { bucket: 'ai-failed' }
    })
  })

  it('边角组合只记报告', () => {
    expect(
      decideResource(['app', 'chinese', 'mobile', 'other'], null)
    ).toMatchObject({
      action: 'skip',
      rule: null,
      report: { bucket: 'edge-other-mix' }
    })
  })
})

describe('parseAiVerdict', () => {
  it('p1: 解析裸 JSON 与 markdown 围栏, 型号去重', () => {
    expect(parseAiVerdict('p1', '{"k":"emulator","t":["ons"]}')).toEqual({
      k: 'emulator',
      t: ['ons']
    })
    expect(parseAiVerdict('p1', '```json\n{"k":"apk"}\n```')).toEqual({
      k: 'apk'
    })
    expect(
      parseAiVerdict('p1', '{"k":"emulator","t":["krkr","krkr"]}')
    ).toEqual({ k: 'emulator', t: ['krkr'] })
    expect(parseAiVerdict('p1', '{"k":"both","t":["krkr","ons"]}')).toEqual({
      k: 'both',
      t: ['krkr', 'ons']
    })
  })

  it('p1: 非法输出一律降级为 uncertain', () => {
    expect(parseAiVerdict('p1', '这是一个模拟器资源')).toEqual({
      k: 'uncertain'
    })
    expect(parseAiVerdict('p1', '{"k":"emulator","t":["renpy"]}')).toEqual({
      k: 'uncertain'
    })
    expect(parseAiVerdict('p1', '{"k":"emulator","t":[]}')).toEqual({
      k: 'uncertain'
    })
    expect(parseAiVerdict('p1', '{"k":"windows"}')).toEqual({
      k: 'uncertain'
    })
    expect(parseAiVerdict('p1', '{"k":"both"}')).toEqual({
      k: 'uncertain'
    })
    expect(parseAiVerdict('p1', '{"k":"both","t":["renpy"]}')).toEqual({
      k: 'uncertain'
    })
  })

  it('platform: 支持 windows/apk/emulator/uncertain', () => {
    expect(parseAiVerdict('platform', '{"k":"windows"}')).toEqual({
      k: 'windows'
    })
    expect(parseAiVerdict('platform', '{"k":"apk"}')).toEqual({ k: 'apk' })
    expect(parseAiVerdict('platform', '{"k":"emulator","t":["krkr"]}')).toEqual(
      { k: 'emulator', t: ['krkr'] }
    )
    expect(parseAiVerdict('platform', '{"k":"emulator"}')).toEqual({
      k: 'uncertain'
    })
    expect(parseAiVerdict('platform', '{"k":"audio"}')).toEqual({
      k: 'uncertain'
    })
  })

  it('content: 无 uncertain, 非法输出兜底为 other', () => {
    expect(parseAiVerdict('content', '{"k":"audio"}')).toEqual({ k: 'audio' })
    expect(parseAiVerdict('content', '{"k":"image"}')).toEqual({ k: 'image' })
    expect(parseAiVerdict('content', '{"k":"video"}')).toEqual({ k: 'video' })
    expect(parseAiVerdict('content', '{"k":"uncertain"}')).toEqual({
      k: 'other'
    })
    expect(parseAiVerdict('content', '判断不了')).toEqual({ k: 'other' })
  })
})

describe('extractS3FileName', () => {
  it('取 URL 末段并解码', () => {
    expect(
      extractS3FileName(
        'https://s3.example.com/patch/1/resource/abc123/game%20setup.zip'
      )
    ).toBe('game setup.zip')
  })

  it('旧格式 hash 结尾与非 URL 返回 null', () => {
    expect(
      extractS3FileName(
        'https://s3.example.com/patch/1/resource/0123456789abcdef0123456789abcdef'
      )
    ).toBeNull()
    expect(extractS3FileName('not a url')).toBeNull()
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

  it('platform 判定附带原分类/原平台佐证行', () => {
    expect(
      buildAiUserContent('某游戏', '备注', [], {
        type: ['chinese'],
        platform: ['android', 'windows']
      })
    ).toBe(
      '标题: 某游戏\n备注: 备注\n原分类: {chinese}\n原平台: {android,windows}\n网盘文件名:\n(无)'
    )
    expect(
      buildAiUserContent('某游戏', '', [], { type: ['mobile'], platform: [] })
    ).toContain('原平台: (空)')
  })
})
