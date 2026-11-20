export const KUN_PATCH_DISABLE_REGISTER_KEY = 'admin:setting:register'

export const KUN_PATCH_PERMANENT_BAN_USER_KEY = 'admin:delete:user'

export const KUN_MODERATION_ENABLED_KEY = 'admin:setting:moderation:enabled'

export const KUN_MODERATION_DRY_RUN_KEY = 'admin:setting:moderation:dryrun'

export const KUN_MODERATION_VERDICT_CACHE_KEY = 'moderation:verdict'

// 审核 worker 每批上报的车道状态 (cron 进程写, web 进程只读)
export const KUN_MODERATION_HEALTH_KEY = 'moderation:health'
