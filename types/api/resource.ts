export interface PatchResourceLinkSummary {
  size: string
}

export interface PatchResource {
  id: number
  name: string
  section: string
  uniqueId: string
  type: string[]
  language: string[]
  platform: string[]
  emulatorType: string[]
  modelName: string
  primaryLink: PatchResourceLinkSummary | null
  download: number
  patchId: number
  patchName: string
  created: string
  user: KunUser & {
    patchCount: number
    role: number
  }
}

export interface ResourceListResponse {
  resources: PatchResource[]
  total: number
}
