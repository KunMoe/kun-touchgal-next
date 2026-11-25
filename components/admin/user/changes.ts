import type { AdminUser } from '~/types/api/admin'

// 后台改用户的请求体 (合并契约, validations/admin.ts 的 adminPatchUserSchema): 只带与基线不同
// 的键, 没改的列不随请求写回。基线是列表里这一行的值 (列表加载时或上次保存后), 打开弹窗不重新取。
// 服务端会 trim, 名字、邮箱、签名只差前后空白不算修改 (否则白白写一次日志、登出该用户)
export const kunAdminUserChanges = (
  baseline: AdminUser,
  form: AdminUser,
  extra: { password: string; resetImageCount: boolean }
) => {
  // 萌萌点输入框填目标值, 请求只带差值: 基线之后的签到、被赞、消费不被覆盖
  const pointDelta = form.moemoepoint - baseline.moemoepoint
  return {
    ...(form.name.trim() !== baseline.name ? { name: form.name } : {}),
    ...(form.email.trim() !== baseline.email ? { email: form.email } : {}),
    ...(form.role !== baseline.role ? { role: form.role } : {}),
    ...(form.status !== baseline.status ? { status: form.status } : {}),
    ...(form.bio.trim() !== baseline.bio ? { bio: form.bio } : {}),
    ...(pointDelta ? { moemoepointDelta: pointDelta } : {}),
    ...(extra.resetImageCount ? { resetDailyImageCount: true as const } : {}),
    ...(extra.password.trim() ? { password: extra.password } : {})
  }
}
