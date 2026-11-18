import { argon2idAsync, type ArgonOpts } from '@noble/hashes/argon2.js'
import crypto from 'crypto'

type PasswordHashOptions = Pick<
  ArgonOpts,
  't' | 'm' | 'p' | 'dkLen' | 'version'
>

type ParsedPasswordHash = {
  salt: string
  hash: string
  options: PasswordHashOptions
  legacy: boolean
}

const ARGON2ID_VERSION = 0x13
const DERIVED_KEY_BYTES = 32
const SALT_BYTES = 16

const CURRENT_OPTIONS: PasswordHashOptions = {
  t: 2,
  m: 19456,
  p: 1,
  dkLen: DERIVED_KEY_BYTES,
  version: ARGON2ID_VERSION
}

const LEGACY_OPTIONS: PasswordHashOptions = {
  t: 2,
  m: 8192,
  p: 3,
  dkLen: DERIVED_KEY_BYTES,
  version: ARGON2ID_VERSION
}

const MAX_MEMORY_KIB = 65536
const MAX_TIME_COST = 10
const MAX_PARALLELISM = 4

const ZERO_SALT = '0'.repeat(SALT_BYTES * 2)
const ZERO_HASH = '0'.repeat(DERIVED_KEY_BYTES * 2)

export const DUMMY_PASSWORD_HASH = `$argon2id$v=${ARGON2ID_VERSION}$m=${CURRENT_OPTIONS.m},t=${CURRENT_OPTIONS.t},p=${CURRENT_OPTIONS.p}$${ZERO_SALT}$${ZERO_HASH}`

const isHex = (value: string) => /^[0-9a-f]+$/i.test(value)

const isValidHex = (value: string | undefined, expectedLength: number) => {
  return (
    typeof value === 'string' && value.length === expectedLength && isHex(value)
  )
}

const toPositiveInteger = (value: string | undefined) => {
  const num = Number(value)
  return Number.isSafeInteger(num) && num > 0 ? num : undefined
}

const parseArgon2idParams = (params: string) => {
  const entries = params.split(',').map((param) => param.split('='))
  if (entries.some((entry) => entry.length !== 2)) {
    return
  }

  const paramsMap = new Map(entries as [string, string][])
  const m = toPositiveInteger(paramsMap.get('m'))
  const t = toPositiveInteger(paramsMap.get('t'))
  const p = toPositiveInteger(paramsMap.get('p'))
  if (!m || !t || !p) {
    return
  }
  if (
    m < 8 * p ||
    m > MAX_MEMORY_KIB ||
    t > MAX_TIME_COST ||
    p > MAX_PARALLELISM
  ) {
    return
  }

  return { m, t, p, dkLen: DERIVED_KEY_BYTES, version: ARGON2ID_VERSION }
}

const parseCurrentHash = (
  hashedPassword: string
): ParsedPasswordHash | undefined => {
  const [empty, algorithm, version, params, salt, hash, ...rest] =
    hashedPassword.split('$')
  if (
    empty !== '' ||
    algorithm !== 'argon2id' ||
    version !== `v=${ARGON2ID_VERSION}` ||
    rest.length > 0 ||
    !params ||
    !isValidHex(salt, SALT_BYTES * 2) ||
    !isValidHex(hash, DERIVED_KEY_BYTES * 2)
  ) {
    return
  }

  const options = parseArgon2idParams(params)
  return options ? { salt, hash, options, legacy: false } : undefined
}

const parseLegacyHash = (
  hashedPassword: string
): ParsedPasswordHash | undefined => {
  const [salt, hash, ...rest] = hashedPassword.split(':')
  if (
    rest.length > 0 ||
    !isValidHex(salt, SALT_BYTES * 2) ||
    !isValidHex(hash, DERIVED_KEY_BYTES * 2)
  ) {
    return
  }

  return { salt, hash, options: LEGACY_OPTIONS, legacy: true }
}

const parsePasswordHash = (hashedPassword: string) => {
  return hashedPassword.startsWith('$argon2id$')
    ? parseCurrentHash(hashedPassword)
    : parseLegacyHash(hashedPassword)
}

const derivePasswordHash = async (
  password: string,
  salt: string,
  options: PasswordHashOptions
) => {
  const derivedKey = await argon2idAsync(password, salt, options)
  return Buffer.from(derivedKey).toString('hex')
}

const timingSafeEqualHex = (actual: string, expected: string) => {
  const actualBuffer = Buffer.from(actual, 'hex')
  const expectedBuffer = Buffer.from(expected, 'hex')
  return (
    actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  )
}

const isCurrentOptions = (options: PasswordHashOptions) => {
  return (
    options.t === CURRENT_OPTIONS.t &&
    options.m === CURRENT_OPTIONS.m &&
    options.p === CURRENT_OPTIONS.p &&
    options.dkLen === CURRENT_OPTIONS.dkLen &&
    options.version === CURRENT_OPTIONS.version
  )
}

export const hashPassword = async (password: string) => {
  const salt = crypto.randomBytes(SALT_BYTES).toString('hex')
  const hash = await derivePasswordHash(password, salt, CURRENT_OPTIONS)
  return `$argon2id$v=${ARGON2ID_VERSION}$m=${CURRENT_OPTIONS.m},t=${CURRENT_OPTIONS.t},p=${CURRENT_OPTIONS.p}$${salt}$${hash}`
}

export const verifyPassword = async (
  password: string,
  hashedPassword: string
) => {
  const parsedHash = parsePasswordHash(hashedPassword)
  if (!parsedHash) {
    return false
  }

  const hash = await derivePasswordHash(
    password,
    parsedHash.salt,
    parsedHash.options
  )
  return timingSafeEqualHex(hash, parsedHash.hash)
}

export const needsPasswordRehash = (hashedPassword: string) => {
  const parsedHash = parsePasswordHash(hashedPassword)
  return (
    !parsedHash || parsedHash.legacy || !isCurrentOptions(parsedHash.options)
  )
}

// import { hash, compare } from 'bcrypt'

// export const hashPassword = async (password: string) => {
//   const hashedPassword = await hash(password, 7)
//   return hashedPassword
// }

// export const verifyPassword = async (
//   password: string,
//   hashedPassword: string
// ) => {
//   const res = await compare(password, hashedPassword)
//   return res
// }
