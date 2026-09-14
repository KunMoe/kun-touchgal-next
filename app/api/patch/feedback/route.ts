import { z } from 'zod'
import { NextRequest, NextResponse } from 'next/server'
import { kunParsePostBody } from '~/app/api/utils/parseQuery'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { createPatchFeedbackSchema } from '~/validations/patch'
import { createMessage } from '~/app/api/utils/message'
import { prisma } from '~/prisma'

const createFeedback = async (
  input: z.infer<typeof createPatchFeedbackSchema>,
  uid: number,
  username: string
) => {
  const patch = await prisma.patch.findUnique({
    where: { id: input.patchId },
    select: { name: true, unique_id: true }
  })
  if (!patch) {
    return '未找到 Galgame'
  }

  const STATIC_CONTENT = `${username} 对「${patch.name}」提交了反馈\n\n${input.content}`

  await createMessage({
    type: 'feedback',
    content: STATIC_CONTENT,
    sender_id: uid,
    link: `/${patch.unique_id}`
  })

  return {}
}

export const POST = async (req: NextRequest) => {
  const input = await kunParsePostBody(req, createPatchFeedbackSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }

  const response = await createFeedback(input, payload.uid, payload.name)
  return NextResponse.json(response)
}
