import { decryptSecret, encryptSecret } from 'backend/utils/secure_secret'
import type {
  CloudStorageConfig,
  CloudStorageConfigUpdate,
  CloudStorageConfigView
} from 'common/types'
import { cloudStorageStore } from './electronStores'

const CIPHERTEXT_PREFIX = 'hcs:v1:'
const LABEL = 'cloud storage secret access key'

const defaultCloudStorageConfig: CloudStorageConfig = {
  provider: 'none',
  endpoint: '',
  region: '',
  bucket: '',
  prefix: 'heroic-saves',
  accessKeyId: '',
  secretAccessKey: '',
  forcePathStyle: false
}

/** The config as stored on disk, secret still encrypted */
function getStoredConfig(): CloudStorageConfig {
  return {
    ...defaultCloudStorageConfig,
    ...cloudStorageStore.get('config', defaultCloudStorageConfig)
  }
}

/** The config with the secret decrypted, ready to build a provider */
export function getCloudStorageConfig(): CloudStorageConfig {
  const stored = getStoredConfig()
  return {
    ...stored,
    secretAccessKey: decryptSecret(
      stored.secretAccessKey,
      CIPHERTEXT_PREFIX,
      LABEL
    )
  }
}

/** The frontend never gets to see the secret, only whether one is set */
export function getCloudStorageConfigView(): CloudStorageConfigView {
  const { secretAccessKey, ...rest } = getStoredConfig()
  return { ...rest, hasSecretAccessKey: !!secretAccessKey }
}

/** Saves the config; an omitted secret keeps the currently stored one */
export function setCloudStorageConfig(update: CloudStorageConfigUpdate) {
  const { secretAccessKey, ...rest } = update
  const current = getStoredConfig()

  cloudStorageStore.set('config', {
    ...current,
    ...rest,
    secretAccessKey:
      secretAccessKey === undefined
        ? current.secretAccessKey
        : encryptSecret(secretAccessKey.trim(), CIPHERTEXT_PREFIX, LABEL)
  })
}

export function isCloudStorageConfigured(config: CloudStorageConfig): boolean {
  return config.provider !== 'none' && !!config.bucket.trim()
}
