import { mkdtempSync, rmSync } from 'graceful-fs'
import { mkdir, readFile, stat, symlink, utimes, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import {
  getGameKeyPrefix,
  isSafeRelativePath,
  METADATA_MTIME,
  METADATA_SHA256,
  normalizePrefix,
  planSync,
  scanLocalFiles,
  syncFolder,
  syncModeFromArg
} from '../sync'
import { testSkipOnWindows } from 'backend/__tests__/skip'
import type {
  CloudStorageProvider,
  LocalFile,
  RemoteFile,
  RemoteObjectDetails,
  RemoteObjectSummary
} from '../types'

jest.mock('backend/logger')

/** In-memory stand-in for an object storage bucket */
class FakeProvider implements CloudStorageProvider {
  objects = new Map<
    string,
    { body: Buffer; metadata: Record<string, string> }
  >()
  calls = { list: 0, head: 0, get: 0, put: 0 }

  async listObjects(prefix: string): Promise<RemoteObjectSummary[]> {
    this.calls.list++
    return [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, { body }]) => ({ key, size: body.length }))
  }

  async headObject(key: string): Promise<RemoteObjectDetails | null> {
    this.calls.head++
    const object = this.objects.get(key)
    if (!object) return null
    return { key, size: object.body.length, metadata: object.metadata }
  }

  async getObject(key: string, destPath: string): Promise<void> {
    this.calls.get++
    const object = this.objects.get(key)
    if (!object) throw new Error(`NoSuchKey: ${key}`)
    await writeFile(destPath, object.body)
  }

  async putObject(
    key: string,
    srcPath: string,
    metadata: Record<string, string>
  ): Promise<void> {
    this.calls.put++
    this.objects.set(key, { body: await readFile(srcPath), metadata })
  }

  async testConnection(): Promise<void> {
    return
  }
}

const localFile = (relPath: string, mtimeMs: number, size = 10): LocalFile => ({
  relPath,
  absPath: `/saves/${relPath}`,
  size,
  mtimeMs
})

const remoteFile = (
  relPath: string,
  mtimeMs: number | undefined,
  size = 10
): RemoteFile => ({ relPath, key: `prefix/${relPath}`, size, mtimeMs })

describe('cloud_saves/sync.ts', () => {
  describe('helpers', () => {
    test('syncModeFromArg maps store-style arguments', () => {
      expect(syncModeFromArg('--skip-upload')).toBe('download')
      expect(syncModeFromArg('--skip-download')).toBe('upload')
      expect(syncModeFromArg('--force-download')).toBe('force-download')
      expect(syncModeFromArg('--force-upload')).toBe('force-upload')
      expect(syncModeFromArg(undefined)).toBe('download')
      expect(() => syncModeFromArg('--nope')).toThrow()
    })

    test('normalizePrefix', () => {
      expect(normalizePrefix('')).toBe('')
      expect(normalizePrefix('  ')).toBe('')
      expect(normalizePrefix('/saves/')).toBe('saves/')
      expect(normalizePrefix('a/b')).toBe('a/b/')
    })

    test('getGameKeyPrefix sanitizes identifiers', () => {
      expect(getGameKeyPrefix('heroic-saves', 'gog', '1207658924')).toBe(
        'heroic-saves/gog/1207658924/'
      )
      expect(getGameKeyPrefix('', 'sideload', 'my game/../x')).toBe(
        'sideload/my_game_.._x/'
      )
    })

    test('isSafeRelativePath rejects traversal and absolute paths', () => {
      expect(isSafeRelativePath('save.dat')).toBe(true)
      expect(isSafeRelativePath('slot 1/save.dat')).toBe(true)
      expect(isSafeRelativePath('../save.dat')).toBe(false)
      expect(isSafeRelativePath('a/../../b')).toBe(false)
      expect(isSafeRelativePath('/etc/passwd')).toBe(false)
      expect(isSafeRelativePath('C:/Windows')).toBe(false)
      expect(isSafeRelativePath('')).toBe(false)
      expect(isSafeRelativePath('a//b')).toBe(false)
    })
  })

  describe('planSync', () => {
    const now = 1_700_000_000_000

    test('download: fetches missing and newer remote files only', () => {
      const local = [localFile('same', now), localFile('localNewer', now)]
      const remote = [
        remoteFile('same', now + 1000), // within tolerance
        remoteFile('localNewer', now - 60_000),
        remoteFile('remoteNewer', now + 60_000),
        remoteFile('missingLocally', now)
      ]
      const plan = planSync(
        [...local, localFile('remoteNewer', now)],
        remote,
        'download'
      )
      expect(plan.downloads.map((f) => f.relPath).sort()).toEqual([
        'missingLocally',
        'remoteNewer'
      ])
      expect(plan.uploads).toEqual([])
      expect(plan.unchanged.sort()).toEqual(['localNewer', 'same'])
    })

    test('upload: pushes missing and newer local files only', () => {
      const local = [
        localFile('same', now),
        localFile('localNewer', now + 60_000),
        localFile('onlyLocal', now)
      ]
      const remote = [
        remoteFile('same', now),
        remoteFile('localNewer', now),
        remoteFile('onlyRemote', now)
      ]
      const plan = planSync(local, remote, 'upload')
      expect(plan.uploads.map((f) => f.relPath).sort()).toEqual([
        'localNewer',
        'onlyLocal'
      ])
      expect(plan.downloads).toEqual([])
      expect(plan.unchanged).toEqual(['same'])
    })

    test('falls back to size comparison when the remote mtime is unknown', () => {
      const local = [localFile('a', now, 10), localFile('b', now, 10)]
      const remote = [
        remoteFile('a', undefined, 10),
        remoteFile('b', undefined, 99)
      ]
      expect(planSync(local, remote, 'download').downloads).toEqual([remote[1]])
      expect(planSync(local, remote, 'upload').uploads).toEqual([local[1]])
    })

    test('force modes transfer everything in one direction', () => {
      const local = [localFile('a', now + 60_000)]
      const remote = [remoteFile('a', now), remoteFile('b', now)]
      expect(planSync(local, remote, 'force-download').downloads).toEqual(
        remote
      )
      expect(planSync(local, remote, 'force-download').uploads).toEqual([])
      expect(planSync(local, remote, 'force-upload').uploads).toEqual(local)
      expect(planSync(local, remote, 'force-upload').downloads).toEqual([])
    })
  })

  describe('syncFolder', () => {
    let root: string
    let provider: FakeProvider
    const keyPrefix = 'heroic-saves/sideload/game/'

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'heroic-sync-test-'))
      provider = new FakeProvider()
    })

    afterEach(() => {
      rmSync(root, { recursive: true, force: true })
    })

    async function writeSave(
      dir: string,
      relPath: string,
      content: string,
      mtime: Date
    ) {
      const absPath = join(dir, ...relPath.split('/'))
      await mkdir(join(absPath, '..'), { recursive: true })
      await writeFile(absPath, content)
      await utimes(absPath, mtime, mtime)
      return absPath
    }

    test('upload then download round-trips content, structure and mtimes', async () => {
      const source = join(root, 'source')
      const target = join(root, 'target')
      const mtime = new Date('2024-01-02T03:04:05.000Z')
      await writeSave(source, 'slot1/save.dat', 'hello', mtime)
      await writeSave(source, 'profile.cfg', 'cfg', mtime)

      const uploadReport = await syncFolder(
        provider,
        source,
        keyPrefix,
        'upload'
      )
      expect(uploadReport).toContain('Uploaded: 2')
      expect([...provider.objects.keys()].sort()).toEqual([
        `${keyPrefix}profile.cfg`,
        `${keyPrefix}slot1/save.dat`
      ])
      const stored = provider.objects.get(`${keyPrefix}slot1/save.dat`)!
      expect(stored.metadata[METADATA_MTIME]).toBe(String(mtime.getTime()))
      expect(stored.metadata[METADATA_SHA256]).toHaveLength(64)

      const downloadReport = await syncFolder(
        provider,
        target,
        keyPrefix,
        'download'
      )
      expect(downloadReport).toContain('Downloaded: 2')
      expect(await readFile(join(target, 'slot1', 'save.dat'), 'utf-8')).toBe(
        'hello'
      )
      expect(await readFile(join(target, 'profile.cfg'), 'utf-8')).toBe('cfg')
      const downloadedStats = await stat(join(target, 'slot1', 'save.dat'))
      expect(Math.round(downloadedStats.mtimeMs)).toBe(mtime.getTime())

      // A second download has nothing to do
      const again = await syncFolder(provider, target, keyPrefix, 'download')
      expect(again).toContain('Downloaded: 0')
      expect(again).toContain('Up to date: 2')
    })

    test('newer side wins per file, deletions are not propagated', async () => {
      const a = join(root, 'a')
      const b = join(root, 'b')
      const old = new Date('2024-01-01T00:00:00.000Z')
      const newer = new Date('2024-06-01T00:00:00.000Z')

      await writeSave(a, 'shared.dat', 'from a (old)', old)
      await writeSave(a, 'only-a.dat', 'only a', old)
      await syncFolder(provider, a, keyPrefix, 'upload')

      await writeSave(b, 'shared.dat', 'from b (new)', newer)
      await writeSave(b, 'only-b.dat', 'only b', newer)
      // download must not clobber the newer local copy
      await syncFolder(provider, b, keyPrefix, 'download')
      expect(await readFile(join(b, 'shared.dat'), 'utf-8')).toBe(
        'from b (new)'
      )
      expect(await readFile(join(b, 'only-a.dat'), 'utf-8')).toBe('only a')

      await syncFolder(provider, b, keyPrefix, 'upload')
      expect(
        provider.objects.get(`${keyPrefix}shared.dat`)!.body.toString()
      ).toBe('from b (new)')
      // only-a.dat still exists remotely even though b never had it locally
      // before the download; nothing gets deleted
      expect(provider.objects.has(`${keyPrefix}only-a.dat`)).toBe(true)

      await syncFolder(provider, a, keyPrefix, 'download')
      expect(await readFile(join(a, 'shared.dat'), 'utf-8')).toBe(
        'from b (new)'
      )
      expect(await readFile(join(a, 'only-b.dat'), 'utf-8')).toBe('only b')
    })

    test('skips transfers when content already matches despite mtime drift', async () => {
      const a = join(root, 'a')
      const b = join(root, 'b')
      const t1 = new Date('2024-01-01T00:00:00.000Z')
      const t2 = new Date('2024-02-01T00:00:00.000Z')
      await writeSave(a, 'save.dat', 'identical', t1)
      await syncFolder(provider, a, keyPrefix, 'upload')

      // Same bytes, but touched later (e.g. copied without preserving mtime)
      const bPath = await writeSave(b, 'save.dat', 'identical', t2)
      provider.calls.put = 0
      await syncFolder(provider, b, keyPrefix, 'upload')
      expect(provider.calls.put).toBe(0)

      // And the other way round: remote "newer" but identical -> no download,
      // local mtime gets aligned with the remote one
      provider.objects.get(`${keyPrefix}save.dat`)!.metadata[METADATA_MTIME] =
        String(t2.getTime() + 60_000)
      provider.calls.get = 0
      await syncFolder(provider, b, keyPrefix, 'download')
      expect(provider.calls.get).toBe(0)
      expect(Math.round((await stat(bPath)).mtimeMs)).toBe(
        t2.getTime() + 60_000
      )
    })

    test('force-download overwrites newer local files', async () => {
      const a = join(root, 'a')
      const old = new Date('2024-01-01T00:00:00.000Z')
      const newer = new Date('2024-06-01T00:00:00.000Z')
      await writeSave(a, 'save.dat', 'remote', old)
      await syncFolder(provider, a, keyPrefix, 'upload')
      await writeSave(a, 'save.dat', 'local', newer)

      await syncFolder(provider, a, keyPrefix, 'download')
      expect(await readFile(join(a, 'save.dat'), 'utf-8')).toBe('local')

      await syncFolder(provider, a, keyPrefix, 'force-download')
      expect(await readFile(join(a, 'save.dat'), 'utf-8')).toBe('remote')
    })

    test('refuses to write remote objects with unsafe paths', async () => {
      const target = join(root, 'target')
      provider.objects.set(`${keyPrefix}../escape.dat`, {
        body: Buffer.from('evil'),
        metadata: {}
      })
      provider.objects.set(`${keyPrefix}fine.dat`, {
        body: Buffer.from('ok'),
        metadata: {}
      })

      const report = await syncFolder(provider, target, keyPrefix, 'download')
      expect(report).toContain('Refusing to write unsafe path')
      expect(await readFile(join(target, 'fine.dat'), 'utf-8')).toBe('ok')
      const files = await scanLocalFiles(root)
      expect(files.map((f) => f.relPath)).toEqual(['target/fine.dat'])
    })

    testSkipOnWindows(
      'scanLocalFiles ignores symlinks and uses forward slashes',
      async () => {
        const dir = join(root, 'scan')
        const real = await writeSave(
          dir,
          'nested/deeper/file.bin',
          'x',
          new Date()
        )
        await symlink(real, join(dir, 'link.bin'))
        const files = await scanLocalFiles(dir)
        expect(files.map((f) => f.relPath)).toEqual(['nested/deeper/file.bin'])
      }
    )
  })
})
