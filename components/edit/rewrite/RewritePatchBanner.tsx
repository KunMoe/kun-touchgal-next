'use client'

import toast from 'react-hot-toast'
import { useEffect, useState } from 'react'
import { Button } from '@heroui/button'
import { Checkbox } from '@heroui/checkbox'
import { ModalBody, ModalFooter } from '@heroui/modal'
import { kunFetchFormData } from '~/utils/kunFetch'
import { errorReporter, kunErrorHandler } from '~/utils/kunErrorHandler'
import { KunImageCropper } from '~/components/kun/cropper/KunImageCropper'
import { dataURItoBlob } from '~/utils/dataURItoBlob'
import { compressDataURLToWebp } from '~/utils/resizeImage'

const MAX_ORIGINAL_BANNER_SIZE = 4 * 1024 * 1024

interface Props {
  patchId: number
  onClose: () => void
}

export const RewritePatchBanner = ({ patchId, onClose }: Props) => {
  const [banner, setBanner] = useState<Blob | null>(null)
  const [bannerOriginal, setBannerOriginal] = useState<Blob | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string>('')
  const [discardOld, setDiscardOld] = useState(false)

  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl)
      }
    }
  }, [previewUrl])

  const removeBanner = async () => {
    setPreviewUrl('')
    setBanner(null)
    setBannerOriginal(null)
  }

  const [updating, setUpdating] = useState(false)
  const handleUpdateBanner = async () => {
    if (!banner) {
      toast.error('请选择一张新的预览图片')
      return
    }

    const formData = new FormData()
    formData.append('patchId', patchId.toString())
    formData.append('image', banner)
    if (bannerOriginal) {
      formData.append('imageOriginal', bannerOriginal)
    }
    if (discardOld) {
      formData.append('discardOld', 'true')
    }

    setUpdating(true)

    try {
      const res = await kunFetchFormData<KunResponse<{ banner: string }>>(
        '/patch/banner',
        formData
      )
      kunErrorHandler(res, () => {
        setBanner(null)
        setPreviewUrl('')
        toast.success('更新图片成功, 刷新页面即可看到新图片')
        onClose()
      })
    } catch (error) {
      errorReporter(error)
    } finally {
      setUpdating(false)
    }
  }

  const onImageComplete = async (croppedImage: string) => {
    const imageBlob = dataURItoBlob(croppedImage)
    setPreviewUrl(URL.createObjectURL(imageBlob))
    setBanner(imageBlob)
  }

  const onOriginalImageComplete = async (originalImage: string) => {
    try {
      const imageBlob = await compressDataURLToWebp(originalImage, {
        maxSizeBytes: MAX_ORIGINAL_BANNER_SIZE
      })
      setBannerOriginal(imageBlob)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '原图处理失败')
      setBannerOriginal(null)
    }
  }

  return (
    <>
      <ModalBody>
        <KunImageCropper
          aspect={{ x: 16, y: 9 }}
          initialImage={previewUrl}
          description="您的预览图片将会被固定为 1920 × 1080 分辨率"
          onImageComplete={onImageComplete}
          onOriginalImageComplete={onOriginalImageComplete}
          removeImage={removeBanner}
        />

        <p>更改后刷新页面即可看到新图片</p>
        <Checkbox isSelected={discardOld} onValueChange={setDiscardOld}>
          立即删除旧图片 (撤下违规图片时勾选, 否则旧图片保留 24 小时)
        </Checkbox>
      </ModalBody>

      <ModalFooter>
        <Button variant="light" onPress={onClose}>
          取消
        </Button>
        <Button
          color="danger"
          onPress={handleUpdateBanner}
          disabled={updating}
          isLoading={updating}
        >
          更改
        </Button>
      </ModalFooter>
    </>
  )
}

export default RewritePatchBanner
