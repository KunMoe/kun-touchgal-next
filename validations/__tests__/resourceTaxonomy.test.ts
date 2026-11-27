import { describe, expect, it } from 'vitest'
import {
  findTaxonomyViolations,
  isMembershipViolation
} from '~/validations/resourceTaxonomy'
import { patchResourceCreateSchema } from '~/validations/patch'
import { RESOURCE_SECTION_TYPE_MAP } from '~/constants/resource'
import type {
  ResourceTaxonomyRow,
  TaxonomyViolation
} from '~/validations/resourceTaxonomy'

const clean: ResourceTaxonomyRow = {
  section: 'patch',
  type: ['manual'],
  language: ['zh-Hans'],
  platform: ['windows'],
  emulatorType: [],
  modelName: ''
}

const violationsOf = (fields: Partial<ResourceTaxonomyRow>) =>
  findTaxonomyViolations({ ...clean, ...fields })

// 资源校验里与分类无关、能通过的其余字段
const acceptedRest = {
  patchId: 1,
  name: '测试资源',
  note: '',
  links: [
    {
      storage: 'user',
      content: 'https://example.com/file.zip',
      size: '100MB',
      code: '',
      password: ''
    }
  ]
}

describe('findTaxonomyViolations', () => {
  it('每个类别下允许的每个类型都是干净的', () => {
    for (const [section, types] of Object.entries(RESOURCE_SECTION_TYPE_MAP)) {
      for (const type of types) {
        expect(
          violationsOf({
            section,
            type: [type],
            modelName: type === 'ai' ? 'GPT-4o' : ''
          })
        ).toEqual([])
      }
    }
  })

  // 新旧词表都有 other: 判据只看值, 分不出一行 {other} 是迁移前留下的还是用户新选的
  it('other 在两个类别下都合法', () => {
    expect(violationsOf({ section: 'galgame', type: ['other'] })).toEqual([])
    expect(violationsOf({ section: 'patch', type: ['other'] })).toEqual([])
  })

  it.each<[string, Partial<ResourceTaxonomyRow>, TaxonomyViolation[]]>([
    [
      '类别不在词表里: 无从判断类型属不属于它',
      { section: 'tool' },
      [{ kind: 'unknown-value', field: 'section', values: ['tool'] }]
    ],
    [
      '旧类型值: 既不在词表里, 也不属于所在类别',
      { section: 'galgame', type: ['pc', 'chinese', 'game'] },
      [
        { kind: 'unknown-value', field: 'type', values: ['pc', 'chinese'] },
        { kind: 'section-type', values: ['pc', 'chinese'] }
      ]
    ],
    [
      // 类别叫 patch, 资源类型里的 patch 却是迁移前的旧值
      '资源类型里的 patch 是旧值',
      { section: 'patch', type: ['patch'] },
      [
        { kind: 'unknown-value', field: 'type', values: ['patch'] },
        { kind: 'section-type', values: ['patch'] }
      ]
    ],
    [
      '词表里的类型放错了类别',
      { section: 'galgame', type: ['game', 'manual'] },
      [{ kind: 'section-type', values: ['manual'] }]
    ],
    [
      '旧语言值',
      { language: ['chinese', 'ja'] },
      [{ kind: 'unknown-value', field: 'language', values: ['chinese'] }]
    ],
    [
      '旧平台值 android / ios',
      { platform: ['android', 'ios', 'windows'] },
      [{ kind: 'unknown-value', field: 'platform', values: ['android', 'ios'] }]
    ],
    [
      '已删除的模拟器类型',
      { platform: ['emulator'], emulatorType: ['winlator', 'joiplay'] },
      [{ kind: 'unknown-value', field: 'emulatorType', values: ['winlator'] }]
    ],
    [
      // 选了、但选的值已不在词表里: 报词表外的值, 不算「没选模拟器类型」
      '模拟器类型全是已删除的值',
      { platform: ['emulator'], emulatorType: ['winlator'] },
      [{ kind: 'unknown-value', field: 'emulatorType', values: ['winlator'] }]
    ],
    [
      '同一个词表外的值出现多次只列一次',
      { platform: ['android', 'android'] },
      [{ kind: 'unknown-value', field: 'platform', values: ['android'] }]
    ],
    [
      '同一个放错类别的类型出现多次只列一次',
      { section: 'galgame', type: ['manual', 'manual'] },
      [{ kind: 'section-type', values: ['manual'] }]
    ],
    ['类型为空', { type: [] }, [{ kind: 'empty', field: 'type' }]],
    ['语言为空', { language: [] }, [{ kind: 'empty', field: 'language' }]],
    ['平台为空', { platform: [] }, [{ kind: 'empty', field: 'platform' }]],
    [
      '平台含模拟器却没有模拟器类型',
      { platform: ['windows', 'emulator'] },
      [{ kind: 'emulator-type-required' }]
    ],
    [
      '类型含 AI 补丁却没有模型型号',
      { type: ['ai'] },
      [{ kind: 'model-name-required' }]
    ],
    [
      '只有空白的模型型号等于没填',
      { type: ['ai'], modelName: '   ' },
      [{ kind: 'model-name-required' }]
    ],
    [
      '平台不含模拟器却留着模拟器类型',
      { emulatorType: ['joiplay'] },
      [{ kind: 'emulator-type-orphan' }]
    ],
    [
      '类型不含 AI 补丁却留着模型型号',
      { modelName: 'GPT-4o' },
      [{ kind: 'model-name-orphan' }]
    ],
    [
      // 落库前的归一化给非 AI 补丁写的是空串, 只有空白也是残值
      '只有空白的模型型号留在非 AI 补丁上也是孤儿值',
      { modelName: '   ' },
      [{ kind: 'model-name-orphan' }]
    ]
  ])('%s', (_, fields, expected) => {
    expect(violationsOf(fields)).toEqual(expected)
  })

  // section 来自请求体: 拿它直接查对象字面量会命中原型链, 再对查到的东西调 includes 就抛异常
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    '类别取对象原型上的成员名 %s 时按词表外的类别处理',
    (section) => {
      expect(violationsOf({ section })).toEqual([
        { kind: 'unknown-value', field: 'section', values: [section] }
      ])
    }
  )

  // 校验按这个先后报错
  const keysOf = (row: ResourceTaxonomyRow) =>
    findTaxonomyViolations(row).map((violation) =>
      'field' in violation
        ? `${violation.kind}:${violation.field}`
        : violation.kind
    )

  it('违规按固定顺序给出', () => {
    expect(
      keysOf({
        section: 'tool',
        type: ['pc'],
        language: ['chinese'],
        platform: ['android'],
        emulatorType: ['winlator'],
        modelName: 'GPT-4o'
      })
    ).toEqual([
      'unknown-value:section',
      'unknown-value:type',
      'unknown-value:language',
      'unknown-value:platform',
      'unknown-value:emulatorType',
      'emulator-type-orphan',
      'model-name-orphan'
    ])
    expect(
      keysOf({
        section: 'galgame',
        type: ['ai'],
        language: [],
        platform: ['emulator'],
        emulatorType: [],
        modelName: ''
      })
    ).toEqual([
      'empty:language',
      'section-type',
      'emulator-type-required',
      'model-name-required'
    ])
    expect(keysOf({ ...clean, type: [], platform: [] })).toEqual([
      'empty:type',
      'empty:platform'
    ])
  })

  // 每个字段最多 10 项是表单的限制, 不是词表规则: 补丁类别的 11 个类型全选, 校验拒收,
  // 判据不报。库里的数组列没有条数约束, 这样的行核查算干净
  it('不管条数上限', () => {
    const row = {
      ...clean,
      type: RESOURCE_SECTION_TYPE_MAP.patch,
      modelName: 'GPT-4o'
    }
    expect(row.type).toHaveLength(11)
    expect(findTaxonomyViolations(row)).toEqual([])
    expect(
      patchResourceCreateSchema.safeParse({ ...acceptedRest, ...row }).success
    ).toBe(false)
  })
})

describe('isMembershipViolation', () => {
  it('词表外的值 (不论哪一列) 与类别不符算成员违规, 其余都不算', () => {
    const verdicts = (
      [
        { kind: 'unknown-value', field: 'section', values: ['tool'] },
        { kind: 'unknown-value', field: 'type', values: ['pc'] },
        { kind: 'unknown-value', field: 'language', values: ['chinese'] },
        { kind: 'unknown-value', field: 'platform', values: ['android'] },
        { kind: 'unknown-value', field: 'emulatorType', values: ['gaishi'] },
        { kind: 'section-type', values: ['manual'] },
        { kind: 'empty', field: 'type' },
        { kind: 'empty', field: 'language' },
        { kind: 'empty', field: 'platform' },
        { kind: 'emulator-type-required' },
        { kind: 'model-name-required' },
        { kind: 'emulator-type-orphan' },
        { kind: 'model-name-orphan' }
      ] satisfies TaxonomyViolation[]
    ).map(isMembershipViolation)

    expect(verdicts).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      false
    ])
  })
})

// 核查以 0 违规为收尾判据, 前提是应用自己写不出违规的行: 校验放行的输入, 判据最多只报
// 孤儿值 (create / update 落库前会清掉); 校验拦下的输入, 判据一定报了别的。
// 后一半只在不触及条数与长度上限时成立 (见上面「不管条数上限」), 下面这组输入都不触及。
// 词表变更的过渡期让校验放行旧值时, 这条用例要跟着改成「放行的输入里, 判据报的成员违规
// 只能是过渡中的旧值」
describe('判据与资源校验对同一份输入的结论一致', () => {
  const sections = ['galgame', 'patch', 'tool', 'constructor']
  const types = [
    [],
    ['game'],
    ['manual'],
    ['ai'],
    ['other'],
    ['game', 'manual'],
    ['ai', 'pc'],
    ['patch']
  ]
  const languages = [['zh-Hans'], [], ['chinese']]
  const platforms = [
    [],
    ['windows'],
    ['emulator'],
    ['android'],
    ['windows', 'emulator']
  ]
  const emulatorTypes = [[], ['joiplay'], ['winlator']]
  const modelNames = ['', '   ', 'GPT-4o']

  const rows: ResourceTaxonomyRow[] = sections.flatMap((section) =>
    types.flatMap((type) =>
      languages.flatMap((language) =>
        platforms.flatMap((platform) =>
          emulatorTypes.flatMap((emulatorType) =>
            modelNames.map((modelName) => ({
              section,
              type,
              language,
              platform,
              emulatorType,
              modelName
            }))
          )
        )
      )
    )
  )

  it('校验放行 ⟺ 判据除孤儿值外没有违规', () => {
    const disagreements = rows.filter((row) => {
      const accepted = patchResourceCreateSchema.safeParse({
        ...acceptedRest,
        ...row
      }).success
      const onlyOrphans = findTaxonomyViolations(row).every(
        (violation) =>
          violation.kind === 'emulator-type-orphan' ||
          violation.kind === 'model-name-orphan'
      )
      return accepted !== onlyOrphans
    })

    expect(rows).toHaveLength(4320)
    expect(disagreements).toEqual([])
  })
})
