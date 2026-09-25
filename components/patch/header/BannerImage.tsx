'use client'

import { useCallback, useState } from 'react'
import dynamic from 'next/dynamic'
import Image from 'next/image'

const KunImageLightbox = dynamic(
  () =>
    import('~/components/kun/image-viewer/ImageLightbox').then(
      (mod) => mod.KunImageLightbox
    ),
  { ssr: false }
)

interface Props {
  banner: string
  name: string
}

export const BannerImage = ({ banner, name }: Props) => {
  const [isOpen, setIsOpen] = useState(false)
  const [slides, setSlides] = useState<{ src: string }[]>([])

  const openLightbox = useCallback(() => {
    setIsOpen(true)
    setSlides([{ src: banner }])

    const fullBannerUrl = banner.replace('banner.avif', 'banner-full.avif')
    if (fullBannerUrl === banner) {
      return
    }

    const img = new window.Image()
    img.onload = () => {
      setSlides([{ src: fullBannerUrl }, { src: banner }])
    }
    img.onerror = () => {
      setSlides([{ src: banner }])
    }
    img.src = fullBannerUrl
  }, [banner])

  return (
    <>
      <Image
        src={banner}
        alt={name}
        className="object-cover cursor-pointer"
        fill
        sizes="(max-width: 768px) 100vw, 33vw"
        preload
        fetchPriority="high"
        unoptimized
        data-no-lightbox
        onClick={openLightbox}
      />

      {isOpen && (
        <KunImageLightbox
          open={isOpen}
          slides={slides}
          onClose={() => setIsOpen(false)}
        />
      )}
    </>
  )
}
