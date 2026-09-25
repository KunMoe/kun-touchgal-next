import { ExternalLink } from 'lucide-react'
import { kunMoyuMoe } from '~/config/moyu-moe'
import { kunFriends } from '~/config/friend'

// 类名逐字取自 HeroUI Card(isPressable, isHoverable) 与 Link 的 SSR 输出,
// data-[hover|focus-visible|pressed=true] 换成对应伪类, 整页保持零客户端 JS
const FRIEND_CARD_CLASS_NAME =
  'flex flex-col relative overflow-hidden text-foreground box-border bg-content1 outline-hidden focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2 shadow-medium rounded-large hover:bg-content2 dark:hover:bg-content2 cursor-pointer transition-transform-background motion-reduce:transition-none active:scale-[0.97] tap-highlight-transparent w-full h-full border border-default-200'

const EXTERNAL_LINK_CLASS_NAME =
  'relative inline-flex items-center tap-highlight-transparent outline-hidden focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2 text-medium text-primary no-underline hover:opacity-hover active:opacity-disabled transition-opacity'

export const KunFriendLink = () => {
  return (
    <div className="container mx-auto my-8">
      <h1 className="mb-4 text-4xl text-center text-primary-500">友情链接</h1>
      <p className="mb-12 text-center text-default-500">
        下方是我们的友站, 您可以点击以访问这些网站
      </p>

      <div className="grid grid-cols-2 gap-2 sm:gap-6 md:grid-cols-3 lg:grid-cols-4">
        {kunFriends.map((friend) => (
          // 只写 noopener 不写 noreferrer: 保留 Referer 让友站能看到来自本站的流量;
          // 该规则防的是不认识 noopener 的老浏览器, 现代浏览器 target=_blank 已隐含 noopener
          // eslint-disable-next-line react/jsx-no-target-blank
          <a
            key={friend.name}
            href={friend.link}
            target="_blank"
            rel="noopener"
            className={FRIEND_CARD_CLASS_NAME}
          >
            <div className="relative flex w-full flex-auto flex-col place-content-inherit align-items-inherit h-auto break-words text-left subpixel-antialiased p-0 overflow-visible">
              <div className="flex justify-center w-full pt-4">
                {/* 有宽高的 img 加载失败时即使 alt="" 也显示破图图标, 背景图失败只留空白 */}
                <div
                  className="w-24 h-24 rounded-lg bg-center bg-cover"
                  style={{ backgroundImage: `url("${friend.avatar}")` }}
                />
              </div>
            </div>
            {/* text-center 补回原 <button> 的 UA 默认居中 */}
            <div className="p-3 h-auto w-full overflow-hidden color-inherit subpixel-antialiased rounded-b-large flex flex-col items-center pt-4 pb-6 text-center">
              <h4 className="font-bold text-large">{friend.name}</h4>
              <p className="mt-1 text-sm text-center text-default-500 line-clamp-4">
                {friend.label}
              </p>
            </div>
          </a>
        ))}
      </div>

      <div className="mt-16">
        <h2 className="mb-4 text-2xl text-center text-default-800">加入我们</h2>
        <p className="mb-12 text-center text-default-500">
          要加入我们, 请加入我们的{' '}
          <a
            href={kunMoyuMoe.domain.discord_group}
            target="_blank"
            rel="noopener noreferrer"
            className={EXTERNAL_LINK_CLASS_NAME}
          >
            Discord 服务器
            <ExternalLink
              className="flex mx-1 text-current self-center"
              size="1em"
              strokeWidth={1.5}
            />
          </a>
          联系我们
        </p>
      </div>
    </div>
  )
}
