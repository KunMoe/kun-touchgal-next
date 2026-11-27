import { describe, expect, it } from 'vitest'
import {
  RESOURCE_SECTION_MAP,
  RESOURCE_SECTION_TYPE_MAP,
  SUPPORTED_EMULATOR_TYPE,
  SUPPORTED_EMULATOR_TYPE_MAP,
  SUPPORTED_LANGUAGE,
  SUPPORTED_LANGUAGE_MAP,
  SUPPORTED_PLATFORM,
  SUPPORTED_PLATFORM_MAP,
  SUPPORTED_RESOURCE_LINK,
  SUPPORTED_RESOURCE_LINK_MAP,
  SUPPORTED_RESOURCE_SECTION,
  SUPPORTED_TYPE,
  SUPPORTED_TYPE_MAP,
  resourceTypes,
  storageTypes
} from '~/constants/resource'

// 同一份词表在这个文件里各有两到四张平行表 (取值列表、文案表、下拉选项、按类别的分组)。
// 加值或删值时漏改其中一张, 现象是下拉里选得到却被校验拒收, 或落了库却显示成空白
const sorted = (values: readonly string[]) => [...values].sort()
const labelKeys = (map: Record<string, string>) =>
  sorted(Object.keys(map).filter((key) => key !== 'all'))

describe('资源词表的平行表键集一致', () => {
  it('类型', () => {
    expect(new Set(SUPPORTED_TYPE).size).toBe(SUPPORTED_TYPE.length)
    expect(sorted(resourceTypes.map((type) => type.value))).toEqual(
      sorted(SUPPORTED_TYPE)
    )
    expect(labelKeys(SUPPORTED_TYPE_MAP)).toEqual(sorted(SUPPORTED_TYPE))
    expect(
      sorted([...new Set(Object.values(RESOURCE_SECTION_TYPE_MAP).flat())])
    ).toEqual(sorted(SUPPORTED_TYPE))
  })

  it('类别', () => {
    expect(sorted(Object.keys(RESOURCE_SECTION_MAP))).toEqual(
      sorted(SUPPORTED_RESOURCE_SECTION)
    )
    expect(sorted(Object.keys(RESOURCE_SECTION_TYPE_MAP))).toEqual(
      sorted(SUPPORTED_RESOURCE_SECTION)
    )
  })

  it('语言、平台、模拟器类型', () => {
    expect(labelKeys(SUPPORTED_LANGUAGE_MAP)).toEqual(
      sorted(SUPPORTED_LANGUAGE)
    )
    expect(labelKeys(SUPPORTED_PLATFORM_MAP)).toEqual(
      sorted(SUPPORTED_PLATFORM)
    )
    expect(labelKeys(SUPPORTED_EMULATOR_TYPE_MAP)).toEqual(
      sorted(SUPPORTED_EMULATOR_TYPE)
    )
  })

  it('存储方式', () => {
    expect(sorted(storageTypes.map((storage) => storage.value))).toEqual(
      sorted(SUPPORTED_RESOURCE_LINK)
    )
    expect(labelKeys(SUPPORTED_RESOURCE_LINK_MAP)).toEqual(
      sorted(SUPPORTED_RESOURCE_LINK)
    )
  })

  // 两条联动 (模拟器平台 → 模拟器类型, AI 补丁 → 模型型号) 在判据与落库归一化里按字面量触发:
  // 这两个值改名之后联动会静默失效
  it('联动的触发值仍在词表里', () => {
    expect(SUPPORTED_PLATFORM).toContain('emulator')
    expect(RESOURCE_SECTION_TYPE_MAP.patch).toContain('ai')
  })
})
