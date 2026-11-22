import * as z from 'zod'
import { kunRoute } from '~/app/api/utils/kunRoute'
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

export const POST = kunRoute.post({
  auth: 'user',
  input: createPatchFeedbackSchema,
  abuse: ['feedback.create'],
  handler: ({ input, actor }) => createFeedback(input, actor.uid, actor.name)
})
