import { useContext } from 'react'
import { useTranslation } from 'react-i18next'
import useSetting from 'frontend/hooks/useSetting'
import ContextProvider from 'frontend/state/ContextProvider'
import SettingsContext from '../../SettingsContext'
import { defaultWineVersion } from '../..'
import GOGSyncSaves from './gog'
import LegendarySyncSaves from './legendary'
import CloudStorageSyncSaves from './cloudStorage'
import { ToggleSwitch } from 'frontend/components/UI'

const SyncSaves = () => {
  const { t } = useTranslation()
  const { runner, gameInfo } = useContext(SettingsContext)
  const { platform } = useContext(ContextProvider)
  const isWin = platform === 'win32'

  const [autoSyncSaves, setAutoSyncSaves] = useSetting('autoSyncSaves', false)
  const [savesPath, setSavesPath] = useSetting('savesPath', '')
  const [gogSavesLocations, setGogSavesLocations] = useSetting('gogSaves', [])
  const [enableQuickSavesMenu, setEnableQuickSavesMenu] = useSetting(
    'enableQuickSavesMenu',
    false
  )

  const [sharedWinePrefix] = useSetting('sharedWinePrefix', '')
  const [winePrefix] = useSetting('winePrefix', sharedWinePrefix)

  const [wineVersion] = useSetting('wineVersion', defaultWineVersion)

  const syncCommands = [
    { name: t('setting.manualsync.download'), value: '--skip-upload' },
    { name: t('setting.manualsync.upload'), value: '--skip-download' },
    { name: t('setting.manualsync.forcedownload'), value: '--force-download' },
    { name: t('setting.manualsync.forceupload'), value: '--force-upload' }
  ]

  const QuickSavesToggle = () => {
    return (
      <ToggleSwitch
        htmlId="enableQuickSavesMenu"
        value={enableQuickSavesMenu}
        handleChange={() => setEnableQuickSavesMenu(!enableQuickSavesMenu)}
        title={t(
          'setting.enable-quick-sync-menu',
          'Enable Quick Save-Sync Menu on game page'
        )}
      />
    )
  }

  let storeSyncSaves: React.ReactNode = null

  if (runner === 'legendary') {
    storeSyncSaves = (
      <LegendarySyncSaves
        featureSupported={!!gameInfo?.cloud_save_enabled}
        savesPath={savesPath}
        setSavesPath={setSavesPath}
        autoSyncSaves={autoSyncSaves}
        setAutoSyncSaves={setAutoSyncSaves}
        isProton={!isWin && wineVersion.type === 'proton'}
        winePrefix={winePrefix}
        syncCommands={syncCommands}
        quickSavesToggle={QuickSavesToggle}
      />
    )
  }

  if (runner === 'gog') {
    storeSyncSaves = (
      <GOGSyncSaves
        featureSupported={!!gameInfo?.cloud_save_enabled}
        isLinuxNative={gameInfo?.install.platform === 'linux'}
        gogSaves={gogSavesLocations}
        setGogSaves={setGogSavesLocations}
        autoSyncSaves={autoSyncSaves}
        setAutoSyncSaves={setAutoSyncSaves}
        syncCommands={syncCommands}
        quickSavesToggle={QuickSavesToggle}
      />
    )
  }

  return (
    <>
      {storeSyncSaves}
      {runner && <CloudStorageSyncSaves syncCommands={syncCommands} />}
    </>
  )
}

export default SyncSaves
