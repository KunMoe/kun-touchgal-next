import { beforeEach, describe, expect, it, vi } from 'vitest'

const rec = await vi.hoisted(async () =>
  (
    await import('~/server/db/__tests__/recordingTransaction')
  ).recordingTransaction()
)

vi.mock('~/prisma/index', () => rec.module)

import { kunTx } from '~/server/db/tx'
import { isPrismaTransactionConflict } from '~/server/db/txErrors'

const deadlock = {
  code: 'P2010',
  meta: {
    driverAdapterError: { cause: { kind: 'postgres', originalCode: '40P01' } }
  }
}

beforeEach(() => {
  rec.reset()
  vi.restoreAllMocks()
})

describe('kunTx 提交与回滚', () => {
  it('回调正常返回时提交, 并把返回值交给调用方', async () => {
    const result = await kunTx('probe', async ({ tx }) => {
      await tx.admin_log.create({ data: { type: 'x' } } as never)
      return { id: 7 }
    })

    expect(result).toEqual({ id: 7 })
    expect(rec.attempts).toHaveLength(1)
    expect(rec.attempts[0].committed).toBe(true)
    expect(rec.labels()).toEqual(['admin_log.create'])
  })

  it('fail 回滚事务并以消息作为结果', async () => {
    const result = await kunTx('probe', async ({ tx, fail }) => {
      await tx.user.update({ where: { id: 1 }, data: {} } as never)
      fail('未找到对应的资源')
    })

    expect(result).toBe('未找到对应的资源')
    expect(rec.attempts[0].committed).toBe(false)
    expect(rec.attempts[0].rolledBack).toBe(true)
  })

  // 回调里包了一层 try/catch 的写法很常见; 中止被吞掉后若照常提交, 就回到了
  // 「先行的写入随失败一起提交」的老问题
  it('fail 抛出的中止被回调内的 catch 吞掉后仍然回滚', async () => {
    const result = await kunTx('probe', async ({ tx, fail }) => {
      await tx.user.update({ where: { id: 1 }, data: {} } as never)
      try {
        fail('该资源正在审核中, 暂时无法删除')
      } catch {
        // 吞掉
      }
      return { ok: true }
    })

    expect(result).toBe('该资源正在审核中, 暂时无法删除')
    expect(rec.attempts[0].committed).toBe(false)
    expect(rec.attempts[0].rolledBack).toBe(true)
  })

  it('回调抛出的其他异常原样抛给调用方, 事务回滚', async () => {
    const boom = new Error('boom')

    await expect(
      kunTx('probe', async () => {
        throw boom
      })
    ).rejects.toBe(boom)
    expect(rec.attempts[0].rolledBack).toBe(true)
  })

  it('fail 抛出的中止不会被当成事务冲突', async () => {
    let captured: unknown
    await kunTx(
      'probe',
      async ({ fail }) => {
        try {
          fail('x')
        } catch (error) {
          captured = error
          throw error
        }
      },
      { retry: 2 }
    )

    expect(isPrismaTransactionConflict(captured)).toBe(false)
    expect(rec.attempts).toHaveLength(1)
  })
})

// 这一组在 pnpm typecheck 里生效: 每个 @ts-expect-error 下面的写法必须编译不过。
// prisma.$transaction 的回调 return 字符串等于提交, kunTx 又会把它当失败返回给调用方
describe('kunTx 回调的返回类型', () => {
  it('返回字符串的回调编译不过, 没有值可返回的回调不 return', async () => {
    const failed = Math.random() > 2

    // @ts-expect-error 纯字符串
    await kunTx('probe', async () => '错误')
    // @ts-expect-error 模板字符串
    await kunTx('probe', async () => `错误 ${failed}`)
    // @ts-expect-error 字符串与非空对象混用
    await kunTx('probe', async () => {
      if (failed) {
        return '错误'
      }
      return { count: 1 }
    })
    // 最容易写出来的一种: 成功 return {}、失败顺手 return 字符串。字符串能赋给 {},
    // 二者的联合会被约简成 {}, 所以连单独的 {} 也不接受
    // @ts-expect-error 字符串与 {} 混用
    await kunTx('probe', async () => {
      if (failed) {
        return '错误'
      }
      return {}
    })
    // @ts-expect-error 单独的 {}
    await kunTx('probe', async () => ({}))
    // @ts-expect-error 字符串与不返回混用
    await kunTx('probe', async () => {
      if (failed) {
        return '错误'
      }
    })
    // @ts-expect-error any
    await kunTx('probe', async () => JSON.parse('1'))

    // 正常写法: 失败走 fail, 成功不返回或返回具体的对象
    const none = await kunTx('probe', async ({ fail }) => {
      if (failed) {
        fail('错误')
      }
    })
    const some = await kunTx('probe', async () => ({ count: 1 }))

    expect(none ?? {}).toEqual({})
    expect(typeof some === 'string' ? 0 : some.count).toBe(1)
  })
})

describe('kunTx 提交后副作用', () => {
  it('提交之后才执行, 按登记顺序逐个 await', async () => {
    const order: string[] = []
    await kunTx('probe', async ({ afterCommit }) => {
      afterCommit('a', async () => {
        await Promise.resolve()
        order.push(`a:${rec.attempts[0].committed}`)
      })
      afterCommit('b', () => {
        order.push('b')
      })
      order.push('body')
    })

    expect(order).toEqual(['body', 'a:true', 'b'])
  })

  it('同一 key 只执行一次, 保留先登记的那个', async () => {
    const calls: string[] = []
    await kunTx('probe', async ({ afterCommit }) => {
      afterCommit('cache:1', () => calls.push('first'))
      afterCommit('cache:1', () => calls.push('second'))
    })

    expect(calls).toEqual(['first'])
  })

  it('某一项失败只记日志, 其余照常执行, 结果不变', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const calls: string[] = []
    const failure = new Error('redis down')

    const result = await kunTx('comment.remove', async ({ afterCommit }) => {
      afterCommit('first', () => {
        throw failure
      })
      afterCommit('second', () => calls.push('second'))
      return { ok: true }
    })

    expect(result).toEqual({ ok: true })
    expect(calls).toEqual(['second'])
    expect(errorSpy).toHaveBeenCalledWith(
      '[kunTx:comment.remove] first',
      failure
    )
  })

  it('fail 回滚后不执行已登记的副作用', async () => {
    const effect = vi.fn()
    await kunTx('probe', async ({ afterCommit, fail }) => {
      afterCommit('cache', effect)
      fail('不行')
    })

    expect(effect).not.toHaveBeenCalled()
  })

  it('回调抛异常时不执行已登记的副作用', async () => {
    const effect = vi.fn()
    await expect(
      kunTx('probe', async ({ afterCommit }) => {
        afterCommit('cache', effect)
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')

    expect(effect).not.toHaveBeenCalled()
  })
})

describe('kunTx 冲突重试', () => {
  it.each([
    ['P2034', { code: 'P2034' }],
    ['原生语句的 40P01', deadlock]
  ])('%s 在 retry 额度内重放', async (_name, conflict) => {
    let calls = 0
    const result = await kunTx(
      'probe',
      async () => {
        calls++
        if (calls === 1) {
          throw conflict
        }
        return { calls }
      },
      { retry: 2 }
    )

    expect(result).toEqual({ calls: 2 })
    expect(rec.attempts.map((attempt) => attempt.committed)).toEqual([
      false,
      true
    ])
  })

  // 重试会整段重放回调; 上一轮登记的副作用若留在队列里, 提交后会被多执行一遍
  it('被回滚的尝试登记的副作用不带到下一轮', async () => {
    const stale = vi.fn()
    const fresh = vi.fn()
    let calls = 0

    await kunTx(
      'probe',
      async ({ afterCommit }) => {
        calls++
        if (calls === 1) {
          afterCommit('stale', stale)
          throw deadlock
        }
        afterCommit('fresh', fresh)
      },
      { retry: 1 }
    )

    expect(stale).not.toHaveBeenCalled()
    expect(fresh).toHaveBeenCalledTimes(1)
  })

  it('默认不重试', async () => {
    await expect(
      kunTx('probe', async () => {
        throw deadlock
      })
    ).rejects.toBe(deadlock)
    expect(rec.attempts).toHaveLength(1)
  })

  it('额度用尽后抛出最后一次的冲突', async () => {
    await expect(
      kunTx(
        'probe',
        async () => {
          throw deadlock
        },
        { retry: 2 }
      )
    ).rejects.toBe(deadlock)
    expect(rec.attempts).toHaveLength(3)
  })

  it.each([
    ['P2002', { code: 'P2002' }],
    ['P2028', { code: 'P2028' }]
  ])('%s 不重试', async (_name, error) => {
    await expect(
      kunTx(
        'probe',
        async () => {
          throw error
        },
        { retry: 2 }
      )
    ).rejects.toBe(error)
    expect(rec.attempts).toHaveLength(1)
  })
})

describe('kunTx 事务选项', () => {
  it('没给选项时只向 $transaction 传回调', async () => {
    await kunTx('probe', async () => {})

    expect(rec.attempts[0].options).toBeUndefined()
  })

  it('只给 retry 时同样只传回调', async () => {
    await kunTx('probe', async () => {}, { retry: 2 })

    expect(rec.attempts[0].options).toBeUndefined()
  })

  it('timeout / maxWait / isolationLevel 原样透传, 不带 retry', async () => {
    await kunTx('probe', async () => {}, {
      retry: 2,
      timeout: 60000,
      isolationLevel: 'Serializable'
    })

    expect(rec.attempts[0].options).toEqual({
      timeout: 60000,
      isolationLevel: 'Serializable'
    })
  })
})

describe('recordingTransaction', () => {
  it('没配置的读取直接抛错, 不默认回空', async () => {
    await expect(
      kunTx('probe', async ({ tx }) => {
        await tx.patch_comment.findMany({ where: { id: 1 } })
      })
    ).rejects.toThrow('未配置读取 patch_comment.findMany')

    await expect(
      kunTx('probe', async ({ tx }) => {
        await tx.$queryRaw`SELECT id FROM patch_comment WHERE id = ${1} FOR UPDATE`
      })
    ).rejects.toThrow('未配置查询 SELECT id FROM patch_comment')
  })

  it('原生 SQL 展平内嵌片段, 记录取锁语句与参数', async () => {
    const { Prisma } = await import('~/prisma/generated/prisma/client')
    rec.onRaw(/FROM patch_rating/, [{ id: 3 }, { id: 5 }])

    const rows = await kunTx(
      'probe',
      async ({ tx }) =>
        tx.$queryRaw<{ id: number }[]>`
        SELECT id FROM patch_rating
        WHERE id IN (${Prisma.join([5, 3])})
        ORDER BY id
        FOR UPDATE
      `
    )

    expect(rows).toEqual([{ id: 3 }, { id: 5 }])
    expect(rec.labels()).toEqual([
      '$queryRaw: SELECT id FROM patch_rating WHERE id IN (?,?) ORDER BY id FOR UPDATE'
    ])
    expect(rec.argsOf(rec.labels()[0])).toEqual([[5, 3]])
  })

  it('事务之外的调用单独记录', async () => {
    rec.on('user.findUnique', { id: 1, name: 'admin' })
    const { prisma } = rec.module as { prisma: any }

    expect(await prisma.user.findUnique({ where: { id: 1 } })).toEqual({
      id: 1,
      name: 'admin'
    })
    expect(rec.outside.map((item) => item.label)).toEqual(['user.findUnique'])
    expect(rec.attempts).toHaveLength(0)
  })
})
