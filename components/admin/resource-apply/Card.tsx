import { Card, CardBody } from '@heroui/react'
import { Chip } from '@heroui/react'
import Link from 'next/link'
import { KunTimeAgo } from '~/components/kun/TimeAgo'
import { KunPatchAttribute } from '~/components/kun/PatchAttribute'
import { KunUser } from '~/components/kun/floating-card/KunUser'
import { SUPPORTED_RESOURCE_LINK_MAP } from '~/constants/resource'
import type { AdminResource } from '~/types/api/admin'
import { contentStatusLabel } from '~/constants/contentStatus'

interface Props {
  resource: AdminResource
  actions: React.ReactNode
}

export const AdminResourceApplyCard = ({ resource, actions }: Props) => {
  return (
    <Card className="w-full">
      <CardBody className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <KunUser
            user={resource.user}
            userProps={{
              name: resource.user.name,
              description: (
                <>
                  <KunTimeAgo date={resource.created} /> 上传了首个资源
                </>
              ),
              avatarProps: {
                showFallback: true,
                src: resource.user.avatar,
                name: resource.user.name.charAt(0).toUpperCase()
              }
            }}
          />

          <div className="flex flex-col items-end gap-2">
            <Chip size="sm" variant="flat" color="warning">
              {contentStatusLabel('resource', resource.status)}
            </Chip>
          </div>
        </div>

        <div className="space-y-1">
          <Link
            href={`/${resource.uniqueId}`}
            className="sm:text-lg text-base font-semibold hover:text-primary-500 transition-colors"
          >
            {resource.patchName}
          </Link>
          {resource.name && (
            <p className="text-sm text-default-600 break-all whitespace-pre-wrap">
              {resource.name}
            </p>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <KunPatchAttribute
            types={resource.type}
            languages={resource.language}
            platforms={resource.platform}
            emulatorType={resource.emulatorType}
            modelName={resource.modelName}
            size="sm"
          />
          <Chip size="sm" color="primary" variant="flat">
            {resource.links.length} 个链接
          </Chip>
        </div>

        <div className="grid gap-3 text-xs sm:text-sm text-default-600">
          {resource.links.map((link, index) => (
            <div
              key={link.id}
              className="rounded-large border border-default-200 p-3 space-y-1"
            >
              <div className="flex flex-wrap gap-2">
                <Chip size="sm" variant="flat">
                  链接 #{index + 1}
                </Chip>
                <Chip size="sm" color="warning" variant="flat">
                  {link.size}
                </Chip>
                <Chip size="sm" variant="flat">
                  {SUPPORTED_RESOURCE_LINK_MAP[link.storage]}
                </Chip>
              </div>

              <div>
                <span className="font-medium">下载链接：</span>
                <span className="break-all">{link.content}</span>
              </div>
              {link.hash && (
                <div>
                  <span className="font-medium">哈希：</span>
                  <span className="break-all">{link.hash}</span>
                </div>
              )}
              {link.code && (
                <div>
                  <span className="font-medium">提取码：</span>
                  <span className="break-all">{link.code}</span>
                </div>
              )}
              {link.password && (
                <div>
                  <span className="font-medium">解压密码：</span>
                  <span className="break-all">{link.password}</span>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="flex justify-end">{actions}</div>
      </CardBody>
    </Card>
  )
}
