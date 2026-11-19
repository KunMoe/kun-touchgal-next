import toast from 'react-hot-toast'
import { Decoration } from '@milkdown/prose/view'
import { kunFetchFormData } from '~/utils/kunFetch'
import { checkImageValid, resizeImage } from '~/utils/resizeImage'
import type { Uploader } from '@milkdown/plugin-upload'
import type { Node } from '@milkdown/prose/model'

export const kunUploader: Uploader = async (files, schema) => {
  const images: File[] = []

  for (let i = 0; i < files.length; i++) {
    const file = files.item(i)
    if (!file) {
      continue
    }

    if (!file.type.startsWith('image/')) {
      continue
    }

    if (!checkImageValid(file)) {
      continue
    }

    images.push(file)
  }

  const nodes = await Promise.all(
    images.map(async (image) => {
      // resize 失败已在 resizeImage 内部弹出具体原因, 此处早退避免重复 toast
      const miniImage = await resizeImage(image, 1920, 1080).catch(() => null)
      if (!miniImage) {
        return undefined
      }

      try {
        const formData = new FormData()
        formData.append('image', miniImage)

        const res = await kunFetchFormData<
          KunResponse<{
            imageLink: string
          }>
        >('/user/image', formData)
        // 一次可以传多张: 失败的提示带上文件名, 才知道是哪一张
        if (typeof res === 'string') {
          toast.error(`图片 ${image.name} 上传失败: ${res}`)
          return undefined
        }

        return schema.nodes.image.createAndFill({
          src: res.imageLink,
          alt: image.name
        }) as Node
      } catch {
        toast.error(`图片 ${image.name} 上传失败`)
        return undefined
      }
    })
  )

  // 业务错误 (字符串响应) 或网络异常时该项为 undefined; 必须过滤,
  // 否则 plugin-upload 内部 replaceWith 抛错, 上传占位符永久残留
  return nodes.filter((node): node is Node => Boolean(node))
}

export const kunUploadWidgetFactory = (
  pos: number,
  spec: Parameters<typeof Decoration.widget>[2]
) => {
  const widgetDOM = document.createElement('span')
  widgetDOM.textContent = '图片正在上传中'
  widgetDOM.style.color = '#006fee'
  return Decoration.widget(pos, widgetDOM, spec)
}
