'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDebounce } from 'use-debounce'
import { Card, CardBody, CardHeader } from '@heroui/card'
import { Chip } from '@heroui/chip'
import { Input } from '@heroui/input'
import { Listbox, ListboxItem } from '@heroui/listbox'
import { Search } from 'lucide-react'
import toast from 'react-hot-toast'
import { kunFetchDelete, kunFetchGet, kunFetchPost } from '~/utils/kunFetch'
import { useUserStore } from '~/store/userStore'
import { patchKunUser } from '~/store/session'
import type { Tag } from '~/types/api/tag'

interface UpdateBlockedTagResponse {
  blockedTagIds: number[]
}

interface DropdownRect {
  top: number
  left: number
  width: number
}

interface BlockedTagsProps {
  isActive?: boolean
}

export const BlockedTags = ({ isActive = true }: BlockedTagsProps) => {
  const user = useUserStore((state) => state.user)
  const [blockedTags, setBlockedTags] = useState<Tag[]>([])
  const [loading, setLoading] = useState(false)
  const [updatingId, setUpdatingId] = useState(0)

  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedQuery] = useDebounce(searchQuery, 300)
  const [searchResults, setSearchResults] = useState<Tag[]>([])
  const [searching, setSearching] = useState(false)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [dropdownRect, setDropdownRect] = useState<DropdownRect | null>(null)

  const inputWrapperRef = useRef<HTMLDivElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const syncBlockedTags = async () => {
    if (!user.uid) {
      return
    }
    setLoading(true)
    try {
      const response = await kunFetchGet<KunResponse<Tag[]>>(
        '/user/setting/blocked-tag'
      )
      if (typeof response === 'string') {
        toast.error(response)
      } else {
        setBlockedTags(response)
      }
    } catch {
      toast.error('读取屏蔽标签失败, 请稍后重试')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    syncBlockedTags()
  }, [user.uid])

  const updateDropdownRect = () => {
    if (!inputWrapperRef.current) return
    const rect = inputWrapperRef.current.getBoundingClientRect()
    setDropdownRect({
      top: rect.bottom,
      left: rect.left,
      width: rect.width
    })
  }

  useEffect(() => {
    if (!isActive) {
      setDropdownOpen(false)
    }
  }, [isActive])

  useEffect(() => {
    if (!isActive) {
      setDropdownOpen(false)
      return
    }
    if (!debouncedQuery.trim()) {
      setSearchResults([])
      setDropdownOpen(false)
      return
    }
    const query = debouncedQuery
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 10)
    setSearching(true)
    updateDropdownRect()
    setDropdownOpen(true)
    kunFetchPost<KunResponse<Tag[]>>('/tag/search', { query })
      .then((res) => {
        if (typeof res === 'string') {
          toast.error(res)
        } else {
          setSearchResults(res)
        }
      })
      .catch(() => toast.error('搜索标签失败, 请稍后重试'))
      .finally(() => setSearching(false))
  }, [debouncedQuery, isActive])

  useEffect(() => {
    if (!dropdownOpen) return

    let frame = 0
    const handlePositionChange = () => {
      if (frame) return

      frame = window.requestAnimationFrame(() => {
        frame = 0
        updateDropdownRect()
      })
    }

    window.addEventListener('scroll', handlePositionChange, { passive: true })
    window.addEventListener('resize', handlePositionChange)
    return () => {
      window.removeEventListener('scroll', handlePositionChange)
      window.removeEventListener('resize', handlePositionChange)
      if (frame) {
        window.cancelAnimationFrame(frame)
      }
    }
  }, [dropdownOpen])

  useEffect(() => {
    if (!dropdownOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node
      const isInsideInput = inputWrapperRef.current?.contains(target)
      const isInsideDropdown = dropdownRef.current?.contains(target)

      if (!isInsideInput && !isInsideDropdown) {
        setDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [dropdownOpen])

  const handleBlockTag = async (tag: Tag) => {
    if (!user.uid || updatingId) return

    setUpdatingId(tag.id)
    try {
      const response = await kunFetchPost<
        KunResponse<UpdateBlockedTagResponse>
      >('/user/setting/blocked-tag', { tagId: tag.id })
      if (typeof response === 'string') {
        toast.error(response)
        return
      }

      patchKunUser({ blockedTagIds: response.blockedTagIds })
      setBlockedTags((prev) => [...prev, tag])
      setSearchQuery('')
      setSearchResults([])
      setDropdownOpen(false)
      toast.success(`已屏蔽标签「${tag.name}」`)
    } catch {
      toast.error('屏蔽标签失败, 请稍后重试')
    } finally {
      setUpdatingId(0)
    }
  }

  const handleUnblockTag = async (tag: Tag) => {
    if (!user.uid || updatingId) return

    setUpdatingId(tag.id)
    try {
      const response = await kunFetchDelete<
        KunResponse<UpdateBlockedTagResponse>
      >('/user/setting/blocked-tag', { tagId: tag.id })
      if (typeof response === 'string') {
        toast.error(response)
        return
      }

      patchKunUser({ blockedTagIds: response.blockedTagIds })
      setBlockedTags((prev) => prev.filter((item) => item.id !== tag.id))
      toast.success(`已取消屏蔽标签「${tag.name}」`)
    } catch {
      toast.error('取消屏蔽标签失败, 请稍后重试')
    } finally {
      setUpdatingId(0)
    }
  }

  const filteredResults = searchResults.filter(
    (tag) => !user.blockedTagIds.includes(tag.id)
  )

  const dropdown =
    dropdownOpen && dropdownRect
      ? createPortal(
          <div
            ref={dropdownRef}
            style={{
              position: 'fixed',
              top: dropdownRect.top + 4,
              left: dropdownRect.left,
              width: dropdownRect.width,
              zIndex: 9999
            }}
            className="rounded-medium border border-default-200 bg-content1 shadow-medium dark:border-default-100"
          >
            {searching ? (
              <p className="px-3 py-2 text-xs text-default-400">正在搜索...</p>
            ) : filteredResults.length ? (
              <Listbox
                aria-label="标签搜索结果"
                classNames={{
                  list: 'max-h-60 overflow-y-auto scrollbar-hide'
                }}
                onAction={(key) => {
                  const tag = filteredResults.find((t) => String(t.id) === key)
                  if (tag) handleBlockTag(tag)
                }}
              >
                {filteredResults.map((tag) => (
                  <ListboxItem
                    key={String(tag.id)}
                    textValue={tag.name}
                    className="min-h-11"
                    isDisabled={!!updatingId}
                    endContent={
                      <span className="text-xs text-default-400">
                        {tag.count} 个游戏
                      </span>
                    }
                  >
                    {tag.name}
                  </ListboxItem>
                ))}
              </Listbox>
            ) : (
              <p className="px-3 py-2 text-xs text-default-400">
                未找到可添加的相关标签
              </p>
            )}
          </div>,
          document.body
        )
      : null

  return (
    <Card className="w-full overflow-hidden rounded-[22px] border border-default-200/60 bg-background text-sm shadow-[0_12px_32px_rgba(15,23,42,0.05)] dark:bg-content1 dark:shadow-[0_12px_32px_rgba(0,0,0,0.15)]">
      <CardHeader className="flex-col items-start gap-1 px-5 pb-0 pt-5">
        <h2 className="text-xl font-semibold text-foreground">标签屏蔽</h2>
        <p className="max-w-2xl leading-6 text-default-500">
          屏蔽某个标签后，带有该标签的游戏将不会出现在公开列表中。
        </p>
      </CardHeader>

      <CardBody className="space-y-5 overflow-visible px-5 py-4">
        <div className="space-y-2">
          <div>
            <p className="font-medium text-foreground">添加屏蔽标签</p>
            <p className="mt-1 leading-6 text-default-500">
              搜索标签名称，点按搜索结果即可加入屏蔽名单。
            </p>
          </div>
          <div ref={inputWrapperRef}>
            <Input
              value={searchQuery}
              onValueChange={(v) => {
                setSearchQuery(v)
                if (v.trim()) {
                  updateDropdownRect()
                  setDropdownOpen(true)
                } else {
                  setDropdownOpen(false)
                }
              }}
              onFocus={() => {
                if (searchQuery.trim() && filteredResults.length) {
                  updateDropdownRect()
                  setDropdownOpen(true)
                }
              }}
              aria-label="搜索标签"
              placeholder="输入标签名称"
              startContent={<Search className="size-4 text-default-400" />}
              isClearable
              onClear={() => {
                setSearchQuery('')
                setSearchResults([])
                setDropdownOpen(false)
              }}
            />
          </div>
          {dropdown}
        </div>

        <div className="space-y-3 rounded-2xl border border-default-200 bg-default-50/70 p-4 dark:bg-default-100/10">
          <p className="font-medium text-foreground">已屏蔽标签</p>
          {loading ? (
            <p className="text-default-500">正在加载已屏蔽标签...</p>
          ) : blockedTags.length ? (
            <div className="flex flex-wrap gap-2">
              {blockedTags.map((tag) => (
                <Chip
                  key={tag.id}
                  color="danger"
                  variant="flat"
                  isDisabled={!!updatingId}
                  onClose={() => handleUnblockTag(tag)}
                >
                  {tag.name}
                </Chip>
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-default-300 bg-content1/60 p-4 text-default-500">
              您暂时没有屏蔽任何标签。
            </div>
          )}
        </div>

        <p className="leading-6 text-default-400">
          点按已屏蔽标签上的关闭按钮可取消屏蔽。
        </p>
      </CardBody>
    </Card>
  )
}
