'use client'

import { useEffect, useRef, useState } from 'react'
import { Card, CardBody } from '@heroui/card'
import { Button } from '@heroui/button'
import { Pagination } from '@heroui/pagination'
import { Divider } from '@heroui/divider'
import { Chip } from '@heroui/chip'
import { Tooltip } from '@heroui/tooltip'
import { KunUser } from '~/components/kun/floating-card/KunUser'
import { MessageCircle, PenLine } from 'lucide-react'
import { kunFetchGet } from '~/utils/kunFetch'
import { KunTimeAgo } from '~/components/kun/TimeAgo'
import { PublishComment } from './PublishComment'
import { CommentLikeButton } from './CommentLike'
import { CommentDropdown } from './CommentDropdown'
import { removeComment } from './removeComment'
import { CommentContent } from './CommentContent'
import { CommentReplyPager } from './CommentReplyPager'
import {
  REPLY_LAST_PAGE,
  getVisibleReplies,
  locateReplyViews,
  type ReplyViewMap
} from './replyPagination'
import { useUserStore } from '~/store/userStore'
import { KunNull } from '~/components/kun/Null'
import toast from 'react-hot-toast'
import type { PatchComment, PatchCommentResponse } from '~/types/api/patch'

interface Props {
  id: number
  resourceId?: number
  // 深链 ?commentId=, 由页面解析后传入; 本组件不订阅 URL, 以免随 ?tab= 等变化重渲染
  targetCommentId: number | null
}

const COMMENTS_PER_PAGE = 30

export const Comments = ({ id, resourceId, targetCommentId }: Props) => {
  const [comments, setComments] = useState<PatchComment[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [replyTo, setReplyTo] = useState<{
    commentId: number
    username: string
  } | null>(null)
  const [loading, setLoading] = useState(false)
  const [showEditor, setShowEditor] = useState(false)
  const [highlightedCommentId, setHighlightedCommentId] = useState<
    number | null
  >(null)
  // 各楼的楼中楼折叠 / 回复页状态; 换页重新拉取后归零
  const [replyViews, setReplyViews] = useState<ReplyViewMap>({})
  const user = useUserStore((state) => state.user)
  const requestIdRef = useRef(0)
  // 已定位过的深链 commentId: 同一 commentId 只定位一次, 之后翻页不再带 locate
  const locatedCommentIdRef = useRef<number | null>(null)
  // 定位响应跨页时由 setPage 同步页码, 数据已是该页, 紧随其后的那次拉取 effect 跳过
  const skipNextFetchRef = useRef(false)
  // 已滚动定位过的深链 commentId: 同一目标只滚一次, 否则之后翻回该页、发评论或删评论
  // 都会把页面拽回目标评论 (详情页 tab 保活后目标会一直留在 props 里)
  const scrolledCommentIdRef = useRef<number | null>(null)
  // 自己刚发出的回复: 等它随 comments 提交进 DOM 后滚到可见
  const postedReplyIdRef = useRef<number | null>(null)

  const fetchComments = async (
    pageNum: number,
    locateCommentId?: number | null
  ) => {
    const requestId = ++requestIdRef.current
    setLoading(true)
    try {
      const res = await kunFetchGet<PatchCommentResponse>('/patch/comment', {
        patchId: Number(id),
        ...(resourceId ? { resourceId } : {}),
        page: pageNum,
        limit: COMMENTS_PER_PAGE,
        ...(locateCommentId ? { commentId: locateCommentId } : {})
      })
      if (requestId !== requestIdRef.current) {
        return
      }
      if (res && typeof res !== 'string') {
        setComments(res.comments)
        setTotal(res.total)
        // 深链指向被折叠的回复时, 直接展开到它所在的回复页, 否则定位 effect 找不到元素
        setReplyViews(
          locateCommentId ? locateReplyViews(res.comments, locateCommentId) : {}
        )
        if (res.currentPage !== pageNum) {
          skipNextFetchRef.current = true
          setPage(res.currentPage)
        }
      }
    } catch {
      if (requestId === requestIdRef.current) {
        toast.error('获取评论失败, 请稍后重试')
      }
    } finally {
      if (requestId === requestIdRef.current) {
        // 失败也记为已定位: 深链只尝试一次, 不能劫持用户随后的手动翻页
        if (locateCommentId) {
          locatedCommentIdRef.current = locateCommentId
        }
        setLoading(false)
      }
    }
  }

  useEffect(() => {
    const skipFetch = skipNextFetchRef.current
    skipNextFetchRef.current = false
    if (!user.uid || skipFetch) {
      return
    }
    fetchComments(
      page,
      targetCommentId && locatedCommentIdRef.current !== targetCommentId
        ? targetCommentId
        : null
    )
  }, [page, user.uid, targetCommentId])

  useEffect(() => {
    if (
      loading ||
      !targetCommentId ||
      scrolledCommentIdRef.current === targetCommentId
    ) {
      return
    }

    const targetElement = document.getElementById(`comment-${targetCommentId}`)
    if (!targetElement) {
      // 定位请求已结束而目标仍不在 DOM (请求失败、目标已删或不属于本评论区): 就此放弃。
      // 否则之后点赞、发评、删评改动 comments 时, 目标一旦恰好进了 DOM
      // (用户自己翻到它所在的回复页), 页面会被突然拽过去
      if (locatedCommentIdRef.current === targetCommentId) {
        scrolledCommentIdRef.current = targetCommentId
      }
      return
    }

    scrolledCommentIdRef.current = targetCommentId
    targetElement.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setHighlightedCommentId(targetCommentId)
  }, [comments, loading, targetCommentId])

  // 高亮计时独立于定位 effect: 后者重跑时会提前返回, 不能靠它的 cleanup 清计时器
  useEffect(() => {
    if (highlightedCommentId === null) {
      return
    }

    const timer = window.setTimeout(() => setHighlightedCommentId(null), 3000)
    return () => window.clearTimeout(timer)
  }, [highlightedCommentId])

  useEffect(() => {
    const postedReplyId = postedReplyIdRef.current
    if (postedReplyId === null) {
      return
    }

    postedReplyIdRef.current = null
    document
      .getElementById(`comment-${postedReplyId}`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [comments])

  const handleNewComment = async (newComment: PatchComment) => {
    if (newComment.parentId === null) {
      setComments((prev) => [newComment, ...prev])
      setTotal((prev) => prev + 1)
    } else {
      // 新回复按时间排在楼内末尾: 展开到末页并滚到可见,
      // 否则它会落进折叠区或别的回复页, 发完就看不到
      const rootId = newComment.parentId
      setReplyViews((prev) => ({
        ...prev,
        [rootId]: { expanded: true, page: REPLY_LAST_PAGE }
      }))
      postedReplyIdRef.current = newComment.id
      setComments((prev) =>
        prev.map((comment) => {
          if (comment.id === newComment.parentId) {
            return {
              ...comment,
              reply: [...comment.reply, newComment]
            }
          }
          return comment
        })
      )
    }
    setReplyTo(null)
  }

  const handleDeletedComment = (deleted: PatchComment) => {
    setComments((prev) => removeComment(prev, deleted.id))
    if (deleted.parentId !== null) {
      return
    }
    setTotal((prev) => Math.max(0, prev - 1))
    // 删掉的是本页最后一条根评论且不在首页: 退回上一页由 page effect 重新拉取,
    // 否则 totalPages 降到 1 后分页控件整体隐藏, 用户困在空页
    if (page > 1 && comments.length === 1) {
      setPage(page - 1)
    }
  }

  const handlePageChange = (newPage: number) => {
    setPage(newPage)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  if (!user.uid) {
    return <KunNull message="请登录后查看评论" />
  }

  const totalPages = Math.ceil(total / COMMENTS_PER_PAGE)

  return (
    <div className="space-y-4">
      {showEditor ? (
        <PublishComment
          patchId={id}
          resourceId={resourceId}
          receiverUsername={null}
          setNewComment={(newComment) => {
            handleNewComment(newComment)
            setShowEditor(false)
          }}
          onCancel={() => setShowEditor(false)}
        />
      ) : (
        <div className="flex justify-end">
          <Button
            color="primary"
            variant="flat"
            startContent={<PenLine className="size-4" />}
            onPress={() => setShowEditor(true)}
          >
            发布评论
          </Button>
        </div>
      )}

      {loading && <KunNull message="加载中..." />}

      {!loading &&
        comments.map((comment) => (
          <Card
            key={comment.id}
            id={`comment-${comment.id}`}
            className={
              highlightedCommentId === comment.id
                ? 'ring-2 ring-primary ring-offset-2 ring-offset-background'
                : undefined
            }
          >
            <CardBody className="space-y-3">
              <div className="space-y-2">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <KunUser
                      user={comment.user}
                      userProps={{
                        name: comment.user.name,
                        description: <KunTimeAgo date={comment.created} />,
                        avatarProps: {
                          showFallback: true,
                          name: comment.user.name,
                          src: comment.user.avatar
                        }
                      }}
                    />
                    {comment.status === 1 && (
                      <Tooltip content="审核中，仅你和管理员可见">
                        <Chip color="warning" variant="flat" size="sm">
                          待审核
                        </Chip>
                      </Tooltip>
                    )}
                  </div>
                  <CommentDropdown
                    comment={comment}
                    setComments={setComments}
                    onDeleted={handleDeletedComment}
                  />
                </div>

                <CommentContent comment={comment} />

                <div className="flex gap-2">
                  <CommentLikeButton
                    comment={comment}
                    setComments={setComments}
                    isDisabled={comment.status === 1}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="gap-2"
                    isDisabled={comment.status === 1}
                    onPress={() =>
                      setReplyTo(
                        replyTo?.commentId === comment.id
                          ? null
                          : {
                              commentId: comment.id,
                              username: comment.user.name
                            }
                      )
                    }
                  >
                    <MessageCircle className="size-4" />
                    回复
                  </Button>
                </div>
              </div>

              {comment.reply.length > 0 && (
                <>
                  <Divider />
                  <div
                    id={`comment-replies-${comment.id}`}
                    className="space-y-4 pl-4 scroll-mt-20"
                  >
                    {getVisibleReplies(
                      comment.reply,
                      replyViews[comment.id],
                      replyTo?.commentId
                    ).map((reply) => (
                      <div
                        key={reply.id}
                        id={`comment-${reply.id}`}
                        className={
                          highlightedCommentId === reply.id
                            ? 'space-y-2 scroll-mt-20 rounded-large ring-2 ring-primary ring-offset-2 ring-offset-background'
                            : 'space-y-2 scroll-mt-20'
                        }
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex items-center gap-2">
                            <KunUser
                              user={reply.user}
                              userProps={{
                                name: reply.user.name,
                                description: reply.replyToUser ? (
                                  <>
                                    回复了 @{reply.replyToUser.name} ·{' '}
                                    <KunTimeAgo date={reply.created} />
                                  </>
                                ) : (
                                  <KunTimeAgo date={reply.created} />
                                ),
                                avatarProps: {
                                  showFallback: true,
                                  name: reply.user.name,
                                  src: reply.user.avatar,
                                  size: 'sm'
                                }
                              }}
                            />
                            {reply.status === 1 && (
                              <Tooltip content="审核中，仅你和管理员可见">
                                <Chip color="warning" variant="flat" size="sm">
                                  待审核
                                </Chip>
                              </Tooltip>
                            )}
                          </div>
                          <CommentDropdown
                            comment={reply}
                            setComments={setComments}
                            onDeleted={handleDeletedComment}
                          />
                        </div>

                        <CommentContent comment={reply} />

                        <div className="flex gap-2">
                          <CommentLikeButton
                            comment={reply}
                            setComments={setComments}
                            isDisabled={reply.status === 1}
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            className="gap-2"
                            isDisabled={reply.status === 1}
                            onPress={() =>
                              setReplyTo(
                                replyTo?.commentId === reply.id
                                  ? null
                                  : {
                                      commentId: reply.id,
                                      username: reply.user.name
                                    }
                              )
                            }
                          >
                            <MessageCircle className="size-4" />
                            回复
                          </Button>
                        </div>

                        {replyTo?.commentId === reply.id && (
                          <div className="mt-2">
                            <PublishComment
                              patchId={id}
                              resourceId={resourceId}
                              parentId={reply.id}
                              receiverUsername={replyTo.username}
                              onSuccess={() => setReplyTo(null)}
                              setNewComment={(newComment) => {
                                handleNewComment({
                                  ...newComment,
                                  parentId: comment.id,
                                  replyToUser: reply.user
                                })
                              }}
                            />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                  <CommentReplyPager
                    listId={`comment-replies-${comment.id}`}
                    label={`${comment.user.name} 的评论的回复分页`}
                    replyCount={comment.reply.length}
                    view={replyViews[comment.id]}
                    onChange={(view) =>
                      setReplyViews((prev) => ({ ...prev, [comment.id]: view }))
                    }
                  />
                </>
              )}

              {replyTo?.commentId === comment.id && (
                <div className="mt-2 pl-4">
                  <PublishComment
                    patchId={id}
                    resourceId={resourceId}
                    parentId={comment.id}
                    receiverUsername={replyTo.username}
                    onSuccess={() => setReplyTo(null)}
                    setNewComment={handleNewComment}
                  />
                </div>
              )}
            </CardBody>
          </Card>
        ))}

      {!loading && comments.length === 0 && (
        <KunNull message="暂无评论，来发表第一条评论吧" />
      )}

      {totalPages > 1 && (
        <div className="flex justify-center mt-4">
          <Pagination
            total={totalPages}
            page={page}
            onChange={handlePageChange}
            showControls
            isDisabled={loading}
          />
        </div>
      )}
    </div>
  )
}
