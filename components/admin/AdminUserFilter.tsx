'use client'

import { useState, type Key } from 'react'
import { Autocomplete, AutocompleteItem, Avatar } from '@heroui/react'
import { Search } from 'lucide-react'
import toast from 'react-hot-toast'
import { useDebounce } from 'use-debounce'
import { kunFetchGet } from '~/utils/kunFetch'
import { useKunKeyedQuery } from '~/hooks/useKunKeyedQuery'
import type { AdminUser } from '~/types/api/admin'

interface Props {
  placeholder: string
  // 选中某个用户, 或清空输入时为 null
  onChange: (userId: number | null) => void
}

// admin 列表按用户筛选的用户名联想 (评论、评价、资源三处共用)
export const AdminUserFilter = ({ placeholder, onChange }: Props) => {
  const [input, setInput] = useState('')
  const [debouncedInput] = useDebounce(input, 400)
  const name = debouncedInput.trim()
  const users = useKunKeyedQuery({
    key: name,
    enabled: name !== '',
    fetch: (search) =>
      kunFetchGet<{ users: AdminUser[]; total: number }>('/admin/user', {
        page: 1,
        limit: 10,
        search,
        searchType: 'name'
      }),
    onFailure: (message) => toast.error(message)
  })
  const options = name ? (users.data?.users ?? []) : []

  return (
    <Autocomplete
      fullWidth
      isClearable
      placeholder={placeholder}
      startContent={<Search className="text-default-300" size={20} />}
      inputValue={input}
      isLoading={users.status === 'loading'}
      items={options}
      onInputChange={(value) => {
        setInput(value)
        if (!value) {
          onChange(null)
        }
      }}
      onSelectionChange={(key: Key | null) =>
        onChange(key ? Number(key) : null)
      }
    >
      {(user) => (
        <AutocompleteItem key={user.id} textValue={user.name}>
          <div className="flex items-center gap-2">
            <Avatar
              src={user.avatar}
              size="sm"
              showFallback
              name={user.name.charAt(0).toUpperCase()}
            />
            <span>{user.name}</span>
          </div>
        </AutocompleteItem>
      )}
    </Autocomplete>
  )
}
