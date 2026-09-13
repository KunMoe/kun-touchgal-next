import { NextRequest, NextResponse } from 'next/server'
import { kunParseDeleteQuery } from '~/app/api/utils/parseQuery'
import { prisma } from '~/prisma/index'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { clearReadMessageSchema } from '~/validations/message'
import { getUnreadMessageStatus } from '../unread/service'
import { invalidateUnread } from '~/app/api/message/unread/cache'

const MESSAGE_BATCH_SIZE = 5000

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

const isDeadlockError = (error: unknown) =>
  error instanceof Error && error.message.includes('deadlock detected')

const withDeadlockRetry = async <T>(
  action: () => Promise<T>,
  maxRetries = 2
): Promise<T> => {
  let attempt = 0

  while (true) {
    try {
      return await action()
    } catch (error) {
      if (!isDeadlockError(error) || attempt >= maxRetries) {
        throw error
      }

      attempt += 1
      await sleep(100 * attempt)
    }
  }
}

const processMessageInBatches = async (handler: () => Promise<number>) => {
  while (true) {
    const affectedCount = await withDeadlockRetry(handler)

    if (!affectedCount) {
      return
    }
  }
}

const readMessage = async (uid: number) => {
  await processMessageInBatches(async () => {
    const result = await prisma.$queryRaw<{ count: number }[]>`
      WITH target AS (
        SELECT id
        FROM user_message
        WHERE recipient_id = ${uid}
          AND status = 0
        ORDER BY id
        LIMIT ${MESSAGE_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      ),
      updated AS (
        UPDATE user_message AS um
        SET status = 1,
            updated = now() AT TIME ZONE 'UTC'
        FROM target
        WHERE um.id = target.id
        RETURNING 1
      )
      SELECT COUNT(*)::int AS count
      FROM updated
    `

    return result[0]?.count ?? 0
  })

  return {}
}

const clearReadMessage = async (uid: number, type: string) => {
  await processMessageInBatches(async () => {
    const result = type
      ? await prisma.$queryRaw<{ count: number }[]>`
          WITH target AS (
            SELECT id
            FROM user_message
            WHERE recipient_id = ${uid}
              AND status = 1
              AND type = ${type}
            ORDER BY id
            LIMIT ${MESSAGE_BATCH_SIZE}
            FOR UPDATE SKIP LOCKED
          ),
          deleted AS (
            DELETE FROM user_message AS um
            USING target
            WHERE um.id = target.id
            RETURNING 1
          )
          SELECT COUNT(*)::int AS count
          FROM deleted
        `
      : await prisma.$queryRaw<{ count: number }[]>`
          WITH target AS (
            SELECT id
            FROM user_message
            WHERE recipient_id = ${uid}
              AND status = 1
            ORDER BY id
            LIMIT ${MESSAGE_BATCH_SIZE}
            FOR UPDATE SKIP LOCKED
          ),
          deleted AS (
            DELETE FROM user_message AS um
            USING target
            WHERE um.id = target.id
            RETURNING 1
          )
          SELECT COUNT(*)::int AS count
          FROM deleted
        `

    return result[0]?.count ?? 0
  })

  return {}
}

export const PUT = async (req: NextRequest) => {
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }

  await readMessage(payload.uid)
  await invalidateUnread(payload.uid)
  const response = await getUnreadMessageStatus(payload.uid)
  return NextResponse.json(response)
}

export const DELETE = async (req: NextRequest) => {
  const input = kunParseDeleteQuery(req, clearReadMessageSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }

  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }

  const response = await clearReadMessage(payload.uid, input.type)
  return NextResponse.json(response)
}
