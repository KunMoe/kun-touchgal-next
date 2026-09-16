'use client'

import { useRef, useState } from 'react'
import ReactCrop, { type Crop, type PixelCrop } from 'react-image-crop'
import {
  Button,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader
} from '@heroui/react'
import { KunCropControls } from './KunCropControls'
import { centerAspectCrop, createCroppedImage } from './utils'
import type { KunAspect } from './types'
import 'react-image-crop/dist/ReactCrop.css'

interface Props {
  isOpen: boolean
  imgSrc: string
  initialAspect?: KunAspect
  description?: string
  onCropComplete?: (croppedImage: string) => void
  onOriginalImageComplete?: (originalImage: string) => void
  onOpenMosaic: () => void
  onClose: () => void
}

export const KunImageCropperModal = ({
  isOpen,
  imgSrc,
  initialAspect = { x: 16, y: 9 },
  description,
  onCropComplete,
  onOriginalImageComplete,
  onOpenMosaic,
  onClose
}: Props) => {
  const imgRef = useRef<HTMLImageElement>(null)
  const [crop, setCrop] = useState<Crop>()
  const [completedCrop, setCompletedCrop] = useState<PixelCrop>()
  const [scale, setScale] = useState(1)
  const [rotate, setRotate] = useState(0)
  const aspect = initialAspect

  const onImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const { width, height } = e.currentTarget
    setCrop(centerAspectCrop(width, height, aspect.x / aspect.y))
  }

  const handleCropComplete = async () => {
    if (completedCrop && imgRef.current) {
      const croppedImage = await createCroppedImage(
        imgRef.current,
        completedCrop,
        scale,
        rotate
      )
      onCropComplete?.(croppedImage)
      onOriginalImageComplete?.(imgSrc)
      onClose()
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="3xl" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader className="flex-col">
          <h2>裁剪图片</h2>
          <p className="font-medium text-medium">{description}</p>
        </ModalHeader>
        <ModalBody>
          <div className="flex flex-col items-center gap-4">
            {!!imgSrc && (
              <ReactCrop
                crop={crop}
                onChange={(_, percentCrop) => setCrop(percentCrop)}
                onComplete={(c) => setCompletedCrop(c)}
                aspect={aspect.x / aspect.y}
                minHeight={100}
              >
                <img
                  ref={imgRef}
                  alt="Crop me"
                  src={imgSrc}
                  style={{ transform: `scale(${scale}) rotate(${rotate}deg)` }}
                  onLoad={onImageLoad}
                  className="max-h-[60vh] object-contain"
                />
              </ReactCrop>
            )}

            <KunCropControls
              scale={scale}
              rotate={rotate}
              onScaleChange={setScale}
              onRotateChange={setRotate}
              onOpenMosaic={onOpenMosaic}
            />
          </div>
        </ModalBody>
        <ModalFooter>
          <Button color="danger" variant="light" onPress={onClose}>
            取消
          </Button>
          <Button color="primary" onPress={handleCropComplete}>
            裁剪图片
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}
