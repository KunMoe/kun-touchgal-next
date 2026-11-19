import { createStore } from 'zustand/vanilla'
import type { KunFormUpdate, PatchFormDataShape } from '~/components/edit/types'
import type { GalgameRewriteInitial } from '~/types/api/edit'

export interface RewritePatchData extends PatchFormDataShape {
  id: number
  uniqueId: string
  introduction: string
  contentLimit: string
  // 现存标签里本次要移除的 id。tag 只放本次新增的标签名, 现存标签不经文本往返
  removeTagIds: number[]
}

interface StoreState {
  data: RewritePatchData
  // 建表单时读到的基线, 与 data 同生共死: 页面重新下发一份更新的基线时, 已经填了
  // 一半的表单仍按它自己起步时的指纹提交, 不会拿新指纹盖掉别人的修改
  existingTags: GalgameRewriteInitial['tags']
  baseFingerprint: string
  update: KunFormUpdate<RewritePatchData>
}

// 每次打开重写页用页面读到的基线建一个实例, 不做成全局 store: 编辑器只在初始化时读
// 一次介绍原文, store 必须在首帧就带着它; 全局 store 还会把上一个游戏的表单带到下一个
export const createRewriteFormStore = (initial: GalgameRewriteInitial) =>
  createStore<StoreState>()((set) => ({
    data: {
      id: initial.id,
      uniqueId: initial.uniqueId,
      name: initial.name,
      introduction: initial.introduction,
      ...initial.externalIds,
      dlsiteCircleName: '',
      dlsiteCircleLink: '',
      vndbTags: [],
      vndbDevelopers: [],
      bangumiTags: [],
      bangumiDevelopers: [],
      steamTags: [],
      steamDevelopers: [],
      dlsiteTags: [],
      alias: initial.alias,
      tag: [],
      removeTagIds: [],
      contentLimit: initial.contentLimit,
      released: initial.released
    },
    existingTags: initial.tags,
    baseFingerprint: initial.baseFingerprint,
    update: (patch) =>
      set((state) => ({
        data: {
          ...state.data,
          ...(typeof patch === 'function' ? patch(state.data) : patch)
        }
      }))
  }))

export type RewriteFormStore = ReturnType<typeof createRewriteFormStore>
