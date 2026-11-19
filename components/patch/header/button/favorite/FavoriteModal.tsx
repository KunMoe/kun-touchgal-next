'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import {
  Button,
  Chip,
  Modal,
  ModalBody,
  ModalContent,
  Pagination,
  Skeleton
} from '@heroui/react'
import { Folder } from 'lucide-react'
import { kunFetchGet, kunFetchPut } from '~/utils/kunFetch'
import toast from 'react-hot-toast'
import { kunErrorHandler } from '~/utils/kunErrorHandler'
import { EditFolderModal } from '~/components/user/favorite/EditFolderModal'
import type { UserFavoritePatchFolder } from '~/types/api/user'

const LIMIT = 5

interface Props {
  patchId: number
  isOpen: boolean
  onClose: () => void
  onFavoriteChange: (isFavorite: boolean) => void
}

export const FavoriteModal = ({
  patchId,
  isOpen,
  onClose,
  onFavoriteChange
}: Props) => {
  const [folders, setFolders] = useState<UserFavoritePatchFolder[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [isFetching, setIsFetching] = useState(false)
  const [isPending, startTransition] = useTransition()
  const fetchSeqRef = useRef(0)

  const fetchFolders = async (currentPage: number) => {
    const seq = ++fetchSeqRef.current
    setIsFetching(true)
    try {
      const response = await kunFetchGet<{
        folders: UserFavoritePatchFolder[]
        total: number
      }>('/user/profile/favorite/folder', {
        patchId,
        page: currentPage,
        limit: LIMIT
      })
      if (seq !== fetchSeqRef.current) return
      kunErrorHandler(response, (value) => {
        setFolders(value.folders)
        setTotal(value.total)
      })
    } finally {
      if (seq === fetchSeqRef.current) {
        setIsFetching(false)
      }
    }
  }

  useEffect(() => {
    if (isOpen) {
      setPage(1)
      fetchFolders(1)
    }
  }, [isOpen])

  const handlePageChange = (newPage: number) => {
    setPage(newPage)
    fetchFolders(newPage)
  }

  const handleAddToFolder = async (folderId: number) => {
    startTransition(async () => {
      const res = await kunFetchPut<
        KunResponse<{ added: boolean; isFavorite: boolean }>
      >(`/patch/favorite`, { patchId, folderId })
      kunErrorHandler(res, (value) => {
        toast.success(value.added ? '收藏成功' : '取消收藏成功')
        onFavoriteChange(value.isFavorite)
        fetchFolders(page)
      })
    })
  }

  const totalPages = Math.ceil(total / LIMIT)

  return (
    <Modal isOpen={isOpen} onClose={onClose}>
      <ModalContent>
        <ModalBody className="py-6">
          <div className="space-y-4">
            <h2>
              <p className="text-lg font-bold">添加到收藏夹</p>
              <p className="text-sm text-default-500">
                点击文件夹收藏, 再次点击取消收藏
              </p>
            </h2>

            <EditFolderModal
              action="create"
              onActionSuccess={() => fetchFolders(page)}
            />

            {isFetching
              ? Array.from({ length: LIMIT }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full rounded-xl" />
                ))
              : folders.map((folder) => (
                  <Button
                    key={folder.id}
                    startContent={<Folder className="w-4 h-4" />}
                    variant="bordered"
                    fullWidth
                    className="justify-between"
                    onPress={() => handleAddToFolder(folder.id)}
                    isLoading={isPending}
                    isDisabled={isPending}
                  >
                    <span>{folder.name}</span>
                    <Chip size="sm">
                      {folder.isAdd
                        ? '本游戏已添加'
                        : `${folder._count.patch} 个游戏`}
                    </Chip>
                  </Button>
                ))}

            {totalPages > 1 && (
              <div className="flex justify-center">
                <Pagination
                  total={totalPages}
                  page={page}
                  onChange={handlePageChange}
                  isDisabled={isFetching || isPending}
                  size="sm"
                />
              </div>
            )}
          </div>
        </ModalBody>
      </ModalContent>
    </Modal>
  )
}

export default FavoriteModal
