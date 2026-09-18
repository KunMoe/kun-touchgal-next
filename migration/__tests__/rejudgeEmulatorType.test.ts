import { describe, expect, it } from 'vitest'
import { parseEmulatorTypeVerdict } from '~/migration/rejudgeEmulatorType'

describe('parseEmulatorTypeVerdict', () => {
  it('解析型号数组并去重', () => {
    expect(parseEmulatorTypeVerdict('{"t":["krkr","krkr","ons"]}')).toEqual([
      'krkr',
      'ons'
    ])
  })

  it('剥离 markdown 围栏', () => {
    expect(parseEmulatorTypeVerdict('```json\n{"t":["joiplay"]}\n```')).toEqual(
      ['joiplay']
    )
  })

  it('词表外的型号降级为 other', () => {
    expect(parseEmulatorTypeVerdict('{"t":["krk2"]}')).toEqual(['other'])
  })

  it('空数组与非 JSON 一律降级为 other', () => {
    expect(parseEmulatorTypeVerdict('{"t":[]}')).toEqual(['other'])
    expect(parseEmulatorTypeVerdict('not json')).toEqual(['other'])
  })

  it('无证据兜底 {"t":["other"]} 原样通过', () => {
    expect(parseEmulatorTypeVerdict('{"t":["other"]}')).toEqual(['other'])
  })
})
