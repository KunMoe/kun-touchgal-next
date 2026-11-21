export interface KunSiteDomain {
  main: string
  imageBed: string
  storage: string
  kungal: string
  telegram_group: string
  discord_group: string
  archive: string
  forum: string
  nav: string
}

export interface KunSiteAuthor {
  name: string
  url: string
}

export interface KunSiteOpenGraph {
  title: string
  description: string
  image: string
  url: string
}

export interface KunSiteCreator {
  name: string
  mention: string
  url: string
}

export interface KunSiteImage {
  url: string
  width: number
  height: number
  alt: string
}

export interface KunSiteConfig {
  title: string
  titleShort: string
  template: string
  description: string
  keywords: string[]
  author: KunSiteAuthor[]
  creator: KunSiteCreator
  publisher: KunSiteCreator
  domain: KunSiteDomain
  og: KunSiteOpenGraph
  images: KunSiteImage[]
}
