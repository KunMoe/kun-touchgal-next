import { createHash, randomBytes } from 'crypto'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import jwt from 'jsonwebtoken'
import { prisma } from '~/prisma/index'
import { deleteKunTokenSession, generateKunToken } from '~/app/api/utils/jwt'

// 端到端跑一遍 Authorization Code + PKCE 流程，验证 login→consent→code→token→userinfo。
// 运行：pnpm exec esno scripts/oidcE2eFlow.ts
const ORIGIN = 'http://127.0.0.1:3000'
const ISSUER = `${ORIGIN}/oidc`
const CLIENT_ID = 'touchgal-test'
const CLIENT_SECRET = 'test-secret-please-change'
const REDIRECT_URI = 'http://127.0.0.1:8080/callback'

// 脚本签发的登录会话有效期 30 天，跑完即吊销，不在 Redis 留下登录态
let testSession: { uid: number; jti: string } | null = null
const revokeTestSession = async () => {
  if (testSession) {
    await deleteKunTokenSession(testSession.uid, testSession.jti)
  }
}

const jar = new Map<string, string>()
const cookieHeader = () =>
  [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
const updateJar = (res: Response) => {
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(';')
    const idx = pair.indexOf('=')
    const name = pair.slice(0, idx).trim()
    const value = pair.slice(idx + 1).trim()
    if (!value || /expires=Thu, 01 Jan 1970/i.test(raw)) {
      jar.delete(name)
    } else {
      jar.set(name, value)
    }
  }
}

const main = async () => {
  const user = await prisma.user.findFirst({
    orderBy: { id: 'asc' },
    select: { id: true, name: true, role: true, email: true }
  })
  if (!user) {
    throw new Error('数据库无用户，无法测试')
  }
  const token = await generateKunToken(user.id, user.name, user.role, '30d')
  testSession = {
    uid: user.id,
    jti: (jwt.decode(token) as { jti: string }).jti
  }
  jar.set('kun-galgame-patch-moe-token', token)
  console.log('测试用户:', user)

  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const state = randomBytes(8).toString('hex')
  const nonce = randomBytes(8).toString('hex')

  const authUrl =
    `${ISSUER}/auth?client_id=${CLIENT_ID}&response_type=code` +
    `&scope=${encodeURIComponent('openid profile email')}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&state=${state}&nonce=${nonce}` +
    `&code_challenge=${challenge}&code_challenge_method=S256`

  let url = authUrl
  let method: 'GET' | 'POST' = 'GET'
  let code = ''
  for (let i = 0; i < 20; i++) {
    const res = await fetch(url, {
      method,
      headers: {
        cookie: cookieHeader(),
        ...(method === 'POST'
          ? { 'content-type': 'application/x-www-form-urlencoded' }
          : {})
      },
      body: method === 'POST' ? '' : undefined,
      redirect: 'manual'
    })
    updateJar(res)
    const location = res.headers.get('location')

    if (res.status >= 300 && res.status < 400 && location) {
      const next = new URL(location, url).toString()
      if (next.startsWith(REDIRECT_URI)) {
        code = new URL(next).searchParams.get('code') ?? ''
        console.log(`[${i}] 命中 redirect_uri，code=${code.slice(0, 12)}...`)
        break
      }
      console.log(`[${i}] ${res.status} -> ${new URL(next).pathname}`)
      url = next
      method = 'GET'
      continue
    }

    if (res.status === 200 && url.includes('/oidc/interaction/')) {
      const uid = url.split('/oidc/interaction/')[1].split(/[/?]/)[0]
      // login 阶段页面只渲染 ConfirmRedirect（浏览器里硬跳转 GET confirm），
      // 只有 consent 阶段才带 POST 表单
      if (!/method="post"/.test(await res.text())) {
        console.log(
          `[${i}] 200 login 页，GET confirm uid=${uid.slice(0, 8)}...`
        )
        url = `${ISSUER}/interaction/${uid}/confirm`
        method = 'GET'
        continue
      }
      console.log(
        `[${i}] 200 consent 页，POST 确认授权 uid=${uid.slice(0, 8)}...`
      )
      url = `${ISSUER}/interaction/${uid}/confirm`
      method = 'POST'
      continue
    }

    throw new Error(`意外停止：${res.status} ${url}\n${await res.text()}`)
  }
  if (!code) {
    throw new Error('未拿到 authorization code')
  }

  const tokenRes = await fetch(`${ISSUER}/token`, {
    method: 'POST',
    headers: {
      authorization:
        'Basic ' +
        Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier
    })
  })
  const tokenJson = (await tokenRes.json()) as Record<string, string>
  console.log('token 端点:', {
    status: tokenRes.status,
    token_type: tokenJson.token_type,
    scope: tokenJson.scope,
    has_id_token: Boolean(tokenJson.id_token),
    has_access_token: Boolean(tokenJson.access_token),
    has_refresh_token: Boolean(tokenJson.refresh_token)
  })
  if (!tokenJson.id_token || !tokenJson.access_token) {
    throw new Error('token 响应缺少 id_token/access_token')
  }

  const jwks = createRemoteJWKSet(new URL(`${ISSUER}/jwks`))
  const { payload } = await jwtVerify(tokenJson.id_token, jwks, {
    issuer: ISSUER,
    audience: CLIENT_ID
  })
  console.log('id_token 验签通过:', {
    sub: payload.sub,
    nonce: payload.nonce,
    nonce_ok: payload.nonce === nonce,
    aud: payload.aud
  })

  const userinfoRes = await fetch(`${ISSUER}/me`, {
    headers: { authorization: `Bearer ${tokenJson.access_token}` }
  })
  const userinfo = await userinfoRes.json()
  console.log('userinfo:', { status: userinfoRes.status, ...userinfo })
  console.log('\n✅ OIDC 授权码流程端到端通过')
}

main()
  .then(async () => {
    await revokeTestSession()
    process.exit(0)
  })
  .catch(async (error) => {
    console.error('❌', error)
    await revokeTestSession()
    process.exit(1)
  })
