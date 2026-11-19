import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { KunFormUpdate } from '~/components/edit/types'

export interface CreatePatchData {
  name: string
  introduction: string
  vndbId: string
  vndbRelationId: string
  bangumiId: string
  steamId: string
  dlsiteCode: string
  dlsiteCircleName: string
  dlsiteCircleLink: string
  vndbTags: string[]
  vndbDevelopers: string[]
  bangumiTags: string[]
  bangumiDevelopers: string[]
  steamTags: string[]
  steamDevelopers: string[]
  dlsiteTags: string[]
  alias: string[]
  tag: string[]
  released: string
  contentLimit: string
}

export interface CreatePatchRequestData extends CreatePatchData {
  banner: Blob | null
}

interface StoreState {
  data: CreatePatchData
  update: KunFormUpdate<CreatePatchData>
  resetData: () => void
}

export const createPatchEditStoreKey = 'kun-patch-edit-store'

const initialState: CreatePatchData = {
  name: '',
  introduction: '',
  vndbId: '',
  vndbRelationId: '',
  bangumiId: '',
  steamId: '',
  dlsiteCode: '',
  dlsiteCircleName: '',
  dlsiteCircleLink: '',
  vndbTags: [],
  vndbDevelopers: [],
  bangumiTags: [],
  bangumiDevelopers: [],
  steamTags: [],
  steamDevelopers: [],
  dlsiteTags: [],
  alias: [],
  tag: [],
  released: '',
  contentLimit: 'sfw'
}

export const useCreatePatchStore = create<StoreState>()(
  persist(
    (set) => ({
      data: initialState,
      update: (patch) =>
        set((state) => ({
          data: {
            ...state.data,
            ...(typeof patch === 'function' ? patch(state.data) : patch)
          }
        })),
      resetData: () => set({ data: initialState })
    }),
    {
      name: createPatchEditStoreKey,
      storage: createJSONStorage(() => window.localStorage),
      skipHydration: true,
      // 默认浅合并会用旧草稿的整份 data 盖掉 initialState, 草稿里没有的新增字段
      // (如 dlsiteTags) 变成 undefined, BatchTag 遍历时整页崩溃
      merge: (persisted, current) => ({
        ...current,
        data: {
          ...current.data,
          ...(persisted as Partial<StoreState> | undefined)?.data
        }
      })
    }
  )
)
