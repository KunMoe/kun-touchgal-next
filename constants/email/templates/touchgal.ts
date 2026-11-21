import { kunMoyuMoe } from '~/config/moyu-moe'
import type { CampaignTemplateSlots } from '../campaign'

const domain =
  process.env.NODE_ENV === 'development'
    ? process.env.NEXT_PUBLIC_KUN_PATCH_ADDRESS_DEV
    : process.env.NEXT_PUBLIC_KUN_PATCH_ADDRESS_PROD

const iconImage = `${domain}/logo.webp`

export const touchgalTemplate = ({
  titleHtml,
  contentHtml,
  unsubscribeHref
}: CampaignTemplateSlots) => `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${kunMoyuMoe.titleShort}</title>
    <!--[if mso]>
      <style>
        table {
          border-collapse: collapse;
          border-spacing: 0;
          border: none;
          margin: 0;
        }
        div,
        td {
          padding: 0;
        }
        div {
          margin: 0 !important;
        }
      </style>
      <noscript>
        <xml>
          <o:OfficeDocumentSettings>
            <o:PixelsPerInch>96</o:PixelsPerInch>
          </o:OfficeDocumentSettings>
        </xml>
      </noscript>
    <![endif]-->
    <style>
      body {
        margin: 0;
        padding: 0;
        width: 100% !important;
        -webkit-text-size-adjust: 100%;
        -ms-text-size-adjust: 100%;
      }

      img {
        max-width: 100%;
        outline: none;
        text-decoration: none;
        -ms-interpolation-mode: bicubic;
      }

      h1 {
        padding-left: 10px;
        color: #27272a;
      }

      .container {
        max-width: 600px;
        margin: 0 auto;
      }

      .header {
        background: #e6f1fe;
        color: white;
        padding: 30px;
        display: flex;
        justify-content: center;
        align-items: center;
        border-radius: 14px 14px 0 0;
      }

      .content {
        background: #ffffff;
        padding: 40px 30px;
        text-align: center;
        border-radius: 0 0 14px 14px;
      }

      .footer {
        margin-top: 30px;
        color: #a1a1aa;
        text-align: center;
        padding: 24px;
        font-size: 14px;
        border-top: 1px solid #e4e4e7;
      }

      a {
        color: #006FEE;
      }

      @media only screen and (max-width: 480px) {
        .container {
          width: 100% !important;
        }

        .content {
          padding: 30px 20px !important;
        }
      }
    </style>
  </head>
  <body style="background-color: #e4e4e7; padding: 40px 0">
    <div class="container">
      <div class="header">
        <img src="${iconImage}" />
        <h1 style="margin: 0; font-size: 24px; font-weight: 600">
          ${titleHtml}
        </h1>
      </div>
      <div class="content">
        ${contentHtml}
        <div class="footer">
          <p style="margin: 0;">此消息为系统自动发布, 请勿回复此消息, 如果有任何问题, 请联系 <a href="${kunMoyuMoe.domain.main}" target="_blank">${kunMoyuMoe.titleShort}</a> </p>
          <p style="margin: 0;">要取消邮件通知, 请点击 <a href="${unsubscribeHref}" target="_blank">退订邮件</a> </p>
        </div>
      </div>
    </div>
  </body>
</html>`
