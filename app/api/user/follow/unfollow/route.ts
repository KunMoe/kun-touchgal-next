import * as z from 'zod'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { prisma } from '~/prisma/index'

const uidSchema = z.object({
  uid: z.coerce.number({ message: '请输入合法的用户 ID' }).min(1).max(9999999)
})

const unfollowUser = async (uid: number, currentUserUid: number) => {
  if (uid === currentUserUid) {
    return '您不能取消关注自己'
  }

  // deleteMany 幂等: 关系已在别处被取消时 count 为 0 而非抛 P2025 → 500
  await prisma.user_follow_relation.deleteMany({
    where: {
      follower_id: currentUserUid,
      following_id: uid
    }
  })

  return {}
}

export const POST = kunRoute.post({
  auth: 'user',
  input: uidSchema,
  handler: async ({ input, actor: payload }) =>
    unfollowUser(input.uid, payload?.uid)
})
