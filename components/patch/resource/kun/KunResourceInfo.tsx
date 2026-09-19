import { KunPatchAttribute } from './KunPatchAttribute'
import type { KunMoyuPatchResource } from '~/types/api/kun/moyu-moe'

interface Props {
  resource: KunMoyuPatchResource
}

export const KunResourceInfo = ({ resource }: Props) => {
  return (
    <KunPatchAttribute
      types={resource.type}
      languages={resource.language}
      platforms={resource.platform}
      modelName={resource.model_name}
      size="sm"
    />
  )
}
