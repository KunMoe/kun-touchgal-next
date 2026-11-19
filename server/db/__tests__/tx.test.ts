import { beforeEach, describe, expect, it, vi } from 'vitest'

const rec = await vi.hoisted(async () =>
  (
    await import('~/server/db/__tests__/recordingTransaction')
  ).recordingTransaction()
)

vi.mock('~/prisma/index', () => rec.module)

import { Prisma } from '~/prisma/generated/prisma/client'
import { kunTx } from '~/server/db/tx'
import { isPrismaTransactionConflict } from '~/server/db/txErrors'

const deadlock = {
  code: 'P2010',
  meta: {
    driverAdapterError: { cause: { kind: 'postgres', originalCode: '40P01' } }
  }
}

const violation = (code: string) =>
  new Prisma.PrismaClientKnownRequestError(`violation ${code}`, {
    code,
    clientVersion: 'test'
  })

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

  // TS 允许返回类型为 void 的函数实际返回任意值, 这样绕过去的字符串类型层面拦不住
  it('回调在运行期返回了字符串时回滚并抛错, 不把它当成结果提交', async () => {
    const helper: () => void = () => '萌萌点不足'

    await expect(
      kunTx('probe', async ({ tx }) => {
        await tx.user.update({ where: { id: 1 }, data: {} } as never)
        return helper()
      })
    ).rejects.toThrow('[kunTx:probe] 回调返回了字符串')
    expect(rec.attempts[0].committed).toBe(false)
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

    // 这两种写法运行起来真的会返回字符串: 类型报错之外, 运行期的兜底也会拦下
    // @ts-expect-error 纯字符串
    await expect(kunTx('probe', async () => '错误')).rejects.toThrow(TypeError)
    await expect(
      // @ts-expect-error 模板字符串
      kunTx('probe', async () => `错误 ${failed}`)
    ).rejects.toThrow(TypeError)
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

  it('commitWith 的结果可以与成功值混着返回, 调用方拿到的类型里没有它', async () => {
    const failed = Math.random() > 2

    await expect(
      // @ts-expect-error 有了 commitWith 也不能顺手 return 字符串
      kunTx('probe', async ({ commitWith }) => {
        if (failed) {
          return commitWith('错误')
        }
        return '另一个错误'
      })
    ).rejects.toThrow(TypeError)

    const mixed = await kunTx('probe', async ({ commitWith }) => {
      if (failed) {
        return commitWith('错误')
      }
      return { count: 1 }
    })
    const bare = await kunTx('probe', async ({ commitWith }) => {
      if (failed) {
        return commitWith('错误')
      }
    })

    // 收窄掉 string 之后直接读成功值的字段: 结果类型里若还留着 KunCommittedFailure, 这里编译不过
    expect(typeof mixed === 'string' ? 0 : mixed.count).toBe(1)
    expect(bare ?? {}).toEqual({})
  })
})

describe('kunTx 失败但提交', () => {
  it('commitWith 提交事务, 执行提交后副作用, 以消息作为结果', async () => {
    const committed = vi.fn()
    const rolledBack = vi.fn()

    const result = await kunTx(
      'probe',
      async ({ tx, commitWith, afterCommit, onRollback }) => {
        await tx.s3_deletion_outbox.createMany({ data: [] } as never)
        afterCommit('cache', committed)
        onRollback('cleanup', rolledBack)
        return commitWith('该资源的链接已被修改, 请刷新后重试')
      },
      { onRollback: rolledBack }
    )

    expect(result).toBe('该资源的链接已被修改, 请刷新后重试')
    expect(rec.attempts[0].committed).toBe(true)
    expect(rec.labels()).toEqual(['s3_deletion_outbox.createMany'])
    expect(committed).toHaveBeenCalledTimes(1)
    expect(rolledBack).not.toHaveBeenCalled()
  })

  it('只调用不 return 的 commitWith 不改变结果', async () => {
    const result = await kunTx('probe', async ({ commitWith }) => {
      commitWith('没有被返回')
      return { ok: true }
    })

    expect(result).toEqual({ ok: true })
  })

  it('fail 被吞掉后再 return commitWith 仍然回滚', async () => {
    const result = await kunTx('probe', async ({ fail, commitWith }) => {
      try {
        fail('必须回滚')
      } catch {
        // 吞掉
      }
      return commitWith('想要提交')
    })

    expect(result).toBe('必须回滚')
    expect(rec.attempts[0].rolledBack).toBe(true)
  })
})

describe('kunTx 没有提交时的清理', () => {
  it('fail 回滚后执行, 回调里登记的与选项里给的各一次', async () => {
    const order: string[] = []

    const result = await kunTx(
      'probe',
      async ({ fail, onRollback }) => {
        onRollback('banner', () => {
          order.push(`banner:${rec.attempts[0].rolledBack}`)
        })
        fail('不行')
      },
      { onRollback: () => order.push('bound') }
    )

    expect(result).toBe('不行')
    expect(order).toEqual(['bound', 'banner:true'])
  })

  it('回调抛异常时先清理再把原异常抛给调用方', async () => {
    const boom = new Error('boom')
    const cleanup = vi.fn()

    await expect(
      kunTx(
        'probe',
        async ({ onRollback }) => {
          onRollback('banner', cleanup)
          throw boom
        },
        { onRollback: cleanup }
      )
    ).rejects.toBe(boom)

    expect(cleanup).toHaveBeenCalledTimes(2)
  })

  it('提交成功时不执行', async () => {
    const cleanup = vi.fn()

    await kunTx(
      'probe',
      async ({ onRollback }) => {
        onRollback('banner', cleanup)
      },
      { onRollback: cleanup }
    )

    expect(cleanup).not.toHaveBeenCalled()
  })

  it('同一 key 只执行一次, 保留先登记的那个', async () => {
    const calls: string[] = []

    await kunTx('probe', async ({ fail, onRollback }) => {
      onRollback('banner', () => calls.push('first'))
      onRollback('banner', () => calls.push('second'))
      fail('不行')
    })

    expect(calls).toEqual(['first'])
  })

  // 事务前就已绑定的对象靠选项里的清理兜底: 拿不到连接时回调根本没有执行,
  // 回调里登记的清理无从谈起
  it('事务没开起来 (回调未执行) 时, 选项里给的清理照样执行', async () => {
    const startTimeout = { code: 'P2028' }
    const cleanup = vi.fn()
    const body = vi.fn(async () => {})
    rec.failNextBegin(startTimeout)

    await expect(kunTx('probe', body, { onRollback: cleanup })).rejects.toBe(
      startTimeout
    )

    expect(body).not.toHaveBeenCalled()
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  // commit 抛错时库里可能已经提交, 也可能没有: 按没有提交处理, 清理自己要能分辨
  it('commit 抛错 (结果不确定) 按没有提交处理: 执行清理, 不执行提交后副作用', async () => {
    const commitFailure = new Error('connection lost during commit')
    const committed = vi.fn()
    const cleanup = vi.fn()
    rec.failNextCommit(commitFailure)

    await expect(
      kunTx('probe', async ({ afterCommit, onRollback }) => {
        afterCommit('cache', committed)
        onRollback('banner', cleanup)
      })
    ).rejects.toBe(commitFailure)

    expect(committed).not.toHaveBeenCalled()
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('某一项清理失败只记日志, 其余照常执行, 不遮住原来的结果', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const boom = new Error('boom')
    const s3Down = new Error('s3 down')
    const redisDown = new Error('redis down')
    const calls: string[] = []

    await expect(
      kunTx(
        'edit.create',
        async ({ onRollback }) => {
          onRollback('banner', () => {
            throw s3Down
          })
          onRollback('token', () => calls.push('token'))
          throw boom
        },
        {
          onRollback: () => {
            throw redisDown
          }
        }
      )
    ).rejects.toBe(boom)

    expect(calls).toEqual(['token'])
    expect(errorSpy.mock.calls).toEqual([
      ['[kunTx:edit.create] onRollback', redisDown],
      ['[kunTx:edit.create] onRollback:banner', s3Down]
    ])
  })
})

describe('kunTx 违例文案', () => {
  it.each(['P2002', 'P2003', 'P2025'] as const)(
    '%s 在表里时回滚并以对应文案作为结果',
    async (code) => {
      const committed = vi.fn()
      const cleanup = vi.fn()

      const result = await kunTx(
        'probe',
        async ({ tx, afterCommit, onRollback }) => {
          afterCommit('cache', committed)
          onRollback('banner', cleanup)
          await tx.user.update({ where: { id: 1 }, data: {} } as never)
          throw violation(code)
        },
        { violations: { [code]: `撞了 ${code}` } }
      )

      expect(result).toBe(`撞了 ${code}`)
      expect(rec.attempts[0].rolledBack).toBe(true)
      expect(committed).not.toHaveBeenCalled()
      expect(cleanup).toHaveBeenCalledTimes(1)
    }
  )

  it('表里没有的违例原样抛出', async () => {
    const error = violation('P2003')

    await expect(
      kunTx(
        'probe',
        async () => {
          throw error
        },
        { violations: { P2002: '已存在' } }
      )
    ).rejects.toBe(error)
  })

  it('没有 violations 时不翻译', async () => {
    const error = violation('P2002')

    await expect(
      kunTx('probe', async () => {
        throw error
      })
    ).rejects.toBe(error)
  })

  // 与 kunRoute 的兜底同一份判据: 只认 Prisma 已知错误, 不认碰巧带同名 code 的别的异常
  it('不是 Prisma 已知错误的异常不翻译, 只看类型不看 code 字段', async () => {
    const error = Object.assign(new Error('fk'), { code: 'P2003' })

    await expect(
      kunTx(
        'probe',
        async () => {
          throw error
        },
        { violations: { P2003: '未找到 Galgame' } }
      )
    ).rejects.toBe(error)
  })

  it('违例不重试', async () => {
    const result = await kunTx(
      'probe',
      async () => {
        throw violation('P2002')
      },
      { retry: 2, violations: { P2002: '已存在' } }
    )

    expect(result).toBe('已存在')
    expect(rec.attempts).toHaveLength(1)
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

  // 清理的是「最终没有提交」留下的东西: 中途的重放不能触发, 否则下一轮提交的行
  // 会引用已被清掉的对象
  it('被重放的尝试不触发清理, 最终提交则一次都不执行', async () => {
    const cleanup = vi.fn()
    let calls = 0

    const result = await kunTx(
      'probe',
      async ({ onRollback }) => {
        calls++
        onRollback('banner', cleanup)
        if (calls === 1) {
          throw deadlock
        }
        return { calls }
      },
      { retry: 1, onRollback: cleanup }
    )

    expect(result).toEqual({ calls: 2 })
    expect(cleanup).not.toHaveBeenCalled()
  })

  it('重试耗尽后清理只执行一次, 各次尝试登记的都算数', async () => {
    const calls: string[] = []
    let attempt = 0

    await expect(
      kunTx(
        'probe',
        async ({ onRollback }) => {
          const label = `attempt:${++attempt}`
          onRollback('shared', () => calls.push('shared'))
          onRollback(label, () => calls.push(label))
          throw deadlock
        },
        { retry: 1, onRollback: () => calls.push('bound') }
      )
    ).rejects.toBe(deadlock)

    expect(rec.attempts).toHaveLength(2)
    expect(calls).toEqual(['bound', 'shared', 'attempt:1', 'attempt:2'])
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

  it('只给 violations / onRollback 时同样只传回调', async () => {
    await kunTx('probe', async () => {}, {
      violations: { P2002: '已存在' },
      onRollback: () => {}
    })

    expect(rec.attempts[0].options).toBeUndefined()
  })

  it('timeout / maxWait / isolationLevel 原样透传, 不带执行器自己的选项', async () => {
    await kunTx('probe', async () => {}, {
      retry: 2,
      violations: { P2002: '已存在' },
      onRollback: () => {},
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
