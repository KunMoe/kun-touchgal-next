import { randomBytes } from 'crypto'
import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { encryptClientSecret } from '~/lib/oidc/secret'
import type {
  oidcClientCreateSchema,
  oidcClientUpdateSchema
} from '~/validations/oidc'
import type {
  AdminOidcClient,
  AdminOidcClientWithSecret
} from '~/types/api/oidc'

export const getOidcClients = async (): Promise<AdminOidcClient[]> => {
  return prisma.oidc_client.findMany({
    orderBy: { created: 'desc' },
    omit: { client_secret: true }
  })
}

export const createOidcClient = async (
  input: z.infer<typeof oidcClientCreateSchema>
): Promise<AdminOidcClientWithSecret> => {
  // 明文 secret 仅在创建响应里一次性返回给管理员，落库存 AES-256-GCM 密文。
  const clientSecret = randomBytes(32).toString('base64url')
  const row = await prisma.oidc_client.create({
    data: {
      client_id: `touchgal_${randomBytes(8).toString('hex')}`,
      client_secret: encryptClientSecret(clientSecret),
      client_name: input.client_name,
      redirect_uris: input.redirect_uris,
      post_logout_redirect_uris: input.post_logout_redirect_uris,
      scopes: input.scopes,
      grant_types: input.grant_types,
      response_types: ['code'],
      token_endpoint_auth_method: input.token_endpoint_auth_method,
      is_first_party: input.is_first_party
    },
    omit: { client_secret: true }
  })
  return { ...row, client_secret: clientSecret }
}

export const updateOidcClient = async (
  input: z.infer<typeof oidcClientUpdateSchema>
) => {
  const { id, ...rest } = input
  return prisma.oidc_client.update({
    where: { id },
    data: {
      client_name: rest.client_name,
      redirect_uris: rest.redirect_uris,
      post_logout_redirect_uris: rest.post_logout_redirect_uris,
      scopes: rest.scopes,
      grant_types: rest.grant_types,
      token_endpoint_auth_method: rest.token_endpoint_auth_method,
      is_first_party: rest.is_first_party,
      disabled: rest.disabled
    },
    omit: { client_secret: true }
  })
}

export const deleteOidcClient = async (id: number) => {
  await prisma.oidc_client.delete({ where: { id } })
  return {}
}
