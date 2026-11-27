import {
  RESOURCE_SECTION_TYPE_MAP,
  SUPPORTED_EMULATOR_TYPE,
  SUPPORTED_LANGUAGE,
  SUPPORTED_PLATFORM,
  SUPPORTED_RESOURCE_SECTION,
  SUPPORTED_TYPE
} from '~/constants/resource'

// 资源分类 (类别 / 类型 / 语言 / 平台 / 模拟器类型 / 模型型号) 的唯一违规判据。
// 接口与表单的校验 (validations/patch.ts) 和全表核查 (scripts/verifyResourceTaxonomy.ts)
// 都从这里读, 「接口收下的」与「核查认为干净的」因此是同一套规则。
// 纯函数, 只依赖 constants/resource, 客户端也能用

export interface ResourceTaxonomyRow {
  section: string
  type: readonly string[]
  language: readonly string[]
  platform: readonly string[]
  emulatorType: readonly string[]
  modelName: string
}

export type TaxonomyViolation =
  // 值不在词表里
  | {
      kind: 'unknown-value'
      field: 'section' | 'type' | 'language' | 'platform' | 'emulatorType'
      values: string[]
    }
  | { kind: 'empty'; field: 'type' | 'language' | 'platform' }
  // 类型不属于所在类别。词表外的类型在任何类别下都不被允许, 所以也列在这里
  | { kind: 'section-type'; values: string[] }
  // 平台含模拟器却没有模拟器类型 / 类型含 AI 补丁却没有模型型号
  | { kind: 'emulator-type-required' }
  | { kind: 'model-name-required' }
  // 平台不含模拟器却留着模拟器类型 / 类型不含 AI 补丁却留着模型型号
  | { kind: 'emulator-type-orphan' }
  | { kind: 'model-name-orphan' }

const outside = (values: readonly string[], vocabulary: readonly string[]) => [
  ...new Set(values.filter((value) => !vocabulary.includes(value)))
]

const VOCABULARY_FIELDS = [
  ['type', SUPPORTED_TYPE],
  ['language', SUPPORTED_LANGUAGE],
  ['platform', SUPPORTED_PLATFORM],
  ['emulatorType', SUPPORTED_EMULATOR_TYPE]
] as const

const REQUIRED_FIELDS = ['type', 'language', 'platform'] as const

// 违规按固定顺序给出: 词表外的值、空数组、类别与类型的联动、两条联动必填、两条孤儿值。
// 校验把其中三类原样转成报错, 报错的先后取自这里
export const findTaxonomyViolations = (
  row: ResourceTaxonomyRow
): TaxonomyViolation[] => {
  const violations: TaxonomyViolation[] = []

  if (!SUPPORTED_RESOURCE_SECTION.includes(row.section)) {
    violations.push({
      kind: 'unknown-value',
      field: 'section',
      values: [row.section]
    })
  }
  for (const [field, vocabulary] of VOCABULARY_FIELDS) {
    const values = outside(row[field], vocabulary)
    if (values.length > 0) {
      violations.push({ kind: 'unknown-value', field, values })
    }
  }

  for (const field of REQUIRED_FIELDS) {
    if (row[field].length === 0) {
      violations.push({ kind: 'empty', field })
    }
  }

  // 只认表自己的键: section 来自请求体, 'constructor' 之类会命中原型链上的成员
  if (Object.hasOwn(RESOURCE_SECTION_TYPE_MAP, row.section)) {
    const values = outside(row.type, RESOURCE_SECTION_TYPE_MAP[row.section])
    if (values.length > 0) {
      violations.push({ kind: 'section-type', values })
    }
  }

  const hasEmulator = row.platform.includes('emulator')
  const hasAi = row.type.includes('ai')
  if (hasEmulator && row.emulatorType.length === 0) {
    violations.push({ kind: 'emulator-type-required' })
  }
  if (hasAi && row.modelName.trim() === '') {
    violations.push({ kind: 'model-name-required' })
  }
  if (!hasEmulator && row.emulatorType.length > 0) {
    violations.push({ kind: 'emulator-type-orphan' })
  }
  if (!hasAi && row.modelName !== '') {
    violations.push({ kind: 'model-name-orphan' })
  }

  return violations
}

// 词表变更是否收尾只看这两类: 它们只能来自还没迁移的旧值 (或绕过校验的写入)。
// 其余几类是行自身不完整 (空数组、缺联动字段、留着孤儿值), 怎么补要逐条裁定,
// 核查里单列、不拦收尾
export const isMembershipViolation = (violation: TaxonomyViolation) =>
  violation.kind === 'unknown-value' || violation.kind === 'section-type'
