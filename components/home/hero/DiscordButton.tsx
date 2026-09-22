'use client'

import { Button } from '@heroui/button'
import { Tooltip } from '@heroui/tooltip'
import { Discord } from '~/components/kun/icons/Discord'
import { kunMoyuMoe } from '~/config/moyu-moe'

// Server Component 中 Tooltip 的 children 是 lazy client reference,
// isValidElement 在服务端为 false, Tooltip 会降级成 <p> 包装导致 hydration 不匹配;
// 需要 Tooltip 包裹客户端组件时, 整段必须落在客户端边界内
export const DiscordButton = () => {
  return (
    <Tooltip showArrow content="Discord 服务器">
      <Button
        isIconOnly
        as="a"
        href={kunMoyuMoe.domain.discord_group}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="加入 Discord 服务器"
        variant="flat"
        color="secondary"
      >
        <Discord />
      </Button>
    </Tooltip>
  )
}
