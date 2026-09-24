import * as z from 'zod'

const authMethods = [
  'client_secret_basic',
  'client_secret_post',
  'none'
] as const

export const oidcClientCreateSchema = z.object({
  client_name: z.string().trim().min(1).max(255),
  redirect_uris: z.array(z.string().url()).min(1),
  post_logout_redirect_uris: z.array(z.string().url()).default([]),
  scopes: z.array(z.string()).min(1),
  grant_types: z
    .array(z.string())
    .min(1)
    .default(['authorization_code', 'refresh_token']),
  token_endpoint_auth_method: z
    .enum(authMethods)
    .default('client_secret_basic'),
  is_first_party: z.boolean().default(false)
})

export const oidcClientUpdateSchema = oidcClientCreateSchema.extend({
  id: z.number().int().positive(),
  disabled: z.boolean().default(false)
})

export const oidcClientDeleteSchema = z.object({
  id: z.coerce.number().int().positive()
})
