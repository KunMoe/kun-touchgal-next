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
import { canAssignRole } from '~/constants/permission'
import { kunFetchPost, kunFetchPut } from '~/utils/kunFetch'
import { errorReporter, kunErrorHandler } from '~/utils/kunErrorHandler'
import { useUserStore } from '~/store/userStore'
import type { AdminUser } from '~/types/api/admin'

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
  const [disabling2FA, setDisabling2FA] = useState(false)
  const currentUser = useUserStore(
    useShallow((state) => ({ uid: state.user.uid, role: state.user.role }))
  )
  // 与服务端同一个判定: 只列得出能保存的角色 (当前角色恒在其中)
  const assignableRoles = roleOptions.filter((role) =>
    canAssignRole(currentUser, { current: user.role, next: role.value })
  )
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
    onOpen()
  }

  const handleClose = () => {
    setFormUser(user)
    setPassword('')
    onClose()
  }

  const [updating, setUpdating] = useState(false)
  const handleUpdateUserInfo = async () => {
    const requestData = {
      uid: formUser.id,
      name: formUser.name,
      email: formUser.email,
      role: formUser.role,
      status: formUser.status,
      dailyImageCount: formUser.dailyImageCount,
      moemoepoint: formUser.moemoepoint,
      bio: formUser.bio,
      ...(password ? { password } : {})
    }

    setUpdating(true)
    try {
      const res = await kunFetchPut<KunResponse<{}>>('/admin/user', requestData)
      kunErrorHandler(res, () => {
        setUser(formUser)
        setFormUser(formUser)
        setPassword('')
        toast.success('更新用户信息成功')
        onClose()
        onUpdated?.(formUser)
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
                onChange={(e) => handleChange('email', e.target.value)}
              />
              <Select
                label="角色"
                selectedKeys={[String(formUser.role)]}
                onChange={(e) => handleChange('role', Number(e.target.value))}
              >
                {assignableRoles.map((role) => (
                  <SelectItem key={role.value}>{role.label}</SelectItem>
                ))}
              </Select>
              <Select
                label="状态"
                selectedKeys={[String(formUser.status)]}
                onChange={(e) => handleChange('status', Number(e.target.value))}
                disabledKeys={['1']}
              >
                {statusOptions.map((status) => (
                  <SelectItem key={status.value}>{status.label}</SelectItem>
                ))}
              </Select>
              <Input
                label="每日图片限额"
                type="number"
                value={String(formUser.dailyImageCount)}
                onChange={(e) =>
                  handleChange('dailyImageCount', Number(e.target.value))
                }
              />
              <Input
                label="萌萌点"
                type="number"
                value={String(formUser.moemoepoint)}
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
              isDisabled={updating || disabling2FA}
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
