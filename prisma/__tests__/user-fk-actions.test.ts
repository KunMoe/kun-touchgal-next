import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { USER_REFERENCES } from '~/server/account/userReferences'
import type { UserReferenceAction } from '~/server/account/userReferences'

// 指向 user 的外键与账号删除语义表 (server/account/userReferences.ts) 一一对应: 新增外键
// 必须先在表里归类, 表里归了类的外键 onDelete 必须与归类相符。读的是 schema 文本, 与库里
// 实际约束的一致由迁移回放 (CI 的 db-replay) 兜底
const schemaDir = fileURLToPath(new URL('../schema/', import.meta.url))

const userForeignKeys = readdirSync(schemaDir)
  .filter((file) => file.endsWith('.prisma'))
  .flatMap((file) => [
    ...readFileSync(`${schemaDir}${file}`, 'utf8').matchAll(
      /^model (\w+) \{([\s\S]*?)^\}/gm
    )
  ])
  .flatMap(([, model, body]) =>
    [
      ...body.matchAll(
        /^\s*\w+\s+user(\??)\s+@relation\(([^)]*fields: \[(\w+)\][^)]*)\)/gm
      )
    ].map(([, optionalRelation, args, column]) => ({
      name: `${model}.${column}`,
      onDelete: /onDelete: (\w+)/.exec(args)?.[1] ?? '(default)',
      relationOptional: optionalRelation === '?',
      columnOptional: new RegExp(`^\\s*${column}\\s+Int\\?`, 'm').test(body)
    }))
  )

const expectedOnDelete: Record<UserReferenceAction, string> = {
  cascade: 'Cascade',
  'set-null': 'SetNull',
  // C 片 (改 NoAction, 收尾把 P2003 当作未清完) 落地之前, purge 外键仍是 Cascade:
  // 清除器漏掉的行由库兜底删掉, 而不是让删号 500
  purge: 'Cascade'
}

describe('user 外键与账号删除语义表', () => {
  it('schema 里的 user 外键与语义表的键双向相等', () => {
    expect(userForeignKeys.map((fk) => fk.name).sort()).toEqual(
      Object.keys(USER_REFERENCES).sort()
    )
  })

  it.each(userForeignKeys)('$name', (fk) => {
    const action: UserReferenceAction =
      USER_REFERENCES[fk.name as keyof typeof USER_REFERENCES]
    expect(fk.onDelete).toBe(expectedOnDelete[action])
    // 断开归属要求外键列可空; 反过来不要求, user_message 的两列本来就可空
    if (action === 'set-null') {
      expect(fk.relationOptional).toBe(true)
      expect(fk.columnOptional).toBe(true)
    }
  })
})
