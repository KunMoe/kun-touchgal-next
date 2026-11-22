'use client'

import { useState, useTransition } from 'react'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  useDisclosure
} from '@heroui/react'
import { Folder } from 'lucide-react'
import { kunFetchDelete, kunFetchGet } from '~/utils/kunFetch'
import { errorReporter, kunErrorHandler } from '~/utils/kunErrorHandler'
import { EditFolderModal } from './EditFolderModal'
import { UserGalgameCard } from './Card'
import { KunLoading } from '~/components/kun/Loading'
import { KunListError } from '~/components/kun/ListError'
import { KunNull } from '~/components/kun/Null'
import toast from 'react-hot-toast'
import { KunPagination } from '~/components/kun/Pagination'
import { useKunPagedList } from '~/hooks/useKunPagedList'
import type { UserFavoritePatchFolder } from '~/types/api/user'

interface Props {
  initialFolders: UserFavoritePatchFolder[]
  pageUid: number
  currentUserUid: number
}

interface FavoriteQuery {
  page: number
  limit: number
  folderId: number
}

const fetchFolderPatchPage = async (query: FavoriteQuery) => {
  const res = await kunFetchGet<
    KunResponse<{ patches: GalgameCard[]; total: number }>
  >(`/user/profile/favorite/folder/patch`, {
    folderId: query.folderId,
    page: query.page,
    limit: query.limit
  })
  return typeof res === 'string'
    ? res
    : { items: res.patches, total: res.total }
}

export const UserFavorite = ({
  initialFolders,
  pageUid,
  currentUserUid
}: Props) => {
  const [folders, setFolders] =
    useState<UserFavoritePatchFolder[]>(initialFolders)
  const [selectedFolder, setSelectedFolder] =
    useState<UserFavoritePatchFolder | null>(null)
  // folderId 在查询里: 切换收藏夹后上一夹的作品不会留在新夹的标题下 (P29-05)
  const list = useKunPagedList<GalgameCard, FavoriteQuery>({
    // 0 不是任何收藏夹的 id, 第一次点开收藏夹必然换查询
    query: { page: 1, limit: 48, folderId: 0 },
    getId: (galgame) => galgame.id,
    // 移除收藏后: 本页删空且不在第 1 页时退一页, 否则存在下一页时静默补齐本页
    // (只删本地并递减 total 的话, 删掉末页唯一的一条会停在超出总页数的页码上)
    afterRemove: 'refillIfNext',
    // 选中收藏夹之前不取数
    enabled: selectedFolder !== null,
    fetchPage: fetchFolderPatchPage
  })
  const loading = list.status === 'loading'
  // 只给删除收藏夹的按钮用
  const [isPending, startTransition] = useTransition()

  const {
    isOpen: isOpenFolder,
    onOpen: onOpenFolder,
    onClose: onCloseFolder
  } = useDisclosure()

  const {
    isOpen: isOpenDelete,
    onOpen: onOpenDelete,
    onClose: onCloseDelete
  } = useDisclosure()
  const handleDeleteFolder = async () => {
    startTransition(async () => {
      try {
        const res = await kunFetchDelete<KunResponse<{}>>(
          `/user/profile/favorite/folder`,
          { folderId: selectedFolder?.id ?? 0 }
        )
        kunErrorHandler(res, () => {
          setFolders((prev) => prev.filter((p) => p.id !== selectedFolder?.id))
          onCloseDelete()
          onCloseFolder()
          toast.success('删除收藏夹成功')
        })
      } catch (error) {
        errorReporter(error)
      }
    })
  }

  const handlePressFolderCard = (folder: UserFavoritePatchFolder) => {
    setSelectedFolder(folder)
    if (folder.id !== list.query.folderId) {
      list.setQuery({ folderId: folder.id })
    } else if (list.query.page !== 1) {
      list.setPage(1)
    } else {
      // 再次点开同一个收藏夹也重取第 1 页
      list.refresh()
    }
    onOpenFolder()
  }

  const onRemoveFavorite = (patchId: number) => {
    list.removeLocal([patchId])
  }

  const onEditFolderSuccess = (updatedFolder: UserFavoritePatchFolder) => {
    setSelectedFolder(updatedFolder)
    setFolders((prev) =>
      prev.map((folder) =>
        folder.id === updatedFolder.id ? updatedFolder : folder
      )
    )
  }

  return (
    <div>
      <div className="flex min-h-10 items-center justify-between mb-6">
        <span className="text-small text-default-500">
          共 {folders.length} 个收藏夹
        </span>
        {currentUserUid === pageUid && (
          <EditFolderModal
            action="create"
            onActionSuccess={(value) => setFolders([...folders, value])}
          />
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {folders.map((folder) => (
          <Card
            key={folder.id}
            isPressable
            onPress={() => handlePressFolderCard(folder)}
            className={selectedFolder?.id === folder.id ? 'border-primary' : ''}
          >
            <CardHeader className="flex justify-between">
              <div className="flex items-center gap-2">
                <Folder className="w-4 h-4" />
                <span className="font-semibold">{folder.name}</span>
              </div>
            </CardHeader>
            <CardBody className="justify-between gap-2">
              <p className="text-small text-default-500 line-clamp-2">
                {folder.description}
              </p>
              <div className="flex items-center justify-between">
                <span className="text-small">
                  {folder._count.patch} 个 Galgame
                </span>
                {folder.is_public ? (
                  <span className="text-small text-primary">公开</span>
                ) : (
                  <span className="text-small text-danger">私密</span>
                )}
              </div>
            </CardBody>
          </Card>
        ))}
      </div>

      {!folders.length && (
        <KunNull
          message={
            currentUserUid === pageUid
              ? '您还没有收藏夹, 点击右上角按钮创建一个吧'
              : '这个孩子还没有公开的收藏夹哦'
          }
        />
      )}

      <Modal
        size="5xl"
        scrollBehavior="inside"
        isOpen={isOpenFolder}
        onClose={onCloseFolder}
      >
        {selectedFolder && (
          <ModalContent>
            <ModalHeader className="flex-col">
              <div className="flex items-center justify-between">
                <p>{selectedFolder.name}</p>
              </div>

              <p className="font-normal text-small text-default-500">
                {selectedFolder.description}
              </p>
            </ModalHeader>

            <ModalBody>
              <div className="space-y-3 min-h-72">
                {loading ? (
                  <KunLoading hint="正在获取收藏数据..." />
                ) : list.status === 'error' ? (
                  <KunListError
                    message={list.error ?? ''}
                    onRetry={() => list.refresh()}
                  />
                ) : (
                  <div className="grid grid-cols-2 gap-2 sm:gap-6 lg:grid-cols-3 xl:grid-cols-4">
                    {list.items.map((galgame) => (
                      <UserGalgameCard
                        key={galgame.id}
                        galgame={galgame}
                        folderId={selectedFolder.id}
                        onRemoveFavorite={onRemoveFavorite}
                        pageUid={pageUid}
                        currentUserUid={currentUserUid}
                      />
                    ))}
                  </div>
                )}

                {list.status === 'ready' && !list.items.length && (
                  <KunNull message="收藏夹为空" />
                )}

                {!loading && (
                  <div className="flex justify-center">
                    <KunPagination
                      total={Math.ceil(list.total / 48)}
                      page={list.query.page}
                      onPageChange={list.setPage}
                      isLoading={loading}
                      disableScrollToTop
                    />
                  </div>
                )}
              </div>
            </ModalBody>

            {currentUserUid === pageUid && (
              <ModalFooter>
                <Button color="danger" variant="light" onPress={onOpenDelete}>
                  删除
                </Button>
                <EditFolderModal
                  action="update"
                  folderId={selectedFolder.id}
                  folder={selectedFolder}
                  onActionSuccess={onEditFolderSuccess}
                />
              </ModalFooter>
            )}
          </ModalContent>
        )}
      </Modal>

      <Modal isOpen={isOpenDelete} onClose={onCloseDelete} placement="center">
        <ModalContent>
          <ModalHeader className="flex flex-col gap-1">删除收藏夹</ModalHeader>
          <ModalBody>
            您确定要删除这个收藏夹吗, 这将会彻底删除收藏夹,
            并移除所有收藏夹中收藏的游戏, 该操作不可撤销
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={onCloseDelete}>
              取消
            </Button>
            <Button
              color="danger"
              onPress={handleDeleteFolder}
              disabled={isPending}
              isLoading={isPending}
            >
              删除
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  )
}
