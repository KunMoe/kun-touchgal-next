export const isValidURL = (url: string) => {
  try {
    const _ = new URL(url)
    return true
  } catch (_) {
    return false
  }
}

export const kunUsernameRegex = /^[\p{L}\p{N}!~_@#$%^&*()+=-]{1,17}$/u

export const kunPasswordRegex =
  /^(?=.*[a-zA-Z])(?=.*[0-9])[\w!@#$%^&*()+=\\/-]{6,1007}$/

export const kunValidMailConfirmCodeRegex = /^[a-zA-Z0-9]{7}$/

export const ResourceSizeRegex: RegExp = /^.{0,107}(mb|gb)$/i
