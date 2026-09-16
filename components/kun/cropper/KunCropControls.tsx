'use client'

import { Button, Slider } from '@heroui/react'

interface CropControlsProps {
  scale: number
  rotate: number
  onScaleChange: (value: number) => void
  onRotateChange: (value: number) => void
  onOpenMosaic: () => void
}

export const KunCropControls = ({
  scale,
  rotate,
  onScaleChange,
  onRotateChange,
  onOpenMosaic
}: CropControlsProps) => {
  return (
    <div className="flex flex-col w-full max-w-md gap-4 p-4">
      <div className="flex flex-col gap-2">
        <label className="text-sm text-default-700">缩放比例</label>
        <Slider
          size="sm"
          step={0.1}
          maxValue={3}
          minValue={0.5}
          value={scale}
          onChange={(value) => onScaleChange(Number(value))}
          className="max-w-md"
          label="图片缩放比例"
        />
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-sm text-default-700">旋转角度</label>
        <Slider
          size="sm"
          step={1}
          maxValue={180}
          minValue={-180}
          value={rotate}
          onChange={(value) => onRotateChange(Number(value))}
          className="max-w-md"
          label="图片旋转角度"
        />
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-sm text-default-700">马赛克</label>
        <Button color="secondary" variant="flat" onPress={onOpenMosaic}>
          点击使用马赛克工具
        </Button>
      </div>
    </div>
  )
}
