import { KunAvatar } from '~/components/kun/floating-card/KunAvatar'
import { Avatar } from '@heroui/avatar'
import { Card, CardBody } from '@heroui/card'
import { Chip } from '@heroui/chip'
import { formatDate } from '~/utils/time'
import { ADMIN_LOG_TYPE_MAP } from '~/constants/admin'
import { DELETED_USER_NAME } from '~/constants/user'
import type { AdminLog } from '~/types/api/admin'

interface Props {
  log: AdminLog
}

export const LogCard = ({ log }: Props) => {
  return (
    <Card>
      <CardBody>
        <div className="flex gap-4">
          {log.user ? (
            <KunAvatar
              uid={log.user.id}
              avatarProps={{
                name: log.user.name,
                src: log.user.avatar
              }}
            />
          ) : (
            <Avatar className="shrink-0" alt={DELETED_USER_NAME} />
          )}
          <div className="w-full min-w-0">
            <pre className="whitespace-pre-wrap break-all">{log.content}</pre>

            <div className="flex items-center gap-4 mt-2">
              <span className="text-small text-default-500">
                {formatDate(log.created, {
                  isPrecise: true,
                  isShowYear: true
                })}
              </span>

              <Chip color="primary" variant="flat" size="sm">
                {ADMIN_LOG_TYPE_MAP[log.type]}
              </Chip>
            </div>
          </div>
        </div>
      </CardBody>
    </Card>
  )
}
