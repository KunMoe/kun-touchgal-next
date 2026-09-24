import Link from 'next/link'
import { Card, CardBody } from '@heroui/card'
import { Chip } from '@heroui/chip'
import type { Tag as TagType } from '~/types/api/tag'

interface Props {
  tag: TagType
}

export const TagCard = ({ tag }: Props) => {
  const aliases = tag.alias ?? []

  return (
    <Card
      isPressable
      as={Link}
      href={`/tag/${tag.id}`}
      prefetch={false}
      className="w-full border border-default-100 dark:border-default-200"
    >
      <CardBody className="gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold transition-colors line-clamp-2 hover:text-primary-500">
            {tag.name}
          </h2>
          <Chip size="sm" variant="flat">
            {tag.count}
          </Chip>
        </div>
        {aliases.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {aliases.map((alias, index) => (
              <Chip key={index} size="sm" variant="flat" color="secondary">
                {alias}
              </Chip>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  )
}
