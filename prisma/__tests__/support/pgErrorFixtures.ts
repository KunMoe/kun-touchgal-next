import type { PgErrorFields } from '~/prisma/__tests__/support/sqlRecorder'

// PostgreSQL 报错时驱动抛出的字段集, 供录制客户端回放, 好让 adapter 的错误映射在不连库时跑起来。
// 取自 PostgreSQL 17.11 上的真实违例 (与生产同主版本), 去掉了随构建变化的 file / line /
// routine / length。prisma/__tests__/pgErrorFixtures.db.test.ts 在真库上重新造出这些违例,
// 逐字段与这里比对 —— 手写的夹具没有东西对照, 就会像旧的 kind: 'postgres' 那样悄悄过期
export const pgErrors = {
  // UPDATE "user" SET name = … 撞上别人的名字
  uniqueViolation: {
    severity: 'ERROR',
    code: '23505',
    message: 'duplicate key value violates unique constraint "user_name_key"',
    detail: 'Key (name)=(kun) already exists.',
    schema: 'public',
    table: 'user',
    constraint: 'user_name_key'
  },
  // 同一对用户的第二个会话
  uniqueViolationComposite: {
    severity: 'ERROR',
    code: '23505',
    message:
      'duplicate key value violates unique constraint "user_conversation_user_a_id_user_b_id_key"',
    detail: 'Key (user_a_id, user_b_id)=(1, 2) already exists.',
    schema: 'public',
    table: 'user_conversation',
    constraint: 'user_conversation_user_a_id_user_b_id_key'
  },
  // 会话的另一方不存在。注意没有 column 字段: 外键违例只报约束名
  foreignKeyViolation: {
    severity: 'ERROR',
    code: '23503',
    message:
      'insert or update on table "user_conversation" violates foreign key constraint "user_conversation_user_b_id_fkey"',
    detail: 'Key (user_b_id)=(2147480000) is not present in table "user".',
    schema: 'public',
    table: 'user_conversation',
    constraint: 'user_conversation_user_b_id_fkey'
  },
  // 给 int4 列绑了一个越界的参数
  valueOutOfRange: {
    severity: 'ERROR',
    code: '22003',
    message: 'value "2147483648" is out of range for type integer',
    where: "unnamed portal parameter $1 = '...'"
  },
  deadlockDetected: {
    severity: 'ERROR',
    code: '40P01',
    message: 'deadlock detected',
    detail:
      'Process 134 waits for ShareLock on transaction 772; blocked by process 135.\nProcess 135 waits for ShareLock on transaction 771; blocked by process 134.',
    hint: 'See server log for query details.',
    where: 'while updating tuple (0,2) in relation "user"'
  },
  // REPEATABLE READ 下更新已被并发事务改过的行
  serializationFailure: {
    severity: 'ERROR',
    code: '40001',
    message: 'could not serialize access due to concurrent update'
  }
} satisfies Record<string, PgErrorFields>
