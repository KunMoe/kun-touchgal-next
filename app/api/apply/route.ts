import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '~/prisma/index'
import { createMessage } from '~/app/api/utils/message'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { isCreatorRole } from '~/constants/permission'

const applyForCreator = async (uid: number) => {
  const user = await prisma.user.findUnique({
    where: { id: uid },
    include: {
      _count: {
        select: {
          patch_resource: true
        }
      }
    }
  })
  if (!user) {
    return '未找到该用户'
  }

  if (user._count.patch_resource < 3) {
    return '您暂时不可以申请成为创作者, 您可以继续发布资源'
  }

  if (isCreatorRole(user.role)) {
    return '您已经是一名创作者了! 无需重复申请'
  }

  const message = await prisma.user_message.findFirst({
    where: { type: 'apply', sender_id: uid, status: 0 }
  })
  if (message) {
    return '您有一条正在进行中的申请, 请等待该申请的完成'
  }

  await createMessage({
    type: 'apply',
    content: '申请成为创作者',
    sender_id: uid,
    link: `/user/${uid}/comment`
  })

  return {}
}

export const POST = async (req: NextRequest) => {
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }

  const response = await applyForCreator(payload.uid)
  return NextResponse.json(response)
}
