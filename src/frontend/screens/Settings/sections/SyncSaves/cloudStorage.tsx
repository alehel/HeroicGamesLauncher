import { useContext, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { MenuItem } from '@mui/material'
import { faExclamationTriangle } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  InfoBox,
  PathSelectionBox,
  SelectField,
  ToggleSwitch
} from 'frontend/components/UI'
import { ProgressDialog } from 'frontend/components/UI/ProgressDialog'
import ContextProvider from 'frontend/state/ContextProvider'
import useSetting from 'frontend/hooks/useSetting'
import SettingsContext from '../../SettingsContext'
import type { GOGCloudSavesLocation } from 'common/types/gog'

interface Props {
  syncCommands: { name: string; value: string }[]
}

/**
 * Per-game settings for syncing the save folder with the user's own cloud
 * storage (configured globally in Settings > Advanced). Available for every
 * runner, including games without store-provided cloud saves.
 */
export default function CloudStorageSyncSaves({ syncCommands }: Props) {
  const { t } = useTranslation()
  const { showDialogModal } = useContext(ContextProvider)
  const { appName, runner, gameInfo } = useContext(SettingsContext)

  const [enabled, setEnabled] = useSetting('syncSavesToCloudStorage', false)
  const [savesPath, setSavesPath] = useSetting('cloudStorageSavesPath', '')
  const [storeSavesPath] = useSetting('savesPath', '')
  const [gogSaves] = useSetting('gogSaves', [])

  const [configured, setConfigured] = useState<boolean | null>(null)
  const [isSyncing, setIsSyncing] = useState(false)
  const [isDetecting, setIsDetecting] = useState(false)
  const [syncType, setSyncType] = useState('--skip-upload')
  const [output, setOutput] = useState<string[]>([])
  const [showOutput, setShowOutput] = useState(false)

  useEffect(() => {
    void window.api.cloudStorage.getConfig().then((config) => {
      setConfigured(config.provider !== 'none' && !!config.bucket)
    })
  }, [])

  const canDetect =
    runner === 'legendary' ? !!gameInfo?.cloud_save_enabled : runner === 'gog'

  const detectSaveFolder = async () => {
    if (!runner) return
    setIsDetecting(true)
    try {
      if (runner === 'gog') {
        const known = gogSaves.length
          ? gogSaves
          : ((await window.api.getDefaultSavePath(
              appName,
              'gog',
              []
            )) as GOGCloudSavesLocation[])
        const first = known.find((location) => location.location)
        if (first) setSavesPath(first.location)
      } else {
        const detected =
          storeSavesPath ||
          ((await window.api.getDefaultSavePath(appName, runner, [])) as string)
        if (detected) setSavesPath(detected)
      }
    } finally {
      setIsDetecting(false)
    }
  }

  const executeSync = async (arg: string) => {
    if (!runner) return
    setIsSyncing(true)
    const response = await window.api.cloudStorage.syncSaves({
      appName,
      runner,
      path: savesPath,
      arg
    })
    setOutput(response.split('\n'))
    setShowOutput(true)
    setIsSyncing(false)
  }

  const handleSync = async () => {
    if (syncType === '--force-download' || syncType === '--force-upload') {
      showDialogModal({
        title: t('box.warning.title', 'Warning'),
        message:
          syncType === '--force-upload'
            ? t(
                'box.sync.force_upload_warning',
                'Cloud saves will be overwritten. Do you want to proceed?'
              )
            : t(
                'box.sync.force_download_warning',
                'Local saves will be erased. Do you want to proceed?'
              ),
        buttons: [
          { text: t('box.yes'), onClick: () => void executeSync(syncType) },
          { text: t('box.no'), onClick: () => null }
        ]
      })
      return
    }
    await executeSync(syncType)
  }

  if (!runner) return null

  return (
    <div className="cloudStorageSync">
      <h3 className="settingSubheader">
        {t('settings.cloudstorage.game.title', 'Sync to Cloud Storage')}
      </h3>

      {configured === false && (
        <div className="defaults-hint">
          <FontAwesomeIcon icon={faExclamationTriangle} color={'yellow'} />
          <span>
            {t(
              'settings.cloudstorage.game.not_configured',
              'No cloud storage provider is configured yet.'
            )}{' '}
            <Link to="/settings/advanced">
              {t(
                'settings.cloudstorage.game.configure',
                'Configure one in Settings > Advanced'
              )}
            </Link>
          </span>
        </div>
      )}

      <div className="defaults-hint">
        <FontAwesomeIcon icon={faExclamationTriangle} color={'yellow'} />
        {t(
          'settings.saves.warning',
          'Cloud Saves feature is in Beta, please backup your saves before syncing (in case something goes wrong)'
        )}
      </div>

      {showOutput && (
        <ProgressDialog
          title={t('settings.cloudstorage.game.title', 'Sync to Cloud Storage')}
          progress={output}
          showCloseButton={true}
          onClose={() => setShowOutput(false)}
          hideProgress
        />
      )}

      <PathSelectionBox
        htmlId="cloudStorageSavesPath"
        type="directory"
        label={t(
          'settings.cloudstorage.game.folder',
          'Save folder to sync with cloud storage'
        )}
        onPathChange={setSavesPath}
        path={savesPath}
        placeholder={t('setting.savefolder.placeholder')}
        pathDialogTitle={t('box.sync.title')}
        canEditPath={!isSyncing}
        afterInput={
          canDetect ? (
            <span
              role={'button'}
              onClick={() => void detectSaveFolder()}
              className="smallMessage"
            >
              {isDetecting
                ? t(
                    'settings.cloudstorage.game.detecting',
                    'Detecting the save folder...'
                  )
                : t(
                    'settings.cloudstorage.game.detect',
                    'Use the save folder detected by the store (click)'
                  )}
            </span>
          ) : undefined
        }
      />

      <SelectField
        label={t('setting.manualsync.title')}
        htmlId="selectCloudStorageSyncType"
        onChange={(event) => setSyncType(event.target.value)}
        value={syncType}
        disabled={!savesPath.length || !configured}
        extraClass="rightButtons"
        afterSelect={
          <button
            data-testid="setCloudStorageSync"
            onClick={() => void handleSync()}
            disabled={isSyncing || !savesPath.length || !configured}
            className={`button is-small ${
              isSyncing ? 'is-primary' : 'settings'
            }`}
          >
            {isSyncing
              ? t('setting.manualsync.syncing')
              : t('setting.manualsync.sync')}
          </button>
        }
      >
        {syncCommands.map((el, i) => (
          <MenuItem value={el.value} key={i}>
            {el.name}
          </MenuItem>
        ))}
      </SelectField>

      <ToggleSwitch
        htmlId="syncSavesToCloudStorage"
        value={enabled}
        disabled={!savesPath.length || !configured}
        handleChange={() => setEnabled(!enabled)}
        title={t(
          'settings.cloudstorage.game.autosync',
          'Sync saves to cloud storage on game launch and exit'
        )}
      />

      <InfoBox text="infobox.help">
        <ul>
          <li>
            {t(
              'settings.cloudstorage.game.help.part1',
              'Saves are downloaded before the game starts and uploaded after it exits. For each file, the newer copy wins; files are never deleted.'
            )}
          </li>
          <li>
            {t(
              'settings.cloudstorage.game.help.part2',
              "This works independently of the store's own cloud saves, so it can be used for games without cloud save support (Amazon, sideloaded, ...)."
            )}
          </li>
          <li>
            {t(
              'settings.cloudstorage.game.help.part3',
              'Saves are stored under <folder>/<store>/<game id>/ in your bucket.'
            )}
          </li>
        </ul>
      </InfoBox>
    </div>
  )
}
