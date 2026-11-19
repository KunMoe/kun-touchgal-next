import { NextResponse } from 'next/server'
import { kunRoute } from '~/app/api/utils/kunRoute'

export const POST = kunRoute.post({
  auth: 'public',
  csrf: 'handler',
  handler: () =>
    NextResponse.json('该上传接口已废弃, 请刷新页面以使用新版上传流程', {
      status: 410
    })
})
