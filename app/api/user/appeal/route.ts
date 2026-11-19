import { kunRoute } from '~/app/api/utils/kunRoute'
import { getUserAppealSchema, submitAppealSchema } from '~/validations/appeal'
import { getUserAppeals } from './get'
import { submitAppeal } from './submit'

export const GET = kunRoute.get({
  auth: 'user',
  input: getUserAppealSchema,
  handler: async ({ input, actor: payload }) =>
    getUserAppeals(payload.uid, input)
})

export const POST = kunRoute.post({
  auth: 'user',
  input: submitAppealSchema,
  handler: async ({ input, actor: payload }) => submitAppeal(input, payload.uid)
})
