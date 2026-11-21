import { SUPPORTED_TYPE_MAP } from '~/constants/resource'
import type { KunSiteConfig } from './config'

const KUN_SITE_NAME = 'TouchGal'
const KUN_SITE_MENTION = '@touchgal'
const KUN_SITE_TITLE = 'TouchGal - 一站式Galgame文化社区!'
const KUN_SITE_IMAGE =
  'https://cloud.touchgaloss.com/uploads/20241217174250074.avif'
const KUN_SITE_DESCRIPTION =
  'TouchGal 是一个一站式 Galgame 文化社区。提供Galgame 论坛、Galgame 下载等服务。承诺永久免费, 高质量。为Galgame 爱好者提供一片净土！'
const KUN_SITE_URL = 'https://www.touchgal.ink'
const KUN_SITE_ARCHIVE = 'https://archive.touchgal.co/'
const KUN_SITE_FORUM = 'https://bbs.touchgal.co/'
const KUN_SITE_NAV = 'https://gal.red'
const KUN_SITE_TELEGRAM_GROUP = 'https://s.miku.cyou/2'
const KUN_SITE_DISCORD_GROUP = 'https://discord.gg/e4QePvPQTB'
const KUN_SITE_LIST = [
  { name: KUN_SITE_NAME, url: 'https://www.touchgal.net' },
  { name: KUN_SITE_NAME, url: 'https://www.touchgal.moe' },
  { name: KUN_SITE_NAME, url: 'https://www.touchgal.one' },
  { name: KUN_SITE_NAME, url: 'https://www.touchgal.com' },
  { name: KUN_SITE_NAME, url: 'https://www.touchgal.org' },
  { name: KUN_SITE_NAME, url: 'https://www.touchgal.me' },
  { name: KUN_SITE_NAME, url: 'https://www.touchgal.co' },
  { name: KUN_SITE_NAME, url: 'https://www.touchgal.io' },
  { name: KUN_SITE_NAME, url: 'https://www.touchgal.us' }
]
const KUN_SITE_KEYWORDS = [
  'TouchGAL',
  'Gal',
  'Galgame',
  '论坛',
  '网站',
  'Galgame 下载',
  'Galgame 资源',
  'Galgame wiki',
  'Galgame 评测',
  'Galgame 数据分析',
  'Galgame 新作动态',
  'Galgame 汉化 / 国际化',
  'Galgame 制作',
  'Galgame 讨论',
  '游戏交流',
  '其他交流',
  ...Object.values(SUPPORTED_TYPE_MAP)
]

export const kunMoyuMoe: KunSiteConfig = {
  title: KUN_SITE_TITLE,
  titleShort: KUN_SITE_NAME,
  template: `%s - ${KUN_SITE_NAME}`,
  description: KUN_SITE_DESCRIPTION,
  keywords: KUN_SITE_KEYWORDS,
  author: [
    { name: KUN_SITE_TITLE, url: KUN_SITE_URL },
    { name: KUN_SITE_NAME, url: KUN_SITE_NAV },
    ...KUN_SITE_LIST
  ],
  creator: {
    name: KUN_SITE_NAME,
    mention: KUN_SITE_MENTION,
    url: KUN_SITE_URL
  },
  publisher: {
    name: KUN_SITE_NAME,
    mention: KUN_SITE_MENTION,
    url: KUN_SITE_URL
  },
  domain: {
    main: KUN_SITE_URL,
    imageBed: 'https://cloud.touchgaloss.com',
    storage: KUN_SITE_URL,
    kungal: KUN_SITE_URL,
    telegram_group: KUN_SITE_TELEGRAM_GROUP,
    discord_group: KUN_SITE_DISCORD_GROUP,
    archive: KUN_SITE_ARCHIVE,
    forum: KUN_SITE_FORUM,
    nav: KUN_SITE_NAV
  },
  og: {
    title: KUN_SITE_TITLE,
    description: KUN_SITE_DESCRIPTION,
    image: KUN_SITE_IMAGE,
    url: KUN_SITE_URL
  },
  images: [
    {
      url: KUN_SITE_IMAGE,
      width: 1000,
      height: 800,
      alt: KUN_SITE_TITLE
    }
  ]
}
