import * as z from 'zod'
import { MESSAGE_TYPE } from '~/constants/message'

export const getMessageSchema = z.object({
  type: z.enum(MESSAGE_TYPE).optional(),
  page: z.coerce.number().min(1).max(9999999),
  limit: z.coerce.number().min(1).max(30)
})

export const clearReadMessageSchema = z.object({
  type: z.enum(MESSAGE_TYPE)
})
