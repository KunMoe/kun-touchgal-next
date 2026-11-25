'use client'

import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { useShallow } from 'zustand/react/shallow'
import {
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Select,
  SelectItem,
  Textarea,
  useDisclosure
} from '@heroui/react'
import { Edit2 } from 'lucide-react'
import { USER_STATUS_MAP } from '~/constants/user'
import { KUN_ROLE_LABEL } from '~/constants/role'
import { canAssignRole, isSuperAdminRole } from '~/constants/permission'
import { kunFetchPost, kunFetchPut } from '~/utils/kunFetch'
import { errorReporter, kunErrorHandler } from '~/utils/kunErrorHandler'
import { useUserStore } from '~/store/userStore'
import type { AdminUser, AdminUserPatchResult } from '~/types/api/admin'

interface Props {
  initialUser: AdminUser
  onUpdated?: (user: AdminUser) => void
}

const roleOptions = Object.entries(KUN_ROLE_LABEL).map(([value, label]) => ({
  value: Number(value),
  label
}))

const statusOptions = Object.entries(USER_STATUS_MAP).map(([value, label]) => ({
  value: Number(value),
  label
}))

export const UserEdit = ({ initialUser, onUpdated }: Props) => {
  const [user, setUser] = useState<AdminUser>(initialUser)
  const [formUser, setFormUser] = useState<AdminUser>(initialUser)
  const [password, setPassword] = useState('')
  const [resetImageCount, setResetImageCount] = useState(false)
  const [disabling2FA, setDisabling2FA] = useState(false)
  const currentUser = useUserStore(
    useShallow((state) => ({ uid: state.user.uid, role: state.user.role }))
  )
  // 与服务端同一个判定: 只列得出能保存的角色 (当前角色恒在其中)
  const assignableRoles = roleOptions.filter((role) =>
    canAssignRole(currentUser, { current: user.role, next: role.value })
  )
  // 与服务端同一个判定: 超级管理员账号的邮箱、密码、角色与状态不在后台改
  const superAdminTarget = isSuperAdminRole(user.role)
  const { isOpen, onOpen, onClose } = useDisclosure()

  useEffect(() => {
    setUser(initialUser)
    setFormUser(initialUser)
  }, [initialUser])

  const handleChange = (key: keyof AdminUser, value: string | number) => {
    setFormUser((prev) => ({ ...prev, [key]: value }))
  }

  const handleOpen = () => {
    setFormUser(user)
    setPassword('')
    setResetImageCount(false)
    onOpen()
  }

  const handleClose = () => {
    setFormUser(user)
    setPassword('')
    setResetImageCount(false)
    onClose()
  }

  // 输入框填目标值, 请求只带差值: 打开弹窗之后用户签到、被赞、消费的增减不被覆盖
  const pointDelta = formUser.moemoepoint - user.moemoepoint
  // 请求只带这次改了的键 (合并契约): 与打开弹窗时的快照比, 没改的列不随请求写回,
  // 打开之后别处写下的改名、改邮箱、升权、封禁不会被快照回滚
  const changes = {
    ...(formUser.name !== user.name ? { name: formUser.name } : {}),
    ...(formUser.email !== user.email ? { email: formUser.email } : {}),
    ...(formUser.role !== user.role ? { role: formUser.role } : {}),
    ...(formUser.status !== user.status ? { status: formUser.status } : {}),
    ...(formUser.bio !== user.bio ? { bio: formUser.bio } : {}),
    ...(pointDelta ? { moemoepointDelta: pointDelta } : {}),
    ...(resetImageCount ? { resetDailyImageCount: true } : {}),
    ...(password.trim() ? { password } : {})
  }
  const hasChanges = Object.keys(changes).length > 0

  const [updating, setUpdating] = useState(false)
  const handleUpdateUserInfo = async () => {
    setUpdating(true)
    try {
      const res = await kunFetchPut<KunResponse<AdminUserPatchResult>>(
        '/admin/user',
        { uid: user.id, ...changes }
      )
      kunErrorHandler(res, (result) => {
        // 以服务端写后的值为准
        const saved = { ...user, ...result }
        setUser(saved)
        setFormUser(saved)
        setPassword('')
        setResetImageCount(false)
        toast.success('更新用户信息成功')
        onClose()
        onUpdated?.(saved)
      })
    } catch (error) {
      errorReporter(error)
    } finally {
      setUpdating(false)
    }
  }

  const handleDisable2FA = async () => {
    setDisabling2FA(true)
    try {
      const res = await kunFetchPost<KunResponse<{}>>(
        '/admin/user/2fa/disable',
        {
          uid: formUser.id
        }
      )
      kunErrorHandler(res, () => {
        setUser((prev) => ({ ...prev, enable2FA: false }))
        setFormUser((prev) => ({ ...prev, enable2FA: false }))
        toast.success('关闭用户两步验证成功')
      })
    } catch (error) {
      errorReporter(error)
    } finally {
      setDisabling2FA(false)
    }
  }

  return (
    <>
      <Button
        isIconOnly
        aria-label="编辑用户"
        size="sm"
        variant="light"
        onPress={handleOpen}
      >
        <Edit2 size={16} />
      </Button>

      <Modal size="2xl" isOpen={isOpen} onClose={handleClose}>
        <ModalContent>
          <ModalHeader>编辑用户: {formUser.name}</ModalHeader>
          <ModalBody>
            <p>请注意, 您的任何更改都会导致该用户重新登录</p>
            {superAdminTarget && (
              <p className="text-small text-default-500">
                这是超级管理员账号, 邮箱、密码、角色与状态不能在后台修改
              </p>
            )}
            <div className="grid grid-cols-2 gap-4">
              <Input label="用户 ID" value={String(formUser.id)} isReadOnly />
              <Input
                label="用户名"
                value={formUser.name}
                onChange={(e) => handleChange('name', e.target.value)}
              />
              <Input
                label="邮箱"
                type="email"
                value={formUser.email}
                isDisabled={superAdminTarget}
                onChange={(e) => handleChange('email', e.target.value)}
              />
              <Select
                label="角色"
                selectedKeys={[String(formUser.role)]}
                isDisabled={superAdminTarget}
                onChange={(e) => handleChange('role', Number(e.target.value))}
              >
                {assignableRoles.map((role) => (
                  <SelectItem key={role.value}>{role.label}</SelectItem>
                ))}
              </Select>
              <Select
                label="状态"
                selectedKeys={[String(formUser.status)]}
                isDisabled={superAdminTarget}
                onChange={(e) => handleChange('status', Number(e.target.value))}
                disabledKeys={['1']}
              >
                {statusOptions.map((status) => (
                  <SelectItem key={status.value}>{status.label}</SelectItem>
                ))}
              </Select>
              <Input
                label="今日已用图片"
                value={String(resetImageCount ? 0 : formUser.dailyImageCount)}
                description={
                  resetImageCount
                    ? `保存后清零 (现为 ${formUser.dailyImageCount} 张)`
                    : undefined
                }
                isReadOnly
                endContent={
                  <Button
                    size="sm"
                    variant="flat"
                    isDisabled={
                      !resetImageCount && formUser.dailyImageCount === 0
                    }
                    onPress={() => setResetImageCount((prev) => !prev)}
                  >
                    {resetImageCount ? '撤销' : '清零'}
                  </Button>
                }
              />
              <Input
                label="萌萌点"
                type="number"
                value={String(formUser.moemoepoint)}
                description={
                  pointDelta
                    ? `将调整 ${pointDelta > 0 ? '+' : ''}${pointDelta}`
                    : undefined
                }
                onChange={(e) =>
                  handleChange('moemoepoint', Number(e.target.value))
                }
              />
              <div className="col-span-2">
                <Input
                  label="新密码"
                  type="password"
                  autoComplete="new-password"
                  description="留空则不修改该用户密码"
                  isDisabled={superAdminTarget}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <div className="col-span-2">
                <Textarea
                  label="签名"
                  value={formUser.bio}
                  onChange={(e) => handleChange('bio', e.target.value)}
                />
              </div>
            </div>
          </ModalBody>
          <ModalFooter>
            <Button
              color="warning"
              variant="flat"
              className="mr-auto"
              isDisabled={updating || disabling2FA || !formUser.enable2FA}
              isLoading={disabling2FA}
              onPress={handleDisable2FA}
            >
              关闭两步验证
            </Button>
            <Button color="danger" variant="light" onPress={handleClose}>
              取消
            </Button>
            <Button
              color="primary"
              isDisabled={updating || disabling2FA || !hasChanges}
              isLoading={updating}
              onPress={handleUpdateUserInfo}
            >
              保存
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  )
}
