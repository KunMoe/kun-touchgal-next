import { kunRoute } from '~/app/api/utils/kunRoute'
import { prisma } from '~/prisma/index'
import { kunTx } from '~/server/db/tx'
import { bioSchema } from '~/validations/user'
import { invalidateUserSession } from '~/app/api/user/session/cache'
import {
  enqueueTextModeration,
  hasPendingModeration,
  planTextModeration
} from '~/server/moderation/submit'
import { bioSubject } from '~/server/moderation/subject'

export const POST = kunRoute.post({
  auth: 'user',
  input: bioSchema,
  handler: async ({ input, actor: payload }) => {
    if (await hasPendingModeration('bio', { userId: payload.uid })) {
      return '您提交的签名正在审核中, 暂时无法修改'
    }

    const moderation = await planTextModeration(bioSubject(input.bio), {
      actor: payload
    })

    if (moderation.intercept) {
      // 新签名暂存于任务 payload, 通过审核后由 apply.ts 写入 user 表
      const failure = await kunTx('bio.submit', async ({ tx }) => {
        await tx.user.update({
          where: { id: payload.uid },
          data: { bio_status: 1 }
        })
        await enqueueTextModeration(tx, moderation, {
          userId: payload.uid,
          bio: input.bio
        })
      })
      if (typeof failure === 'string') {
        return failure
      }
      await invalidateUserSession(payload.uid)

      // 显性告知作者签名审核中
      return { pending: true }
    }

    await prisma.user.update({
      where: { id: payload.uid },
      data: { bio: input.bio, bio_status: 0 }
    })

    // 走到这里的排队任务只可能是灰度 (dryRun): 拦截分支已在上面返回
    if (moderation.queue) {
      await enqueueTextModeration(prisma, moderation, {
        userId: payload.uid,
        bio: input.bio
      })
    }

    await invalidateUserSession(payload.uid)

    return {}
  }
})
