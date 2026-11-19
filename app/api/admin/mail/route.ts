import * as z from 'zod'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { prisma } from '~/prisma/index'
import { adminSendEmailSchema } from '~/validations/admin'
import { sendEmailHTML } from './_send'
import { truncateLogContent } from '~/app/api/admin/_log'

const sendBulkEmail = async (
  input: z.infer<typeof adminSendEmailSchema>,
  uid: number
) => {
  const admin = await prisma.user.findUnique({ where: { id: uid } })
  if (!admin) {
    return '未找到该管理员'
  }

  const { templateId, variables } = input

  const users = await prisma.user.findMany({
    where: { enable_email_notice: true },
    select: { email: true }
  })

  const emailList = users.map((user) => user.email)

  const batchSize = 100
  let failed = 0
  for (let i = 0; i < emailList.length; i += batchSize) {
    const batch = emailList.slice(i, i + batchSize)

    const results = await Promise.all(
      batch.map((email) => sendEmailHTML(templateId, variables, email))
    )
    failed += results.filter((result) => typeof result === 'string').length
  }

  await prisma.admin_log.create({
    data: {
      type: 'create',
      user_id: uid,
      // variables 值长度无上限, 截断避免 22001; 此时邮件已群发, 500 会诱导重试
      content: truncateLogContent(
        `管理员 ${admin.name} 向全体用户发送了邮件 (共 ${emailList.length} 封, 失败 ${failed} 封)\n\n${JSON.stringify(variables)}`
      )
    }
  })

  return { count: emailList.length, failed }
}

export const POST = kunRoute.post({
  auth: 'user',
  capability: 'admin.access',
  input: adminSendEmailSchema,
  handler: ({ input, actor }) => sendBulkEmail(input, actor.uid)
})
