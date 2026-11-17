![kun-touchgal-next](./public/touchgal.avif)

# TouchGal

TouchGal 是一个一站式 Galgame 文化社区。提供Galgame 论坛、Galgame 下载等服务。承诺永久免费, 高质量。为Galgame 爱好者提供一片净土！

## 错误反馈

如果要反馈错误, 请您加入 TouchGal 的官方 Discord 服务器

https://discord.gg/e4QePvPQTB

## 开发联系

如果有对 Web 开发技术 (Node.js, Nuxt, Next.js, SvelteKit, SolidStart 等) 感兴趣的朋友们, 可以加入本项目的 Telegram 开发群组

[https://t.me/KUNForum](https://t.me/KUNForum)

## 如何运行

确保本地安装有 Node.js, pnpm, PostgreSQL, Redis 环境

- 使用 `git clone` 拉取本项目至本地目录
- 参考项目根目录的 `.env.example` 文件，新建 `.env` 文件，并自行填写环境变量（`postgresql` 的本地连接配置）
- 初次运行本项目，可执行 `pnpm db:migrate` 创建此项目所使用的本地数据库（含计数触发器）
- 使用 `pnpm dev` 即可运行

```env
# 数据库 URL, 我们使用 psql
KUN_DATABASE_URL = "postgresql://postgres:kunloveren@localhost:5432/touchgal?schema=public"

# 网站 URL, 不变即可
KUN_VISUAL_NOVEL_SITE_URL = "https://www.touchgal.ink"

# 开发环境 URL, 不变即可
NEXT_PUBLIC_KUN_PATCH_ADDRESS_DEV = "http://127.0.0.1:3000"
NEXT_PUBLIC_KUN_PATCH_ADDRESS_PROD = "https://image.touchgal.moyu.moe"

# 本地 Redis 端口、地址和密码, 无密码时留空
REDIS_HOST = '127.0.0.1'
REDIS_PORT = '6379'
REDIS_PASSWORD = ''

# jwt 配置, 开发环境无需变动
JWT_ISS = 'touchgal'
JWT_AUD = 'touchgal_admin'
JWT_SECRET = 'moemoekungalgamekunisthecutest!chinorensukiazkhx'

# NODE_ENV, 开发环境无需变动
NODE_ENV = "development"

# 邮件服务地址
KUN_VISUAL_NOVEL_EMAIL_FROM = "鲲 Galgame 补丁"
KUN_VISUAL_NOVEL_EMAIL_HOST = "moyu.moe"
KUN_VISUAL_NOVEL_EMAIL_PORT = '587'
KUN_VISUAL_NOVEL_EMAIL_ACCOUNT = "auth@moyu.moe"
KUN_VISUAL_NOVEL_EMAIL_PASSWORD = "莲最可爱！"

# S3 相关配置
KUN_VISUAL_NOVEL_S3_STORAGE_ACCESS_KEY_ID = "kkkkkkkkkkkkkkkkkkkkkkkkkkkk"
KUN_VISUAL_NOVEL_S3_STORAGE_SECRET_ACCESS_KEY = "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk"
KUN_VISUAL_NOVEL_S3_STORAGE_BUCKET_NAME = "kun"
KUN_VISUAL_NOVEL_S3_STORAGE_ENDPOINT = "https://moyu.moe"
KUN_VISUAL_NOVEL_S3_STORAGE_REGION = "us-west-001"
NEXT_PUBLIC_KUN_VISUAL_NOVEL_S3_STORAGE_URL = "https://touchgal-patch.moyu.moe"

# 图床相关配置
KUN_VISUAL_NOVEL_IMAGE_BED_HOST = "touchgal-image.moyu.moe"
KUN_VISUAL_NOVEL_IMAGE_BED_URL = "https://touchgal-image.moyu.moe"
```

## 贡献指南

如果您的更改涉及到对项目源码的变动, **请务必在本地将项目运行成功, 自行测试无误后再 Pull Request**, 否则会严重阻碍代码审计工作

## 开源声明 / 开源协议

本项目由 [鲲 Galgame 补丁 - kun-galgame-patch-next](https://github.com/KUN1007/kun-galgame-patch-next) 修改而来, 原仓库地址

https://github.com/KUN1007/kun-galgame-patch-next

本项目遵从 `AGPL-3.0` 开源协议, 进行任何的修改分发时请注明原始仓库与作者地址
