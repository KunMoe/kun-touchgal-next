import { kunMoyuMoe } from '~/config/moyu-moe'
import type { CampaignTemplateSlots } from '../campaign'

const domain =
  process.env.NODE_ENV === 'development'
    ? process.env.NEXT_PUBLIC_KUN_PATCH_ADDRESS_DEV
    : process.env.NEXT_PUBLIC_KUN_PATCH_ADDRESS_PROD

const iconImage = `${domain}/logo.webp`

export const announcementTemplate = ({
  titleHtml,
  contentHtml,
  unsubscribeHref
}: CampaignTemplateSlots) => `
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${titleHtml}</title>
    <style>
      body { margin: 0; padding: 0; background-color: #fef2f2; }
      .container { max-width: 600px; margin: 0 auto; padding: 20px; }
      .card {
        background: white;
        border-radius: 12px;
        overflow: hidden;
        border: 1px solid #fee2e2;
      }
      .header {
        background: #dc2626;
        padding: 24px;
        display: flex;
        justify-content: center;
        align-items: center;
      }
      .header img {
        margin-right: 10px;
      }
      .content { padding: 32px; }
      .message {
        margin: 24px 0;
        padding: 16px;
        background: #fef2f2;
        border-radius: 8px;
        border-left: 4px solid #dc2626;
      }
      .footer {
        color: #6b7280;
        text-align: center;
        padding: 24px;
        font-size: 14px;
        border-top: 1px solid #fee2e2;
      }
      a {
        color: #dc2626;
      }
      @media only screen and (max-width: 480px) {
        .container { width: 100% !important; padding: 10px; }
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="card">
        <div class="header">
          <img src="${iconImage}" />
          <h1 style="color: white; margin: 0; font-size: 24px;">重要公告</h1>
        </div>
        <div class="content">
          <h2 style="color: #dc2626; margin: 0 0 16px 0; font-size: 20px;">${titleHtml}</h2>
          <div class="message">
            <p style="color: #374151; font-size: 16px; line-height: 24px; margin: 0;">
              ${contentHtml}
            </p>
          </div>
        </div>
        <div class="footer">
          <p style="margin: 0;">此消息为系统自动发布, 请勿回复此消息, 如果有任何问题, 请联系 <a href="${kunMoyuMoe.domain.main}" target="_blank">${kunMoyuMoe.titleShort}</a> </p>
          <p style="margin: 0;">要取消邮件通知, 请点击 <a href="${unsubscribeHref}" target="_blank">退订邮件</a> </p>
        </div>
      </div>
    </div>
  </body>
</html>`
