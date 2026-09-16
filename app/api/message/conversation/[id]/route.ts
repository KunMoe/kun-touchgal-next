import { NextRequest, NextResponse } from 'next/server'
import { kunParseGetQuery, kunParsePostBody } from '~/app/api/utils/parseQuery'
import {
  parseConversationId,
  getConversationMessagesSchema,
  sendPrivateMessageSchema,
  updatePrivateMessageSchema,
  deletePrivateMessageSchema
} from '~/validations/conversation'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import {
  getConversationMessages,
  sendMessage,
  updateMessage,
  deleteMessage,
  deleteConversation
} from './service'

export const GET = async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params
  const conversationId = parseConversationId(id)
  if (typeof conversationId === 'string') {
    return NextResponse.json(conversationId)
  }

  const input = kunParseGetQuery(req, getConversationMessagesSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }

  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }

  const response = await getConversationMessages(
    conversationId,
    input,
    payload.uid
  )
  return NextResponse.json(response)
}

export const POST = async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params
  const conversationId = parseConversationId(id)
  if (typeof conversationId === 'string') {
    return NextResponse.json(conversationId)
  }

  const input = await kunParsePostBody(req, sendPrivateMessageSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }

  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }

  const response = await sendMessage(conversationId, input, payload.uid)
  return NextResponse.json(response)
}

export const PUT = async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params
  const conversationId = parseConversationId(id)
  if (typeof conversationId === 'string') {
    return NextResponse.json(conversationId)
  }

  const input = await kunParsePostBody(req, updatePrivateMessageSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }

  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }

  const response = await updateMessage(conversationId, input, payload.uid)
  return NextResponse.json(response)
}

export const DELETE = async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params
  const conversationId = parseConversationId(id)
  if (typeof conversationId === 'string') {
    return NextResponse.json(conversationId)
  }

  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }

  const { searchParams } = new URL(req.url)

  if (searchParams.has('messageId')) {
    const input = kunParseGetQuery(req, deletePrivateMessageSchema)
    if (typeof input === 'string') {
      return NextResponse.json(input)
    }

    const response = await deleteMessage(conversationId, input, payload.uid)
    return NextResponse.json(response)
  }

  if (searchParams.get('action') !== 'conversation') {
    return NextResponse.json('无效的删除操作类型')
  }

  const response = await deleteConversation(conversationId, payload.uid)
  return NextResponse.json(response)
}
