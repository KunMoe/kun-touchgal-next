'use client'

import { Snippet } from '@heroui/snippet'
import { Chip } from '@heroui/chip'
import { Tooltip } from '@heroui/tooltip'
import { Cloud, Copy, Database, Link as LinkIcon } from 'lucide-react'
import { Microsoft } from '~/components/kun/icons/Microsoft'
import { SUPPORTED_RESOURCE_LINK_MAP } from '~/constants/resource'
import { kunCopy } from '~/utils/kunCopy'
import { kunFetchPut } from '~/utils/kunFetch'
import { KunExternalLink } from '~/components/kun/external-link/ExternalLink'
import type { JSX } from 'react'
import type { PatchResource, PatchResourceLink } from '~/types/api/patch'

const storageIcons: { [key: string]: JSX.Element } = {
  touchgal: <Database className="size-3" />,
  s3: <Cloud className="size-3" />,
  onedrive: <Microsoft className="size-3" />,
  user: <LinkIcon className="size-3" />
}

interface Props {
  resource: PatchResource
  link: PatchResourceLink
}

export const ResourceDownloadCard = ({ resource, link }: Props) => {
  // 下载计数没记上不值得打断用户, 结果有意不看
  const handleClickDownload = () => {
    void kunFetchPut<KunResponse<{}>>('/patch/resource/download', {
      patchId: resource.patchId,
      resourceId: resource.id,
      linkId: link.id
    })
  }

  return (
    <div className="flex flex-col space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Chip
          color="secondary"
          variant="flat"
          size="sm"
          startContent={storageIcons[link.storage]}
        >
          {SUPPORTED_RESOURCE_LINK_MAP[link.storage] ?? link.storage}
        </Chip>
        <Chip
          variant="flat"
          size="sm"
          startContent={<Database className="size-3" />}
        >
          {link.size}
        </Chip>
        {link.code && (
          <Tooltip content="点击复制提取码">
            <Chip
              as="button"
              size="sm"
              color="primary"
              variant="flat"
              className="cursor-pointer"
              startContent={<Copy className="size-3" />}
              onClick={() => kunCopy(link.code)}
            >
              提取码 <span className="font-mono">{link.code}</span>
            </Chip>
          </Tooltip>
        )}
        {link.password && (
          <Tooltip content="点击复制解压码">
            <Chip
              as="button"
              size="sm"
              color="primary"
              variant="flat"
              className="cursor-pointer"
              startContent={<Copy className="size-3" />}
              onClick={() => kunCopy(link.password)}
            >
              解压码 <span className="font-mono">{link.password}</span>
            </Chip>
          </Tooltip>
        )}
      </div>

      <div className="space-y-2">
        <KunExternalLink
          className="break-all"
          onPress={handleClickDownload}
          underline="always"
          link={link.content}
        >
          {link.content}
        </KunExternalLink>

        {link.storage === 's3' && link.hash && (
          <>
            <p className="text-sm">
              BLACK3 校验码 (您可以根据此校验码校验下载文件完整性)
            </p>
            <Snippet symbol="" className="flex overflow-auto whitespace-normal">
              {link.hash}
            </Snippet>
          </>
        )}
      </div>
    </div>
  )
}
