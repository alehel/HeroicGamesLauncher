import { GlobalConfig } from 'backend/config'
import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret
} from 'backend/utils/secure_secret'
import type {
  CloudStorageConfig,
  CloudStorageConfigUpdate,
  CloudStorageConfigView
} from 'common/types'

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

/** Returns the stored config with the secret still encrypted */
function getStoredConfig(): CloudStorageConfig {
  const stored = GlobalConfig.get().getSettings().cloudStorage
  return { ...defaultCloudStorageConfig, ...(stored ?? {}) }
}

/** Returns the config with the secret decrypted, ready to build a provider */
export function getCloudStorageConfig(): CloudStorageConfig {
  const stored = getStoredConfig()

  // Migrate legacy plaintext secrets on first read
  if (
    stored.secretAccessKey &&
    !isEncryptedSecret(stored.secretAccessKey, CIPHERTEXT_PREFIX)
  ) {
    const reEncrypted = encryptSecret(
      stored.secretAccessKey,
      CIPHERTEXT_PREFIX,
      LABEL
    )
    if (isEncryptedSecret(reEncrypted, CIPHERTEXT_PREFIX)) {
      GlobalConfig.get().setSetting('cloudStorage', {
        ...stored,
        secretAccessKey: reEncrypted
      })
    }
    return stored
  }

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

export function setCloudStorageConfig(update: CloudStorageConfigUpdate) {
  const current = getStoredConfig()
  const { secretAccessKey, ...rest } = update

  const newConfig: CloudStorageConfig = {
    ...current,
    ...rest,
    secretAccessKey:
      secretAccessKey === undefined
        ? current.secretAccessKey
        : encryptSecret(secretAccessKey.trim(), CIPHERTEXT_PREFIX, LABEL)
  }

  return GlobalConfig.get().setSetting('cloudStorage', newConfig)
}

export function isCloudStorageConfigured(
  config: CloudStorageConfig = getStoredConfig()
): boolean {
  return config.provider !== 'none' && !!config.bucket.trim()
}
