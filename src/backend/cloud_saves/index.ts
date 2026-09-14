import type {
  CloudStorageConfig,
  CloudStorageSyncArgs,
  CloudStorageTestResult
} from 'common/types'

import { logError, logInfo, LogPrefix } from 'backend/logger'
import type { CloudStorageProvider } from './types'
import { S3Provider } from './s3'
import { getGameKeyPrefix, syncFolder, syncModeFromArg } from './sync'
import {
  getCloudStorageConfig,
  isCloudStorageConfigured,
  setCloudStorageConfig,
  getCloudStorageConfigView
} from './config'

export {
  getCloudStorageConfig,
  getCloudStorageConfigView,
  setCloudStorageConfig
}

function createCloudStorageProvider(
  config: CloudStorageConfig
): CloudStorageProvider {
  switch (config.provider) {
    case 's3':
      return new S3Provider(config)
    case 'none':
      throw new Error('No cloud storage provider configured')
  }
}

/**
 * Syncs a game's save folder with the configured cloud storage.
 * `arg` accepts the same values the store-specific save sync uses
 * (`--skip-upload`, `--skip-download`, `--force-download`, `--force-upload`)
 */
export async function syncCloudStorageSaves({
  appName,
  runner,
  path,
  arg
}: CloudStorageSyncArgs): Promise<string> {
  const config = getCloudStorageConfig()
  if (!isCloudStorageConfigured(config)) {
    throw new Error(
      'Cloud storage is not configured. Set it up in Settings > Advanced.'
    )
  }
  if (!path) {
    throw new Error('No save folder configured for cloud storage sync')
  }

  const mode = syncModeFromArg(arg)
  const provider = createCloudStorageProvider(config)
  const keyPrefix = getGameKeyPrefix(config.prefix, runner, appName)

  logInfo(
    `Syncing saves of ${appName} (${runner}) with ${config.provider} storage`,
    LogPrefix.CloudSaves
  )
  return syncFolder(provider, path, keyPrefix, mode)
}

export async function testCloudStorageConnection(
  config: CloudStorageConfig
): Promise<CloudStorageTestResult> {
  if (!isCloudStorageConfigured(config)) {
    return { success: false, message: 'Provider or bucket not set' }
  }
  try {
    await createCloudStorageProvider(config).testConnection()
    return { success: true, message: 'Connection successful' }
  } catch (error) {
    logError(
      ['Cloud storage connection test failed:', error],
      LogPrefix.CloudSaves
    )
    return { success: false, message: describeError(error) }
  }
}

function describeError(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const { name, message, $metadata } = error as {
      name?: string
      message?: string
      $metadata?: { httpStatusCode?: number }
    }
    const status = $metadata?.httpStatusCode
      ? ` (HTTP ${$metadata.httpStatusCode})`
      : ''
    return `${name ?? 'Error'}: ${message ?? 'Unknown error'}${status}`
  }
  return String(error)
}
