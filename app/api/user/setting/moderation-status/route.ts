import { kunRoute } from '~/app/api/utils/kunRoute'
import { prisma } from '~/prisma/index'

// 供账户设置页读取自身头像/签名审核状态, 刷新后仍能持久展示「审核中」提示
export const GET = kunRoute.get({
  auth: 'user',
  handler: async ({ actor: payload }) => {
    const user = await prisma.user.findUnique({
      where: { id: payload.uid },
      select: { avatar_status: true, bio_status: true }
    })
    if (!user) {
      return '未找到用户'
    }

    return {
      avatarPending: user.avatar_status === 1,
      bioPending: user.bio_status === 1
    }
  }
})
