import type { RecordingTransaction } from '~/server/db/__tests__/recordingTransaction'

// 资源删除命令及其入口的测试共用的夹具: 给记录型事务喂「行锁下读到的资源行」

export const resourceLink = (id: number, storage: string) => ({
  id,
  storage,
  content: `c-${id}`,
  password: 'pw',
  code: 'code',
  hash: `h-${id}`,
  s3_key: storage === 's3' ? `k-${id}` : ''
})

export const resourceRow = (
  id: number,
  overrides: Record<string, unknown> = {}
) => ({
  id,
  name: `resource-${id}`,
  user_id: 7,
  patch_id: 10,
  status: 0,
  section: 'patch',
  links: [resourceLink(id * 10, 's3'), resourceLink(id * 10 + 1, 'user')],
  ...overrides
})

export type ResourceRowFixture = ReturnType<typeof resourceRow>

// rows: 锁下读到的资源行 (含链接)。commentedIds: 其中带评论的, 评论派生物清理只对它们
// 发语句。补丁的 unique_id 与名字分别是 patch-<id> 与 name-<id>
export const seedResourceRemoval = (
  rec: RecordingTransaction,
  rows: ResourceRowFixture[],
  commentedIds: number[] = []
) => {
  rec.onRaw(/^SELECT id FROM patch_resource .* FOR UPDATE$/, () =>
    rows.map((item) => ({ id: item.id }))
  )
  rec.on(
    'patch_resource.findMany',
    (args: { where: Record<string, unknown> }) => {
      // 带 comment 条件的是 cleanupResourceCommentDerivatives
      if ('comment' in args.where) {
        return rows
          .filter((item) => commentedIds.includes(item.id))
          .map((item) => ({
            id: item.id,
            patch: { unique_id: `patch-${item.patch_id}` },
            comment: [{ id: item.id * 100 }]
          }))
      }
      // 带 status 条件的是 recalcPatchType 读公开资源
      if ('status' in args.where) {
        return []
      }
      return rows
    }
  )
  rec.on('patch.update', (args: { where: { id: number } }) => ({
    unique_id: `patch-${args.where.id}`
  }))
  rec.on('patch.findMany', (args: { where: { id: { in: number[] } } }) =>
    args.where.id.in.map((id) => ({ id, name: `name-${id}` }))
  )
}

// 通告锁与出箱的原生语句只看前缀, 取锁语句缩成一个词
export const shortResourceLabels = (rec: RecordingTransaction) =>
  rec
    .labels()
    .map((label) =>
      label.includes('FROM "user"')
        ? 'lock user'
        : label.includes('FROM patch_resource') && label.includes('FOR UPDATE')
          ? 'lock resource'
          : label.includes('pg_advisory_xact_lock')
            ? 'recalc.lock'
            : label.includes('INSERT INTO search_outbox')
              ? 'search_outbox.enqueue'
              : label
    )
