'use client'

import Link from 'next/link'
import { Card, CardBody } from '@heroui/card'
import { KunTimeAgo } from '~/components/kun/TimeAgo'
import { KunPatchAttribute } from '~/components/kun/PatchAttribute'
import { KunStaticChip } from '~/components/kun/StaticChip'
import { KunUser } from '../kun/floating-card/KunUser'
import { cn } from '~/utils/cn'
import { kunCjkIndentClass } from '~/utils/kunCjkIndent'
import type { PatchResource } from '~/types/api/resource'

const CARD_CLASS_NAME =
  'group flex h-full w-full flex-col overflow-hidden rounded-[22px] border border-default-200/60 bg-background shadow-[0_12px_32px_rgba(15,23,42,0.05)] transition-[box-shadow,transform,scale] duration-300 hover:shadow-[0_16px_42px_rgba(15,23,42,0.08)] motion-reduce:transition-none dark:bg-content1 dark:shadow-[0_12px_32px_rgba(0,0,0,0.15)]'

interface Props {
  resource: PatchResource
}

export const ResourceCard = ({ resource }: Props) => {
  const primaryLink = resource.primaryLink
  const title = resource.name || resource.patchName

  return (
    <Card
      isPressable
      as={Link}
      href={`/${resource.uniqueId}`}
      prefetch={false}
      className={CARD_CLASS_NAME}
    >
      <CardBody className="flex h-full flex-col gap-3 p-4 sm:p-5">
        <div className="space-y-1.5">
          <h2
            className={cn(
              'line-clamp-2 break-all text-base font-semibold leading-snug transition-colors group-hover:text-primary-500 sm:text-lg',
              kunCjkIndentClass(title)
            )}
          >
            {title}
          </h2>

          {resource.name && (
            <p
              className={cn(
                'line-clamp-2 text-small leading-5 text-default-500',
                kunCjkIndentClass(resource.patchName)
              )}
            >
              {resource.patchName}
            </p>
          )}
        </div>

        <KunPatchAttribute
          types={resource.type}
          languages={resource.language}
          platforms={resource.platform}
          emulatorType={resource.emulatorType}
          modelName={resource.modelName}
          size="sm"
          hidePatchType
        />

        <div className="mt-auto flex items-end justify-between gap-3 pt-1">
          <div className="min-w-0">
            <KunUser
              user={resource.user}
              userProps={{
                name: resource.user.name,
                description: (
                  <>
                    <KunTimeAgo date={resource.created} /> • 已发布资源{' '}
                    {resource.user.patchCount} 个
                  </>
                ),
                avatarProps: {
                  showFallback: true,
                  src: resource.user.avatar,
                  name: resource.user.name.charAt(0).toUpperCase(),
                  size: 'sm'
                }
              }}
            />
          </div>
          {primaryLink && (
            <KunStaticChip size="sm" className="shrink-0">
              {primaryLink.size}
            </KunStaticChip>
          )}
        </div>
      </CardBody>
    </Card>
  )
}
