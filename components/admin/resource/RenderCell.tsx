'use client'

import { Chip } from '@heroui/react'
import Link from 'next/link'
import { KunTimeAgo } from '~/components/kun/TimeAgo'
import { ResourceEdit } from './ResourceEdit'
import { KunUser } from '~/components/kun/floating-card/KunUser'
import type { AdminResource } from '~/types/api/admin'
import type { PatchResource } from '~/types/api/patch'
import { contentPhase, contentStatusLabel } from '~/constants/contentStatus'
import type { ContentPhase } from '~/constants/contentStatus'

const RESOURCE_PHASE_COLOR: Record<
  ContentPhase,
  'success' | 'danger' | 'warning' | 'default'
> = {
  public: 'success',
  hidden: 'danger',
  pending: 'warning',
  awaitingApproval: 'default'
}

interface RenderActions {
  onUpdated: (resource: PatchResource) => void
  onDeleted: (resourceId: number) => void
}

export const RenderCell = (
  resource: AdminResource,
  columnKey: string,
  actions?: RenderActions
) => {
  switch (columnKey) {
    case 'name':
      return <span className="font-medium">{resource.name}</span>
    case 'section': {
      const isPatch = resource.section === 'patch'
      return (
        <Chip color={isPatch ? 'secondary' : 'primary'} variant="flat">
          {isPatch ? '补丁' : '资源'}
        </Chip>
      )
    }
    case 'patchName':
      return (
        <Link
          href={`/${resource.uniqueId}`}
          className="font-medium hover:text-primary-500"
        >
          {resource.patchName}
        </Link>
      )
    case 'user':
      return (
        <KunUser
          user={resource.user}
          userProps={{
            name: resource.user.name,
            avatarProps: {
              src: resource.user.avatar
            }
          }}
        />
      )
    case 'created':
      return (
        <Chip size="sm" variant="light">
          <KunTimeAgo date={resource.created} />
        </Chip>
      )
    case 'status': {
      const color =
        RESOURCE_PHASE_COLOR[contentPhase('resource', resource.status)]
      return (
        <Chip color={color} variant="flat">
          {contentStatusLabel('resource', resource.status)}
        </Chip>
      )
    }
    case 'actions':
      return (
        <ResourceEdit
          initialResource={resource}
          onUpdated={actions?.onUpdated}
          onDeleted={actions?.onDeleted}
        />
      )
    default:
      return (
        <Chip color="primary" variant="flat">
          未知
        </Chip>
      )
  }
}
