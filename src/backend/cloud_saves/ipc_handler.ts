import { addHandler } from 'backend/ipc'
import { logInfo, LogPrefix, logWarning } from 'backend/logger'
import { isOnline } from 'backend/online_monitor'

import {
  getCloudStorageConfig,
  getCloudStorageConfigView,
  setCloudStorageConfig,
  syncCloudStorageSaves,
  testCloudStorageConnection
} from '.'

addHandler('cloudStorage.getConfig', () => getCloudStorageConfigView())

addHandler('cloudStorage.setConfig', (event, config) => {
  setCloudStorageConfig(config)
})

addHandler('cloudStorage.testConnection', async (event, update) => {
  // The frontend only has the secret when the user just typed it; otherwise
  // fall back to the stored one
  const stored = getCloudStorageConfig()
  const { secretAccessKey, ...rest } = update
  return testCloudStorageConnection({
    ...stored,
    ...rest,
    secretAccessKey: secretAccessKey ?? stored.secretAccessKey
  })
})

addHandler('cloudStorage.syncSaves', async (event, args) => {
  if (!isOnline()) {
    logWarning('App is offline, cannot sync saves!', LogPrefix.CloudSaves)
    return 'App is offline, cannot sync saves!'
  }
  try {
    const output = await syncCloudStorageSaves(args)
    logInfo(output, LogPrefix.CloudSaves)
    return output
  } catch (error) {
    logWarning(['Cloud storage sync failed:', error], LogPrefix.CloudSaves)
    return `Cloud storage sync failed: ${
      error instanceof Error ? error.message : String(error)
    }`
  }
})
