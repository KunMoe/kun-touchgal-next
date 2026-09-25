import Link from 'next/link'
import { Card, CardBody } from '@heroui/card'
import { KunStaticChip } from '~/components/kun/StaticChip'
import type { Company as CompanyType } from '~/types/api/company'

interface Props {
  company: CompanyType
}

export const CompanyCard = ({ company }: Props) => {
  return (
    <Card
      isPressable
      as={Link}
      href={`/company/${company.id}`}
      prefetch={false}
      className="w-full"
    >
      <CardBody className="gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold transition-colors line-clamp-2 hover:text-primary-500">
            {company.name}
          </h2>
          <KunStaticChip size="sm">{company.count} 个 Galgame</KunStaticChip>
        </div>
        {company.alias.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {company.alias.map((alias, index) => (
              <KunStaticChip key={index} size="sm" color="secondary">
                {alias}
              </KunStaticChip>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  )
}
