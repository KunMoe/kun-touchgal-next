import { kunRoute } from '~/app/api/utils/kunRoute'
import {
  oidcClientCreateSchema,
  oidcClientDeleteSchema,
  oidcClientUpdateSchema
} from '~/validations/oidc'
import {
  createOidcClient,
  deleteOidcClient,
  getOidcClients,
  updateOidcClient
} from './service'

export const GET = kunRoute.get({
  auth: 'user',
  capability: 'admin.access',
  handler: () => getOidcClients()
})

export const POST = kunRoute.post({
  auth: 'user',
  capability: 'admin.access',
  input: oidcClientCreateSchema,
  handler: ({ input }) => createOidcClient(input)
})

export const PUT = kunRoute.put({
  auth: 'user',
  capability: 'admin.access',
  input: oidcClientUpdateSchema,
  handler: ({ input }) => updateOidcClient(input)
})

export const DELETE = kunRoute.delete({
  auth: 'user',
  capability: 'admin.access',
  input: oidcClientDeleteSchema,
  handler: ({ input }) => deleteOidcClient(input.id)
})
