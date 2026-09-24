import { NextRequest, NextResponse } from 'next/server'
import * as z from 'zod'
import { prisma } from '~/prisma'
import { Prisma } from '~/prisma/generated/prisma/client'
import {
  createCompanySchema,
  getCompanyByIdSchema,
  updateCompanySchema
} from '~/validations/company'
import {
  kunParseDeleteQuery,
  kunParseGetQuery,
  kunParsePostBody,
  kunParsePutBody
} from '../utils/parseQuery'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { getCompanyById } from './service'
import { invalidateCompanyListCache } from './cache'
import {
  enqueueSearchOutboxBatch,
  kickSearchOutboxDrain
} from '~/server/search/sync'
export const GET = async (req: NextRequest) => {
  const input = kunParseGetQuery(req, getCompanyByIdSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }

  const response = await getCompanyById(input)
  return NextResponse.json(response)
}

const rewriteCompany = async (input: z.infer<typeof updateCompanySchema>) => {
  const {
    companyId,
    name,
    primary_language,
    introduction = '',
    alias = [],
    official_website = [],
    parent_brand = []
  } = input

  const existingCompany = await prisma.patch_company.findFirst({
    where: {
      OR: [{ name }, { alias: { has: name } }]
    }
  })
  if (existingCompany && existingCompany.id !== companyId) {
    return '这个会社已经存在了'
  }

  // 索引文档内嵌会社名，改名须重建全部关联 patch 的文档；仅改简介/别名不入文档
  //（别名解析在查询期实时读库），无需入队
  const currentCompany = await prisma.patch_company.findUnique({
    where: { id: companyId },
    select: { name: true }
  })
  const shouldSyncSearch = !!currentCompany && currentCompany.name !== name

  try {
    // 事务性入队：会社变更与写出箱入队原子提交，关闭崩溃丢失窗口
    const { newCompany, patchIds } = await prisma.$transaction(async (tx) => {
      const newCompany = await tx.patch_company.update({
        where: { id: companyId },
        data: {
          name,
          introduction,
          alias,
          primary_language,
          official_website,
          parent_brand
        },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              avatar: true
            }
          }
        }
      })
      const patchIds = shouldSyncSearch
        ? (
            await tx.patch_company_relation.findMany({
              where: { company_id: companyId },
              select: { patch_id: true }
            })
          ).map((relation) => relation.patch_id)
        : []
      await enqueueSearchOutboxBatch(tx, patchIds)
      return { newCompany, patchIds }
    })
    await invalidateCompanyListCache()
    if (patchIds.length > 0) {
      kickSearchOutboxDrain()
    }

    return newCompany
  } catch (error) {
    // name 唯一索引兜底并发改名
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return '这个会社已经存在了'
    }
    throw error
  }
}

export const PUT = async (req: NextRequest) => {
  const input = await kunParsePutBody(req, updateCompanySchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }

  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }
  if (payload.role < 3) {
    return NextResponse.json('本页面仅管理员可访问')
  }

  const response = await rewriteCompany(input)
  return NextResponse.json(response)
}

const createCompany = async (
  input: z.infer<typeof createCompanySchema>,
  uid: number
) => {
  const {
    name,
    primary_language,
    introduction = '',
    alias = [],
    official_website = [],
    parent_brand = []
  } = input

  const existingCompany = await prisma.patch_company.findFirst({
    where: {
      OR: [{ name }, { alias: { has: name } }]
    }
  })
  if (existingCompany) {
    return '这个会社已经存在了'
  }

  try {
    const newCompany = await prisma.patch_company.create({
      data: {
        user_id: uid,
        name,
        introduction,
        alias,
        primary_language,
        official_website,
        parent_brand
      },
      select: {
        id: true,
        name: true,
        count: true,
        alias: true
      }
    })
    await invalidateCompanyListCache()

    return newCompany
  } catch (error) {
    // name 唯一索引兜底并发创建
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return '这个会社已经存在了'
    }
    throw error
  }
}

export const POST = async (req: NextRequest) => {
  const input = await kunParsePostBody(req, createCompanySchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }

  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }
  if (payload.role < 3) {
    return NextResponse.json('本页面仅管理员可访问')
  }

  const response = await createCompany(input, payload.uid)
  return NextResponse.json(response)
}

export const DELETE = async (req: NextRequest) => {
  const input = kunParseDeleteQuery(req, getCompanyByIdSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }

  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }
  if (payload.role < 3) {
    return NextResponse.json('本页面仅管理员可访问')
  }

  // 索引文档内嵌会社名与 companyIds，FK Cascade 会随删除清掉关系行，因此关联
  // patch 必须在删除前读取；删除与入队原子提交，消费者按 DB 最新状态重建文档
  let patchIds: number[]
  try {
    patchIds = await prisma.$transaction(async (tx) => {
      const relations = await tx.patch_company_relation.findMany({
        where: { company_id: input.companyId },
        select: { patch_id: true }
      })
      await tx.patch_company.delete({ where: { id: input.companyId } })
      const ids = relations.map((relation) => relation.patch_id)
      await enqueueSearchOutboxBatch(tx, ids)
      return ids
    })
  } catch {
    return NextResponse.json('未找到对应的会社')
  }
  await invalidateCompanyListCache()
  if (patchIds.length > 0) {
    kickSearchOutboxDrain()
  }

  return NextResponse.json({})
}
