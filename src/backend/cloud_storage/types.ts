/**
 * Minimal object-storage abstraction used by the cloud save sync.
 * Implementations only need to support flat key/value semantics, so this
 * maps cleanly onto S3-compatible storage and can later be backed by other
 * providers (WebDAV, rclone, ...) without touching the sync logic.
 */

export interface RemoteObjectSummary {
  key: string
  size: number
  /** Opaque change identifier (S3 ETag) */
  etag?: string
  /** Server-side last-modified time, in ms since epoch */
  lastModifiedMs?: number
}

export interface RemoteObjectDetails extends RemoteObjectSummary {
  /** User-defined metadata stored alongside the object (lower-cased keys) */
  metadata: Record<string, string>
}

export interface CloudStorageProvider {
  /** Lists every object whose key starts with `prefix` */
  listObjects(prefix: string): Promise<RemoteObjectSummary[]>
  /** Returns `null` when the object does not exist */
  headObject(key: string): Promise<RemoteObjectDetails | null>
  /** Downloads `key` into the local file at `destPath` (overwriting it) */
  getObject(key: string, destPath: string): Promise<void>
  /** Uploads the local file at `srcPath` to `key` with the given metadata */
  putObject(
    key: string,
    srcPath: string,
    metadata: Record<string, string>
  ): Promise<void>
  /** Throws (with a human-readable message) when the storage is unreachable */
  testConnection(): Promise<void>
}

export type SyncMode = 'download' | 'upload' | 'force-download' | 'force-upload'

export interface LocalFile {
  /** Path relative to the save folder, always using forward slashes */
  relPath: string
  absPath: string
  size: number
  mtimeMs: number
}

export interface RemoteFile {
  relPath: string
  key: string
  size: number
  /** Modification time of the original local file, if known */
  mtimeMs?: number
  sha256?: string
}

export interface SyncPlan {
  downloads: RemoteFile[]
  uploads: LocalFile[]
  unchanged: string[]
}

export interface SyncResult {
  downloaded: string[]
  uploaded: string[]
  skipped: string[]
  errors: string[]
}
