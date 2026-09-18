export const resourceTypes = [
  {
    value: 'game',
    label: '游戏本体',
    description: 'Galgame 游戏本体下载资源'
  },
  {
    value: 'audio',
    label: '音声',
    description: '音声作品, 或游戏相关的音频资源'
  },
  {
    value: 'image',
    label: '图片CG',
    description: '游戏 CG, 原画, 壁纸等图片资源'
  },
  {
    value: 'video',
    label: '视频',
    description: '游戏相关的视频资源, 例如 OP, ED, PV 等'
  },
  {
    value: 'manual',
    label: '人工翻译补丁',
    description: '由人工翻译制作的补丁'
  },
  {
    value: 'ai',
    label: 'AI翻译补丁',
    description: '由 AI 翻译制作的补丁'
  },
  {
    value: 'machine',
    label: '传统机翻补丁',
    description: '由传统机翻软件直接翻译的补丁'
  },
  {
    value: 'machine_polishing',
    label: '传统机翻润色补丁',
    description: '在传统机翻基础上经过人工润色的补丁'
  },
  {
    value: 'save',
    label: '存档',
    description: '游戏存档, 例如全 CG 存档'
  },
  {
    value: 'crack',
    label: '破解补丁',
    description: '用于破解游戏的补丁'
  },
  {
    value: 'fix',
    label: '修正补丁',
    description: '用于修正游戏问题的补丁'
  },
  {
    value: 'mod',
    label: '魔改补丁',
    description: '对游戏进行魔改的补丁'
  },
  {
    value: 'adult',
    label: '成人内容补丁',
    description: '为游戏恢复或添加成人内容的补丁'
  },
  {
    value: 'uncensored',
    label: '去码补丁',
    description: '去除游戏内马赛克的补丁'
  },
  {
    value: 'other',
    label: '其它',
    description: '其它内容'
  }
]

// 各资源类别 (section) 下允许选择的资源类型
export const RESOURCE_SECTION_TYPE_MAP: Record<string, string[]> = {
  galgame: ['game', 'audio', 'image', 'video', 'other'],
  patch: [
    'manual',
    'ai',
    'machine',
    'machine_polishing',
    'save',
    'crack',
    'fix',
    'mod',
    'adult',
    'uncensored',
    'other'
  ]
}

export const SUPPORTED_TYPE = [
  'game',
  'audio',
  'image',
  'video',
  'manual',
  'ai',
  'machine',
  'machine_polishing',
  'save',
  'crack',
  'fix',
  'mod',
  'adult',
  'uncensored',
  'other'
]
export const SUPPORTED_TYPE_MAP: Record<string, string> = {
  all: '全部类型',
  game: '游戏本体',
  audio: '音声',
  image: '图片CG',
  video: '视频',
  manual: '人工翻译补丁',
  ai: 'AI翻译补丁',
  machine: '传统机翻补丁',
  machine_polishing: '传统机翻润色补丁',
  save: '存档',
  crack: '破解补丁',
  fix: '修正补丁',
  mod: '魔改补丁',
  adult: '成人内容补丁',
  uncensored: '去码补丁',
  other: '其它'
}
export const ALL_SUPPORTED_TYPE = ['all', ...SUPPORTED_TYPE]

export const SUPPORTED_LANGUAGE = [
  'zh-Hans',
  'zh-Hant',
  'ja',
  'en',
  'none',
  'other'
]
export const ALL_SUPPORTED_LANGUAGE = ['all', ...SUPPORTED_LANGUAGE]
export const SUPPORTED_LANGUAGE_MAP: Record<string, string> = {
  all: '全部语言',
  'zh-Hans': '简体中文',
  'zh-Hant': '繁體中文',
  ja: '日本語',
  en: 'English',
  none: '无语言',
  other: '其它'
}

export const SUPPORTED_PLATFORM = [
  'windows',
  'macos',
  'linux',
  'emulator',
  'apk',
  'ipa',
  'other'
]
export const ALL_SUPPORTED_PLATFORM = ['all', ...SUPPORTED_PLATFORM]
export const SUPPORTED_PLATFORM_MAP: Record<string, string> = {
  all: '全部平台',
  windows: 'Windows',
  macos: 'MacOS',
  linux: 'Linux',
  emulator: '模拟器',
  apk: 'Android APK',
  ipa: 'iOS IPA',
  other: '其它'
}

// platform 含 emulator 时必选的模拟器类型
export const SUPPORTED_EMULATOR_TYPE = [
  'joiplay',
  'ons',
  'krkr',
  'tyranor_artemis',
  'other'
]
export const SUPPORTED_EMULATOR_TYPE_MAP: Record<string, string> = {
  joiplay: 'JoiPlay',
  ons: 'ONS',
  krkr: 'KRKR',
  tyranor_artemis: 'Tyranor/Artemis',
  other: '其他'
}

export const SUPPORTED_RESOURCE_LINK = ['touchgal', 's3', 'user']

export const OBJECT_STORAGE_MAX_FILE_SIZE_BYTES = 1024 * 1024 * 1024
export const OBJECT_STORAGE_MAX_FILE_SIZE_LABEL = '1GB'
export const OBJECT_STORAGE_MAX_FILE_SIZE_ERROR = `文件大小超过限制, 必须小于 ${OBJECT_STORAGE_MAX_FILE_SIZE_LABEL}`
export const RESOURCE_DAILY_UPLOAD_LIMIT_MB = 5120

// resource 绑定 (bindUploadedResource) 里把暂存对象 copy 到正式 key 的墙钟上限:
// 该路径是持锁的同步请求, S3 黑洞时若无此上限会无限挂起 (S3Client 全局只有 socket
// 空闲兜底, 不设墙钟). 60s 与 moderation 的 MODERATION_S3_TIMEOUT_MS 取齐
export const RESOURCE_S3_COPY_TIMEOUT_MS = 60 * 1000

export const storageTypes = [
  {
    value: 'touchgal',
    label: 'TouchGal 资源盘 (官方可用)',
    description: '此选项用于官方发布 Galgame 下载资源'
  },
  {
    value: 's3',
    label: `对象存储 (<${OBJECT_STORAGE_MAX_FILE_SIZE_LABEL}, 创作者可用)`,
    description: `此选项适合 <${OBJECT_STORAGE_MAX_FILE_SIZE_LABEL} 的资源, 稳定, 永远不会失效过期`
  },
  {
    value: 'user',
    label: `自定义链接 (>=${OBJECT_STORAGE_MAX_FILE_SIZE_LABEL})`,
    description: `此选项适合 >=${OBJECT_STORAGE_MAX_FILE_SIZE_LABEL} 的资源, 这需要您自行提供下载链接`
  }
]

export const SUPPORTED_RESOURCE_LINK_MAP: Record<string, string> = {
  touchgal: 'TouchGal 资源盘',
  s3: '对象存储下载',
  user: '自定义链接下载'
}

export const ALLOWED_MIME_TYPES = [
  'application/zip',
  'application/x-lz4',
  'application/x-rar-compressed'
]

export const ALLOWED_EXTENSIONS = ['.zip', '.rar', '.7z']

export const SUPPORTED_RESOURCE_SECTION = ['galgame', 'patch']

export const RESOURCE_SECTION_MAP: Record<string, string> = {
  galgame: 'Galgame 资源',
  patch: 'Galgame 补丁'
}
