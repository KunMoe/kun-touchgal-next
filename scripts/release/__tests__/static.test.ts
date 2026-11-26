import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { carryOverStatic, listStaticFiles } from '../static'
import { makeTempDir, removeTempDir } from './support/tempDir'

let root: string

const writeFile = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

beforeEach(() => {
  root = makeTempDir('static')
})

afterEach(() => {
  removeTempDir(root)
})

describe('listStaticFiles', () => {
  it('lists regular files as sorted POSIX paths relative to the dir', () => {
    const dir = path.join(root, 'static')
    writeFile(path.join(dir, 'chunks', 'b.js'), 'b')
    writeFile(path.join(dir, 'chunks', 'a.js'), 'a')
    writeFile(path.join(dir, 'build-id', '_buildManifest.js'), 'm')
    writeFile(path.join(dir, 'media', 'deep', 'font.woff2'), 'f')
    fs.mkdirSync(path.join(dir, 'empty'))
    fs.symlinkSync('chunks/a.js', path.join(dir, 'link.js'))
    expect(listStaticFiles(dir)).toEqual([
      'build-id/_buildManifest.js',
      'chunks/a.js',
      'chunks/b.js',
      'media/deep/font.woff2'
    ])
  })

  it('is empty when the dir does not exist', () => {
    expect(listStaticFiles(path.join(root, 'missing'))).toEqual([])
  })
})

describe('carryOverStatic', () => {
  it('hard-links files missing from the target, creating parent dirs', () => {
    const source = path.join(root, 'old')
    const target = path.join(root, 'new')
    writeFile(path.join(source, 'chunks', 'old.js'), 'old chunk')
    writeFile(path.join(source, 'media', 'x', 'font.woff2'), 'font')
    fs.mkdirSync(target)

    expect(
      carryOverStatic(target, [
        { staticDir: source, files: ['chunks/old.js', 'media/x/font.woff2'] }
      ])
    ).toBe(2)
    const carried = fs.statSync(path.join(target, 'chunks', 'old.js'))
    expect(carried.ino).toBe(
      fs.statSync(path.join(source, 'chunks', 'old.js')).ino
    )
    expect(carried.nlink).toBe(2)
    expect(
      fs.readFileSync(path.join(target, 'media', 'x', 'font.woff2'), 'utf8')
    ).toBe('font')
  })

  it('never replaces what the target already has; the first source wins', () => {
    const newer = path.join(root, 'newer')
    const older = path.join(root, 'older')
    const target = path.join(root, 'new')
    writeFile(path.join(target, 'chunks', 'same.js'), 'new build')
    writeFile(path.join(newer, 'chunks', 'same.js'), 'newer build')
    writeFile(path.join(newer, 'chunks', 'shared.js'), 'from newer')
    writeFile(path.join(older, 'chunks', 'shared.js'), 'from older')
    // 目标里有目录的地方来源是文件, 目标里有文件的地方来源是目录
    fs.mkdirSync(path.join(target, 'taken-by-dir'))
    writeFile(path.join(newer, 'taken-by-dir'), 'file')
    writeFile(path.join(target, 'taken-by-file'), 'file')
    writeFile(path.join(newer, 'taken-by-file', 'inner.js'), 'inner')
    const ownIno = fs.statSync(path.join(target, 'chunks', 'same.js')).ino

    expect(
      carryOverStatic(target, [
        {
          staticDir: newer,
          files: [
            'chunks/same.js',
            'chunks/shared.js',
            'taken-by-dir',
            'taken-by-file/inner.js'
          ]
        },
        { staticDir: older, files: ['chunks/shared.js'] }
      ])
    ).toBe(1)
    const same = path.join(target, 'chunks', 'same.js')
    expect(fs.readFileSync(same, 'utf8')).toBe('new build')
    expect(fs.statSync(same).ino).toBe(ownIno)
    expect(
      fs.readFileSync(path.join(target, 'chunks', 'shared.js'), 'utf8')
    ).toBe('from newer')
    expect(fs.statSync(path.join(target, 'taken-by-dir')).isDirectory()).toBe(
      true
    )
    expect(fs.readFileSync(path.join(target, 'taken-by-file'), 'utf8')).toBe(
      'file'
    )
  })

  it('skips files that are gone from the source and entries that are not regular files', () => {
    const source = path.join(root, 'old')
    const target = path.join(root, 'new')
    writeFile(path.join(source, 'chunks', 'kept.js'), 'kept')
    fs.mkdirSync(path.join(source, 'a-dir'))
    fs.symlinkSync('chunks/kept.js', path.join(source, 'link.js'))
    fs.mkdirSync(target)

    expect(
      carryOverStatic(target, [
        {
          staticDir: source,
          files: ['chunks/gone.js', 'chunks/kept.js', 'a-dir', 'link.js']
        },
        { staticDir: path.join(root, 'deleted'), files: ['chunks/x.js'] }
      ])
    ).toBe(1)
    expect(fs.readdirSync(target)).toEqual(['chunks'])
    expect(fs.readdirSync(path.join(target, 'chunks'))).toEqual(['kept.js'])
  })

  it('rejects entries that would leave the static dirs', () => {
    const source = path.join(root, 'release', 'static')
    const target = path.join(root, 'new', 'static')
    const secret = path.join(root, 'release', 'secret.txt')
    writeFile(secret, 'secret')
    writeFile(path.join(source, 'chunks', 'a.js'), 'a')
    fs.mkdirSync(target, { recursive: true })

    expect(
      carryOverStatic(target, [
        {
          staticDir: source,
          files: [
            '../secret.txt',
            'chunks/../../secret.txt',
            secret,
            '',
            './chunks/a.js',
            'chunks//a.js'
          ]
        }
      ])
    ).toBe(0)
    expect(fs.readdirSync(target)).toEqual([])
    expect(fs.readdirSync(path.join(root, 'new'))).toEqual(['static'])
  })
})
