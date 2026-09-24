import { TagCard } from './Card'
import { KunNull } from '~/components/kun/Null'
import { KunLoading } from '~/components/kun/Loading'
import type { Tag as TagType } from '~/types/api/tag'
import { useSettingStore } from '~/store/settingStore'

interface TagListProps {
  tags: TagType[]
  loading: boolean
  searching: boolean
}

export const TagList = ({ tags, loading, searching }: TagListProps) => {
  const settings = useSettingStore((state) => state.data)
  const isNSFWEnabled =
    settings.kunNsfwEnable === 'nsfw' || settings.kunNsfwEnable === 'all'

  if (loading) {
    return <KunLoading hint="正在获取标签数据..." />
  }

  if (!searching && tags.length === 0) {
    return (
      <KunNull
        message={
          isNSFWEnabled
            ? '您已启用显示 NSFW 内容, 但未找到相关内容, 请尝试使用游戏的日文原名搜索'
            : '未找到相关内容, 请尝试使用游戏的日文原名搜索或打开 NSFW'
        }
      />
    )
  }

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(256px,100%),1fr))] gap-4">
      {tags.map((tag) => (
        <TagCard key={tag.id} tag={tag} />
      ))}
    </div>
  )
}
