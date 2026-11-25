import { prisma } from '~/prisma/index'
import {
  delKv,
  delKvs,
  getKv,
  getKvSetMembers,
  setKvsAndAddKvSetMembers
} from '~/lib/redis'
import { decryptClientSecret } from './secret'
import type { Adapter, AdapterFactory, AdapterPayload } from 'oidc-provider'

// 带 grantId 的可撤销对象，需登记到 grant 索引集合供 revokeByGrantId 使用。
const GRANTABLE = new Set([
  'AccessToken',
  'AuthorizationCode',
  'RefreshToken',
  'DeviceCode',
  'BackchannelAuthenticationRequest'
])

const nowSeconds = () => Math.floor(Date.now() / 1000)

const mainKey = (name: string, id: string) => `oidc:${name}:${id}`
const grantKey = (grantId: string) => `oidc:grant:${grantId}`
const userCodeKey = (userCode: string) => `oidc:userCode:${userCode}`
const uidKey = (uid: string) => `oidc:uid:${uid}`

// Client（依赖方应用）是长期配置，从 Prisma oidc_client 表读取并映射为 provider 元数据。
// upsert/destroy 空实现——client 生命周期由 admin API 管理。
const createClientAdapter = (): Adapter => ({
  async find(id) {
    const row = await prisma.oidc_client.findUnique({
      where: { client_id: id },
      omit: { client_secret: false }
    })
    if (!row || row.disabled) {
      return undefined
    }
    const metadata: AdapterPayload = {
      client_id: row.client_id,
      client_name: row.client_name,
      redirect_uris: row.redirect_uris,
      post_logout_redirect_uris: row.post_logout_redirect_uris,
      grant_types: row.grant_types,
      response_types: row.response_types as AdapterPayload['response_types'],
      scope: row.scopes.join(' '),
      token_endpoint_auth_method:
        row.token_endpoint_auth_method as AdapterPayload['token_endpoint_auth_method'],
      // 自定义元数据：经 extraClientMetadata 透传，供 loadExistingGrant 判定可信一方。
      is_first_party: row.is_first_party
    }
    if (row.token_endpoint_auth_method !== 'none') {
      metadata.client_secret = decryptClientSecret(row.client_secret)
    }
    return metadata
  },
  async upsert() {},
  async destroy() {},
  async findByUserCode() {
    return undefined
  },
  async findByUid() {
    return undefined
  },
  async consume() {},
  async revokeByGrantId() {}
})

// 其余 OIDC 运行时对象走 Redis，靠 TTL 自动过期。key 前缀 kun:touchgal: 由 lib/redis.ts 补全。
const createRedisModelAdapter = (name: string): Adapter => ({
  async upsert(id, payload, expiresIn) {
    const key = mainKey(name, id)
    const values = [
      { key, value: JSON.stringify(payload), ttlSeconds: expiresIn }
    ]

    if (payload.userCode) {
      values.push({
        key: userCodeKey(payload.userCode),
        value: id,
        ttlSeconds: expiresIn
      })
    }
    if (payload.uid) {
      values.push({
        key: uidKey(payload.uid),
        value: id,
        ttlSeconds: expiresIn
      })
    }

    const hasGrant = GRANTABLE.has(name) && Boolean(payload.grantId)
    await setKvsAndAddKvSetMembers(values, {
      key: hasGrant ? grantKey(payload.grantId as string) : 'oidc:noop',
      members: hasGrant ? [`${name}:${id}`] : [],
      setTtlSeconds: hasGrant ? expiresIn : undefined
    })
  },

  async find(id) {
    const raw = await getKv(mainKey(name, id))
    return raw ? (JSON.parse(raw) as AdapterPayload) : undefined
  },

  async findByUserCode(userCode) {
    const id = await getKv(userCodeKey(userCode))
    if (!id) {
      return undefined
    }
    const raw = await getKv(mainKey(name, id))
    return raw ? (JSON.parse(raw) as AdapterPayload) : undefined
  },

  async findByUid(uid) {
    const id = await getKv(uidKey(uid))
    if (!id) {
      return undefined
    }
    const raw = await getKv(mainKey(name, id))
    return raw ? (JSON.parse(raw) as AdapterPayload) : undefined
  },

  async consume(id) {
    const key = mainKey(name, id)
    const raw = await getKv(key)
    if (!raw) {
      return
    }
    const payload = JSON.parse(raw) as AdapterPayload
    payload.consumed = nowSeconds()
    // 保留剩余 TTL；若缺失（理论上不会）则用有界兜底，避免 key 永久残留在 Redis。
    const ttl = payload.exp ? payload.exp - nowSeconds() : 0
    await setKvsAndAddKvSetMembers(
      [
        {
          key,
          value: JSON.stringify(payload),
          ttlSeconds: ttl > 0 ? ttl : 600
        }
      ],
      { key: 'oidc:noop', members: [] }
    )
  },

  async destroy(id) {
    await delKv(mainKey(name, id))
  },

  async revokeByGrantId(grantId) {
    const members = await getKvSetMembers(grantKey(grantId))
    if (members.length) {
      await delKvs(members.map((member) => `oidc:${member}`))
    }
    await delKv(grantKey(grantId))
  }
})

export const createOidcAdapter: AdapterFactory = (name): Adapter =>
  name === 'Client' ? createClientAdapter() : createRedisModelAdapter(name)
