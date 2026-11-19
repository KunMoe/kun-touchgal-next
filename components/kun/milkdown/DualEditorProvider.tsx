'use client'

import { useCallback, useState } from 'react'
import dynamic from 'next/dynamic'
import { Tab, Tabs } from '@heroui/tabs'
import { Code, Edit } from 'lucide-react'
import { KunEditor } from './Editor'
import { KunLoading } from '~/components/kun/Loading'

const Codemirror = dynamic(
  () => import('./codemirror/Codemirror').then((mod) => mod.Codemirror),
  {
    ssr: false,
    loading: () => <KunLoading className="min-h-48" hint="正在加载编辑器" />
  }
)

interface Props {
  // 两个函数的引用必须稳定: 它们是 codemirror 初始化 effect 的依赖, 每次渲染换一个
  // 新引用会让编辑器反复重建。getMarkdown 在首帧就要给出原文: 两个编辑器都只在
  // 初始化时读一次值
  getMarkdown: () => string
  setMarkdown: (markdown: string) => void
}

export const KunDualEditorProvider = ({ getMarkdown, setMarkdown }: Props) => {
  const [cmAPI, setCmAPI] = useState({
    update: (_: string) => {}
  })

  const saveMarkdown = useCallback(
    (markdown: string) => {
      setMarkdown(markdown)
      cmAPI.update(markdown)
    },
    [cmAPI, setMarkdown]
  )

  const onCodemirrorChange = useCallback(
    (getCode: () => string) => {
      setMarkdown(getCode())
    },
    [setMarkdown]
  )

  return (
    <Tabs aria-label="Editor options" size="lg" variant="underlined">
      <Tab
        key="code"
        title={
          <div className="flex items-center gap-2">
            <Code size={18} />
            <span>代码编辑</span>
          </div>
        }
      >
        <Codemirror
          markdown={getMarkdown()}
          setCmAPI={setCmAPI}
          onChange={onCodemirrorChange}
        />
      </Tab>

      <Tab
        key="editor"
        title={
          <div className="flex items-center gap-2">
            <Edit size={18} />
            <span>编辑预览</span>
          </div>
        }
      >
        <KunEditor valueMarkdown={getMarkdown()} saveMarkdown={saveMarkdown} />
      </Tab>
    </Tabs>
  )
}
