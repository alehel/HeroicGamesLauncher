import { TypeCheckedStoreBackend } from 'backend/electron_store'

/**
 * Holds the cloud storage provider configuration, including credentials.
 * Deliberately *not* part of the app settings: every `GlobalConfig` change
 * is written to the log (and sent to the renderer), which must never happen
 * for access keys.
 */
export const cloudStorageStore = new TypeCheckedStoreBackend(
  'cloudStorageStore',
  {
    cwd: 'cloud_storage',
    name: 'config',
    clearInvalidConfig: true
  }
)
