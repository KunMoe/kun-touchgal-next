import { NextResponse } from 'next/server'
import { kunMoyuMoe } from '~/config/moyu-moe'
import { escapeHtml } from '~/utils/escapeHtml'
import { kunLog } from '~/lib/log.server'

export type EmailChangeRevertPayload = {
  uid: number
  oldEmail: string
  newEmail: string
  createdAt: string
}

export const createEmailChangeRevertKey = (token: string) =>
  `email-change-revert:${token}`

const getSiteAddress = () => {
  const envAddress =
    process.env.NODE_ENV === 'development'
      ? process.env.NEXT_PUBLIC_KUN_PATCH_ADDRESS_DEV
      : process.env.NEXT_PUBLIC_KUN_PATCH_ADDRESS_PROD

  return envAddress || kunMoyuMoe.domain.main
}

const createEmailChangeRevertLink = (token: string) => {
  return `${getSiteAddress()}/api/user/setting/email/revert?token=${encodeURIComponent(token)}`
}

const createEmailChangeNotificationTemplate = (
  oldEmail: string,
  newEmail: string,
  revertLink: string
) => {
  const safeOldEmail = escapeHtml(oldEmail)
  const safeNewEmail = escapeHtml(newEmail)
  const safeRevertLink = escapeHtml(revertLink)
  const iconImage = `${getSiteAddress()}/logo.webp`

  return `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${kunMoyuMoe.titleShort} 邮箱变更提醒</title>
  </head>
  <body style="background-color: #e4e4e7; margin: 0; padding: 40px 0">
    <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 8px; overflow: hidden">
      <div style="background: #e6f1fe; padding: 24px; text-align: center">
        <img src="${iconImage}" alt="${kunMoyuMoe.titleShort}" style="height: 48px" />
        <h1 style="color: #27272a; font-size: 24px; margin: 12px 0 0 0">
          邮箱变更提醒
        </h1>
      </div>
      <div style="padding: 32px; color: #374151; font-size: 16px; line-height: 24px">
        <p style="margin: 0 0 16px 0">
          我们收到了将您的账户邮箱从 ${safeOldEmail} 更改为 ${safeNewEmail} 的请求。
        </p>
        <p style="margin: 0 0 24px 0">
          如果这是您本人操作, 可以忽略这封邮件。如果不是您本人操作, 请尽快点击下面的链接撤销本次邮箱变更。
        </p>
        <p style="text-align: center; margin: 0 0 24px 0">
          <a
            href="${safeRevertLink}"
            style="display: inline-block; background: #006fee; color: #ffffff; text-decoration: none; padding: 12px 20px; border-radius: 8px"
          >
            撤销邮箱变更
          </a>
        </p>
        <p style="color: #71717a; font-size: 14px; margin: 0">
          撤销链接 24 小时内有效。为了保护账户安全, 建议您同时修改密码并检查账户的 2FA 设置。
        </p>
      </div>
    </div>
  </body>
</html>
  `
}

export const sendEmailChangeNotification = async (
  oldEmail: string,
  newEmail: string,
  token: string
) => {
  const revertLink = createEmailChangeRevertLink(token)
  const res = await fetch(
    `${process.env.KUN_VISUAL_NOVEL_EMAIL_HOST}/api/v1/send/message`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Server-API-Key': process.env.KUN_VISUAL_NOVEL_EMAIL_PASSWORD || '',
        Authorization: `Bearer ${process.env.KUN_VISUAL_NOVEL_EMAIL_PASSWORD}`
      },
      body: JSON.stringify({
        to: [oldEmail],
        from: process.env.KUN_VISUAL_NOVEL_EMAIL_ACCOUNT,
        sender: `${process.env.KUN_VISUAL_NOVEL_EMAIL_FROM}<${process.env.KUN_VISUAL_NOVEL_EMAIL_ACCOUNT}>`,
        subject: `${kunMoyuMoe.titleShort} - 邮箱变更提醒`,
        tag: 'security-notice',
        html_body: createEmailChangeNotificationTemplate(
          oldEmail,
          newEmail,
          revertLink
        ),
        plain_body: `我们收到了将您的账户邮箱从 ${oldEmail} 更改为 ${newEmail} 的请求。如果不是您本人操作, 请在 24 小时内访问此链接撤销: ${revertLink}`
      })
    }
  )

  if (!res.ok) {
    await res.body?.cancel()
    kunLog('email.send_failed', { tag: 'security-notice', status: res.status })
    return '发送旧邮箱安全通知失败, 请稍后重试'
  }

  const result = await res.json()
  if (result.status === 'error') {
    kunLog('email.send_failed', {
      tag: 'security-notice',
      relayStatus: 'error',
      relayCode:
        typeof result.data?.code === 'string' ? result.data.code : undefined
    })
    return '发送旧邮箱安全通知失败, 请稍后重试'
  }
}

export const createEmailChangeRevertConfirmResponse = (
  token: string,
  oldEmail: string
) => {
  const safeToken = escapeHtml(token)
  const safeOldEmail = escapeHtml(oldEmail)

  return new NextResponse(
    `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>确认撤销邮箱变更</title>
  </head>
  <body style="font-family: system-ui, sans-serif; margin: 0; padding: 40px; background: #f4f4f5; color: #27272a">
    <main style="max-width: 560px; margin: 0 auto; background: #ffffff; padding: 32px; border-radius: 8px">
      <h1 style="font-size: 24px; margin: 0 0 16px 0">确认撤销邮箱变更</h1>
      <p style="line-height: 24px; margin: 0 0 24px 0">
        点击确认后, 账户邮箱将恢复为 ${safeOldEmail}。
      </p>
      <form method="post" action="/api/user/setting/email/revert">
        <input type="hidden" name="token" value="${safeToken}" />
        <button
          type="submit"
          style="background: #006fee; border: 0; color: #ffffff; cursor: pointer; padding: 12px 20px; border-radius: 8px; font-size: 16px"
        >
          确认撤销
        </button>
      </form>
    </main>
  </body>
</html>
    `,
    {
      headers: {
        'Content-Type': 'text/html; charset=utf-8'
      }
    }
  )
}

export const createEmailChangeRevertResponse = (
  title: string,
  message: string,
  status = 200
) => {
  const safeTitle = escapeHtml(title)
  const safeMessage = escapeHtml(message)

  return new NextResponse(
    `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${safeTitle}</title>
  </head>
  <body style="font-family: system-ui, sans-serif; margin: 0; padding: 40px; background: #f4f4f5; color: #27272a">
    <main style="max-width: 560px; margin: 0 auto; background: #ffffff; padding: 32px; border-radius: 8px">
      <h1 style="font-size: 24px; margin: 0 0 16px 0">${safeTitle}</h1>
      <p style="line-height: 24px; margin: 0">${safeMessage}</p>
    </main>
  </body>
</html>
    `,
    {
      status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8'
      }
    }
  )
}
