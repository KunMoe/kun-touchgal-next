import { prisma } from '~/prisma/index'

// 开发用：幂等写入一个测试 OIDC client，供手工跑授权码流程。
// 运行：pnpm exec esno scripts/seedOidcTestClient.ts
const CLIENT = {
  client_id: 'touchgal-test',
  client_secret: 'test-secret-please-change',
  client_name: 'TouchGal Test RP',
  redirect_uris: [
    'http://127.0.0.1:8080/callback',
    'https://oidcdebugger.com/debug'
  ],
  post_logout_redirect_uris: ['http://127.0.0.1:8080/'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  scopes: ['openid', 'profile', 'email'],
  token_endpoint_auth_method: 'client_secret_basic'
}

const main = async () => {
  const client = await prisma.oidc_client.upsert({
    where: { client_id: CLIENT.client_id },
    create: CLIENT,
    update: CLIENT
  })
  console.log('测试 client 就绪：', {
    client_id: client.client_id,
    client_secret: CLIENT.client_secret,
    redirect_uris: client.redirect_uris
  })
}

main().then(() => process.exit(0))
