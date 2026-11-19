'use client'

import { KunDualEditorProvider } from '~/components/kun/milkdown/DualEditorProvider'
import { useCreatePatchStore } from '~/store/editStore'
import { markdownToText } from '~/utils/markdownToText'

interface Props {
  errors: string | undefined
}

// 模块级函数, 引用稳定: 编辑器把它们当作初始化 effect 的依赖
const getIntroduction = () => useCreatePatchStore.getState().data.introduction
const setIntroduction = (introduction: string) =>
  useCreatePatchStore.getState().update({ introduction })

export const PatchIntroduction = ({ errors }: Props) => {
  const data = useCreatePatchStore((state) => state.data)

  return (
    <div className="space-y-2">
      <h2 className="text-xl">游戏介绍 (必须)</h2>
      <p className="text-small text-default-500">
        游戏介绍涉及页面的 SEO, 建议填写 100 字以上
      </p>
      {errors && <p className="text-xs text-danger-500">{errors}</p>}

      <KunDualEditorProvider
        getMarkdown={getIntroduction}
        setMarkdown={setIntroduction}
      />

      <p className="text-small text-default-500">
        字数: {markdownToText(data.introduction).length}
      </p>
    </div>
  )
}
