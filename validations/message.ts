import * as z from 'zod'
import { kunLimit, kunPage } from './primitives'
import { MESSAGE_TYPE } from '~/constants/message'

export const getMessageSchema = z.object({
  type: z.enum(MESSAGE_TYPE).optional(),
  page: kunPage(),
  limit: kunLimit(30)
})

export const clearReadMessageSchema = z.object({
  type: z.enum(MESSAGE_TYPE)
})
