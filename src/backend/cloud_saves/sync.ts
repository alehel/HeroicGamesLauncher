import { createHash } from 'crypto'
import { createReadStream } from 'graceful-fs'
import { copyFile, mkdir, readdir, rename, rm, stat, utimes } from 'fs/promises'
import { dirname, join, posix, relative, resolve, sep } from 'path'
import { tmpdir } from 'os'

import { logDebug, logInfo, LogPrefix, logWarning } from 'backend/logger'

import type {
  CloudStorageProvider,
  LocalFile,
  RemoteFile,
  RemoteObjectSummary,
  SyncMode,
  SyncPlan,
  SyncResult
} from './types'

/**
 * Two files are considered "equally new" when their modification times are
 * within this window. Some filesystems (FAT, exFAT) only keep 2-second
 * precision, and object storage metadata is a string round-trip anyway.
 */
const MTIME_TOLERANCE_MS = 2000

/** How many objects we talk to the storage about at the same time */
const CONCURRENCY = 8

/** Metadata keys stored on every uploaded object */
export const METADATA_MTIME = 'mtime'
export const METADATA_SHA256 = 'sha256'

/**
 * Maps the CLI-style arguments used by the store save sync (legendary/gogdl)
 * onto our own sync modes, so the frontend can keep using the same values.
 */
export function syncModeFromArg(arg: string | undefined): SyncMode {
  switch (arg) {
    case '--skip-upload':
    case 'download':
    case '':
    case undefined:
      return 'download'
    case '--skip-download':
    case 'upload':
      return 'upload'
    case '--force-download':
    case 'force-download':
      return 'force-download'
    case '--force-upload':
    case 'force-upload':
      return 'force-upload'
    default:
      throw new Error(`Unknown sync argument "${arg}"`)
  }
}

/** Turns an arbitrary identifier into something safe to use in an object key */
function sanitizeKeySegment(segment: string): string {
  return segment.replace(/[^A-Za-z0-9._-]/g, '_')
}

/**
 * Normalizes a user-provided prefix ("folder") so it can be prepended to
 * keys: no leading slash, and exactly one trailing slash when not empty
 */
export function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/^\/+|\/+$/g, '')
  return trimmed ? `${trimmed}/` : ''
}

/** Builds the key prefix all objects of one game live under */
export function getGameKeyPrefix(
  prefix: string,
  runner: string,
  appName: string
): string {
  return `${normalizePrefix(prefix)}${sanitizeKeySegment(
    runner
  )}/${sanitizeKeySegment(appName)}/`
}

/**
 * Rejects relative paths that could escape the save folder when a remote
 * key is turned into a local path (e.g. a malicious or corrupted bucket)
 */
export function isSafeRelativePath(relPath: string): boolean {
  if (!relPath || relPath.startsWith('/') || /^[A-Za-z]:/.test(relPath)) {
    return false
  }
  const segments = relPath.split('/')
  return segments.every(
    (segment) => segment !== '' && segment !== '.' && segment !== '..'
  )
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length)
  let next = 0
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++
        results[index] = await fn(items[index])
      }
    }
  )
  await Promise.all(workers)
  return results
}

async function hashFile(absPath: string): Promise<string> {
  return new Promise((res, rej) => {
    const hash = createHash('sha256')
    createReadStream(absPath)
      .on('error', rej)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => res(hash.digest('hex')))
  })
}

/** Recursively lists all regular files inside `dir` */
export async function scanLocalFiles(dir: string): Promise<LocalFile[]> {
  const root = resolve(dir)
  const files: LocalFile[] = []

  async function walk(current: string) {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const absPath = join(current, entry.name)
      if (entry.isSymbolicLink()) {
        logDebug(['Skipping symlink', absPath], LogPrefix.CloudSaves)
        continue
      }
      if (entry.isDirectory()) {
        await walk(absPath)
      } else if (entry.isFile()) {
        const stats = await stat(absPath)
        files.push({
          relPath: relative(root, absPath).split(sep).join(posix.sep),
          absPath,
          size: stats.size,
          mtimeMs: stats.mtimeMs
        })
      }
    }
  }

  await walk(root)
  return files
}

/**
 * Lists the remote files of one game. Object listings don't include user
 * metadata, so every object is HEADed (concurrently) to learn the original
 * modification time and content hash we stored on upload.
 */
async function scanRemoteFiles(
  provider: CloudStorageProvider,
  keyPrefix: string
): Promise<RemoteFile[]> {
  const objects = await provider.listObjects(keyPrefix)
  const relevant = objects.filter(
    (object) => object.key.startsWith(keyPrefix) && !object.key.endsWith('/')
  )

  return mapLimit(relevant, CONCURRENCY, async (object) =>
    describeRemoteObject(provider, keyPrefix, object)
  )
}

async function describeRemoteObject(
  provider: CloudStorageProvider,
  keyPrefix: string,
  object: RemoteObjectSummary
): Promise<RemoteFile> {
  const relPath = object.key.slice(keyPrefix.length)
  const file: RemoteFile = {
    relPath,
    key: object.key,
    size: object.size,
    mtimeMs: object.lastModifiedMs
  }

  try {
    const details = await provider.headObject(object.key)
    if (details) {
      const mtime = Number(details.metadata[METADATA_MTIME])
      if (Number.isFinite(mtime) && mtime > 0) file.mtimeMs = mtime
      if (details.metadata[METADATA_SHA256]) {
        file.sha256 = details.metadata[METADATA_SHA256]
      }
      if (details.size !== undefined) file.size = details.size
    }
  } catch (error) {
    logWarning(
      [`Could not read metadata of ${object.key}:`, error],
      LogPrefix.CloudSaves
    )
  }

  return file
}

/**
 * Decides which files need to move in which direction. Pure function, so it
 * can be unit-tested without touching the filesystem or the network.
 *
 * - `download`: fetch remote files that are missing locally or newer than
 *   the local copy
 * - `upload`: push local files that are missing remotely or newer than the
 *   remote copy
 * - `force-download` / `force-upload`: transfer everything in that direction
 *   regardless of timestamps
 *
 * Deletions are never propagated: a file that exists on only one side is
 * simply copied to the other side (or left alone, depending on the mode).
 */
export function planSync(
  local: LocalFile[],
  remote: RemoteFile[],
  mode: SyncMode,
  toleranceMs = MTIME_TOLERANCE_MS
): SyncPlan {
  const plan: SyncPlan = { downloads: [], uploads: [], unchanged: [] }
  const localByPath = new Map(local.map((file) => [file.relPath, file]))
  const remoteByPath = new Map(remote.map((file) => [file.relPath, file]))

  switch (mode) {
    case 'force-download':
      plan.downloads = [...remote]
      return plan
    case 'force-upload':
      plan.uploads = [...local]
      return plan
    case 'download':
      for (const remoteFile of remote) {
        const localFile = localByPath.get(remoteFile.relPath)
        if (!localFile || isNewer(remoteFile, localFile, toleranceMs)) {
          plan.downloads.push(remoteFile)
        } else {
          plan.unchanged.push(remoteFile.relPath)
        }
      }
      return plan
    case 'upload':
      for (const localFile of local) {
        const remoteFile = remoteByPath.get(localFile.relPath)
        if (!remoteFile || isNewer(localFile, remoteFile, toleranceMs)) {
          plan.uploads.push(localFile)
        } else {
          plan.unchanged.push(localFile.relPath)
        }
      }
      return plan
  }
}

/**
 * Whether `candidate` should replace `other`. When the candidate's
 * modification time is unknown we fall back to comparing sizes.
 */
function isNewer(
  candidate: { mtimeMs?: number; size: number },
  other: { mtimeMs?: number; size: number },
  toleranceMs: number
): boolean {
  if (candidate.mtimeMs === undefined || other.mtimeMs === undefined) {
    return candidate.size !== other.size
  }
  return candidate.mtimeMs > other.mtimeMs + toleranceMs
}

function toLocalPath(saveDir: string, relPath: string): string {
  return join(saveDir, ...relPath.split('/'))
}

/**
 * Executes a sync plan against the storage provider.
 * Files whose content already matches on both sides (same size and hash)
 * are skipped even when their timestamps differ, to avoid needless traffic.
 */
async function executeSyncPlan(
  provider: CloudStorageProvider,
  saveDir: string,
  keyPrefix: string,
  plan: SyncPlan,
  localFiles: LocalFile[],
  remoteFiles: RemoteFile[]
): Promise<SyncResult> {
  const result: SyncResult = {
    downloaded: [],
    uploaded: [],
    skipped: [...plan.unchanged],
    errors: []
  }
  const localByPath = new Map(localFiles.map((file) => [file.relPath, file]))
  const remoteByPath = new Map(remoteFiles.map((file) => [file.relPath, file]))

  await mapLimit(plan.downloads, CONCURRENCY, async (remoteFile) => {
    if (!isSafeRelativePath(remoteFile.relPath)) {
      result.errors.push(
        `Refusing to write unsafe path "${remoteFile.relPath}"`
      )
      return
    }
    const destPath = toLocalPath(saveDir, remoteFile.relPath)
    try {
      const localFile = localByPath.get(remoteFile.relPath)
      if (await contentMatches(localFile, remoteFile)) {
        // Same content, just align the timestamp so future syncs agree
        await touch(destPath, remoteFile.mtimeMs)
        result.skipped.push(remoteFile.relPath)
        return
      }
      await downloadToFile(provider, remoteFile, destPath)
      result.downloaded.push(remoteFile.relPath)
    } catch (error) {
      result.errors.push(
        `Failed to download ${remoteFile.relPath}: ${errorMessage(error)}`
      )
    }
  })

  await mapLimit(plan.uploads, CONCURRENCY, async (localFile) => {
    try {
      const sha256 = await hashFile(localFile.absPath)
      const remoteFile = remoteByPath.get(localFile.relPath)
      if (
        remoteFile &&
        remoteFile.sha256 === sha256 &&
        remoteFile.size === localFile.size
      ) {
        // Remote already holds exactly this content
        result.skipped.push(localFile.relPath)
        return
      }
      await provider.putObject(
        keyPrefix + localFile.relPath,
        localFile.absPath,
        {
          [METADATA_MTIME]: String(Math.round(localFile.mtimeMs)),
          [METADATA_SHA256]: sha256
        }
      )
      result.uploaded.push(localFile.relPath)
    } catch (error) {
      result.errors.push(
        `Failed to upload ${localFile.relPath}: ${errorMessage(error)}`
      )
    }
  })

  return result
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function contentMatches(
  localFile: LocalFile | undefined,
  remoteFile: RemoteFile
): Promise<boolean> {
  if (!localFile || !remoteFile.sha256 || localFile.size !== remoteFile.size) {
    return false
  }
  return (await hashFile(localFile.absPath)) === remoteFile.sha256
}

async function downloadToFile(
  provider: CloudStorageProvider,
  remoteFile: RemoteFile,
  destPath: string
) {
  await mkdir(dirname(destPath), { recursive: true })
  const tmpPath = join(
    tmpdir(),
    `heroic-save-${process.pid}-${Math.random().toString(36).slice(2)}`
  )
  try {
    await provider.getObject(remoteFile.key, tmpPath)
    await rename(tmpPath, destPath).catch(async (error: unknown) => {
      // rename() fails across filesystems; fall back to copy + delete
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code !== 'EXDEV') throw error
      await copyFile(tmpPath, destPath)
      await rm(tmpPath, { force: true })
    })
    await touch(destPath, remoteFile.mtimeMs)
  } finally {
    await rm(tmpPath, { force: true })
  }
}

async function touch(absPath: string, mtimeMs: number | undefined) {
  if (mtimeMs === undefined) return
  const date = new Date(mtimeMs)
  await utimes(absPath, date, date)
}

function formatSyncResult(mode: SyncMode, result: SyncResult): string {
  const lines: string[] = [`Cloud storage sync (${mode}) finished.`]
  lines.push(`Downloaded: ${result.downloaded.length}`)
  lines.push(`Uploaded: ${result.uploaded.length}`)
  lines.push(`Up to date: ${result.skipped.length}`)
  for (const file of result.downloaded) lines.push(`  ↓ ${file}`)
  for (const file of result.uploaded) lines.push(`  ↑ ${file}`)
  if (result.errors.length) {
    lines.push(`Errors: ${result.errors.length}`)
    for (const error of result.errors) lines.push(`  ! ${error}`)
  }
  return lines.join('\n')
}

/**
 * Syncs one local folder with the objects under `keyPrefix`.
 * Returns a human-readable report (shown in the UI and written to the log).
 */
export async function syncFolder(
  provider: CloudStorageProvider,
  saveDir: string,
  keyPrefix: string,
  mode: SyncMode
): Promise<string> {
  await mkdir(saveDir, { recursive: true })

  const [localFiles, remoteFiles] = await Promise.all([
    scanLocalFiles(saveDir),
    scanRemoteFiles(provider, keyPrefix)
  ])

  const plan = planSync(localFiles, remoteFiles, mode)
  logInfo(
    [
      `Syncing ${saveDir} <-> ${keyPrefix} (${mode}):`,
      `${plan.downloads.length} to download,`,
      `${plan.uploads.length} to upload,`,
      `${plan.unchanged.length} unchanged`
    ],
    LogPrefix.CloudSaves
  )

  const result = await executeSyncPlan(
    provider,
    saveDir,
    keyPrefix,
    plan,
    localFiles,
    remoteFiles
  )
  const report = formatSyncResult(mode, result)
  if (result.errors.length) {
    logWarning(report, LogPrefix.CloudSaves)
  } else {
    logInfo(report, LogPrefix.CloudSaves)
  }
  return report
}
