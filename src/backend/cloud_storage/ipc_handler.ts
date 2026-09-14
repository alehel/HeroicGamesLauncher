import { addHandler } from 'backend/ipc'
import { logInfo, LogPrefix, logWarning } from 'backend/logger'
import { isOnline } from 'backend/online_monitor'

import {
  getCloudStorageConfigView,
  setCloudStorageConfig,
  syncCloudStorageSaves,
  testCloudStorageConnection
} from '.'

addHandler('cloudStorage.getConfig', () => getCloudStorageConfigView())

addHandler('cloudStorage.setConfig', (event, config) => {
  setCloudStorageConfig(config)
})

addHandler('cloudStorage.testConnection', async () =>
  testCloudStorageConnection()
)

addHandler('cloudStorage.syncSaves', async (event, args) => {
  if (!isOnline()) {
    logWarning('App is offline, cannot sync saves!', LogPrefix.CloudStorage)
    return 'App is offline, cannot sync saves!'
  }
  try {
    const output = await syncCloudStorageSaves(args)
    logInfo(output, LogPrefix.CloudStorage)
    return output
  } catch (error) {
    logWarning(['Cloud storage sync failed:', error], LogPrefix.CloudStorage)
    return `Cloud storage sync failed: ${
      error instanceof Error ? error.message : String(error)
    }`
  }
})
