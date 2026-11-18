import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { cookieStorage } from './_cookie'

export interface KunSettingData {
  kunNsfwEnable: string
}

interface StoreState {
  data: KunSettingData
  getData: () => KunSettingData
  setData: (data: KunSettingData) => void
  resetData: () => void
}

const initialState: KunSettingData = {
  kunNsfwEnable: 'sfw'
}

export const useSettingStore = create<StoreState>()(
  persist(
    (set, get) => ({
      data: initialState,
      getData: () => get().data,
      setData: (data: KunSettingData) => set({ data }),
      resetData: () => set({ data: initialState })
    }),
    {
      name: 'kun-patch-setting-store',
      storage: createJSONStorage(() => cookieStorage),
      skipHydration: true,
      // 只持久化分级设置。旧版本会把屏蔽标签也写成 cookie (服务端曾采信它), 水合是浅合并,
      // 那个旧字段会跟着回到内存里; 有了这一条, 下一次写入 (切换分级或重置) 时它不会被写回,
      // cookieStorage.setItem 先整组删除再重写, 旧 cookie 随之消失。不要在加载时主动去删:
      // 那等于让每次整页加载都写一次 cookie
      partialize: (state) => ({
        data: { kunNsfwEnable: state.data.kunNsfwEnable }
      })
    }
  )
)
