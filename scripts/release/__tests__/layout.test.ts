import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { kunReleaseLayout } from '../layout.cjs'
import {
  KUN_RELEASE_MANIFEST,
  isReleaseId,
  kunReleaseLayoutFor,
  listReleases,
  makeReleaseId,
  planPrune,
  readCurrentReleaseId,
  releaseDirOf,
  removeRelease,
  switchCurrentRelease,
  writeReleaseManifest
} from '../layout'
import { makeTempDir, removeTempDir } from './support/tempDir'
import type { ReleaseId, ReleaseLayout, ReleaseManifest } from '../layout'

const id = (value: string) => {
  if (!isReleaseId(value)) {
    throw new Error(`bad fixture id ${value}`)
  }
  return value
}

const manifestOf = (releaseId: ReleaseId): ReleaseManifest => ({
  id: releaseId,
  gitSha: `${releaseId.slice(-7)}${'0'.repeat(33)}`,
  builtAt: '2026-11-26T00:00:00.000Z',
  node: 'v26.12.1',
  nextBuildId: 'build-id',
  distDir: '.next-deploy'
})

let root: string
let layout: ReleaseLayout

const addRelease = (releaseId: ReleaseId, manifest = true) => {
  const dir = releaseDirOf(layout, releaseId)
  fs.mkdirSync(dir, { recursive: true })
  if (manifest) {
    writeReleaseManifest(dir, manifestOf(releaseId))
  }
  return dir
}

beforeEach(() => {
  root = makeTempDir('layout')
  layout = kunReleaseLayoutFor(root)
})

afterEach(() => {
  removeTempDir(root)
})

describe('kunReleaseLayout', () => {
  it('puts the release root next to the checkout, never inside it', () => {
    const repoDir = path.join(root, 'kun-touchgal-next')
    const repoLayout = kunReleaseLayout(repoDir)
    expect(repoLayout.root).toBe(path.join(root, 'kun-touchgal-next-releases'))
    expect(path.relative(repoDir, repoLayout.root).startsWith('..')).toBe(true)
    expect(repoLayout.releasesDir).toBe(path.join(repoLayout.root, 'releases'))
    expect(repoLayout.currentLink).toBe(path.join(repoLayout.root, 'current'))
  })
})

describe('makeReleaseId', () => {
  it('is the UTC time to the second plus the short sha, so ids sort by build time', () => {
    const first = makeReleaseId(
      new Date('2026-11-26T03:04:05.678Z'),
      'FC8B626BDEADBEEF'
    )
    expect(first).toBe('20261126030405-fc8b626')
    const later = makeReleaseId(new Date('2026-11-26T03:04:06Z'), 'fc8b626b')
    expect(later > first).toBe(true)
  })

  it('rejects something that is not a commit sha', () => {
    expect(() => makeReleaseId(new Date(), 'main')).toThrow()
    expect(() => makeReleaseId(new Date(), 'abc12')).toThrow()
  })
})

describe('listReleases', () => {
  it('lists releases with a valid manifest, newest first', () => {
    addRelease(id('20261101000000-aaaaaaa'))
    addRelease(id('20261103000000-ccccccc'))
    addRelease(id('20261102000000-bbbbbbb'))
    expect(listReleases(layout).map((manifest) => manifest.id)).toEqual([
      '20261103000000-ccccccc',
      '20261102000000-bbbbbbb',
      '20261101000000-aaaaaaa'
    ])
  })

  it('skips directories that are not finished releases', () => {
    addRelease(id('20261101000000-aaaaaaa'))
    // moved in but the manifest was never written
    addRelease(id('20261102000000-bbbbbbb'), false)
    fs.mkdirSync(path.join(layout.releasesDir, 'not-a-release'))
    // manifest copied from another release
    const dir = addRelease(id('20261103000000-ccccccc'), false)
    writeReleaseManifest(dir, manifestOf(id('20261101000000-aaaaaaa')))
    fs.writeFileSync(
      path.join(
        addRelease(id('20261104000000-ddddddd'), false),
        KUN_RELEASE_MANIFEST
      ),
      '{ broken'
    )
    expect(listReleases(layout).map((manifest) => manifest.id)).toEqual([
      '20261101000000-aaaaaaa'
    ])
  })

  it('is empty before the first release', () => {
    expect(listReleases(layout)).toEqual([])
  })
})

describe('current release link', () => {
  it('is null before the first switch (the legacy layout is live)', () => {
    expect(readCurrentReleaseId(layout)).toBeNull()
  })

  it('switches atomically through a relative link and can go back to the legacy layout', () => {
    const first = id('20261101000000-aaaaaaa')
    const second = id('20261102000000-bbbbbbb')
    addRelease(first)
    addRelease(second)

    switchCurrentRelease(layout, first)
    expect(readCurrentReleaseId(layout)).toBe(first)
    expect(fs.readlinkSync(layout.currentLink)).toBe(
      path.join('releases', first)
    )

    switchCurrentRelease(layout, second)
    expect(readCurrentReleaseId(layout)).toBe(second)
    expect(fs.existsSync(`${layout.currentLink}.tmp`)).toBe(false)

    switchCurrentRelease(layout, null)
    expect(readCurrentReleaseId(layout)).toBeNull()
  })

  it('refuses to point current at a release that does not exist', () => {
    fs.mkdirSync(layout.releasesDir, { recursive: true })
    expect(() =>
      switchCurrentRelease(layout, id('20261101000000-aaaaaaa'))
    ).toThrow()
    expect(readCurrentReleaseId(layout)).toBeNull()
  })

  it('does not guess when current is not a link into releases/', () => {
    fs.mkdirSync(root, { recursive: true })
    fs.symlinkSync('/somewhere/else', layout.currentLink)
    expect(() => readCurrentReleaseId(layout)).toThrow()
    fs.rmSync(layout.currentLink)
    fs.mkdirSync(layout.currentLink)
    expect(() => readCurrentReleaseId(layout)).toThrow()
  })

  it('never removes the live release', () => {
    const live = id('20261101000000-aaaaaaa')
    const old = id('20261031000000-bbbbbbb')
    addRelease(live)
    addRelease(old)
    switchCurrentRelease(layout, live)
    expect(() => removeRelease(layout, live)).toThrow()
    removeRelease(layout, old)
    expect(listReleases(layout).map((manifest) => manifest.id)).toEqual([live])
  })
})

describe('planPrune', () => {
  const ids = [
    id('20261101000000-aaaaaaa'),
    id('20261105000000-eeeeeee'),
    id('20261103000000-ccccccc'),
    id('20261102000000-bbbbbbb'),
    id('20261104000000-ddddddd')
  ]

  it('keeps the newest three and prunes the rest', () => {
    expect(planPrune(ids, id('20261105000000-eeeeeee'))).toEqual([
      '20261102000000-bbbbbbb',
      '20261101000000-aaaaaaa'
    ])
  })

  it('also keeps an older live release after a rollback', () => {
    expect(planPrune(ids, id('20261101000000-aaaaaaa'))).toEqual([
      '20261102000000-bbbbbbb'
    ])
  })

  it('prunes nothing while there are no more than keep releases', () => {
    expect(planPrune(ids.slice(0, 3), null)).toEqual([])
  })
})
