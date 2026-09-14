import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MenuItem } from '@mui/material'
import {
  InfoBox,
  SelectField,
  TextInputField,
  ToggleSwitch
} from 'frontend/components/UI'
import type {
  CloudStorageConfigUpdate,
  CloudStorageProviderName,
  CloudStorageTestResult
} from 'common/types'

const emptyConfig: CloudStorageConfigUpdate = {
  provider: 'none',
  endpoint: '',
  region: '',
  bucket: '',
  prefix: 'heroic-saves',
  accessKeyId: '',
  forcePathStyle: false
}

const SAVE_DEBOUNCE_MS = 600

/**
 * Global configuration of the cloud storage provider used by the
 * per-game "Sync saves to cloud storage" feature
 */
export default function CloudStorageSaves() {
  const { t } = useTranslation()
  const [config, setConfig] = useState<CloudStorageConfigUpdate>(emptyConfig)
  const [hasSecret, setHasSecret] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<CloudStorageTestResult | null>(
    null
  )
  const saveTimer = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    void window.api.cloudStorage.getConfig().then((stored) => {
      const { hasSecretAccessKey, ...rest } = stored
      setConfig(rest)
      setHasSecret(hasSecretAccessKey)
      setLoaded(true)
    })
  }, [])

  // Persist changes shortly after the user stops typing
  useEffect(() => {
    if (!loaded || !dirty) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      void window.api.cloudStorage.setConfig(config).then(() => {
        if (config.secretAccessKey !== undefined) {
          setHasSecret(!!config.secretAccessKey)
        }
      })
      setDirty(false)
    }, SAVE_DEBOUNCE_MS)
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [config, dirty, loaded])

  const update = (patch: Partial<CloudStorageConfigUpdate>) => {
    setConfig((current) => ({ ...current, ...patch }))
    setDirty(true)
    setTestResult(null)
  }

  const handleTest = async () => {
    setTesting(true)
    // Make sure whatever is typed right now is what gets tested and saved
    if (saveTimer.current) clearTimeout(saveTimer.current)
    await window.api.cloudStorage.setConfig(config)
    setDirty(false)
    const result = await window.api.cloudStorage.testConnection(config)
    setTestResult(result)
    setTesting(false)
  }

  const isS3 = config.provider === 's3'

  const secretPlaceholder = hasSecret
    ? t(
        'settings.cloudstorage.secret.placeholder_saved',
        'Key saved — type to replace, clear to remove'
      )
    : t(
        'settings.cloudstorage.secret.placeholder',
        'Enter your secret access key here'
      )

  return (
    <>
      <SelectField
        htmlId="cloudstorage-provider"
        label={t(
          'settings.cloudstorage.provider.title',
          'Cloud Storage for Save Sync'
        )}
        value={config.provider}
        onChange={(event) =>
          update({ provider: event.target.value as CloudStorageProviderName })
        }
        afterSelect={
          <InfoBox text={t('settings.advanced.details', 'Details')}>
            <span style={{ userSelect: 'text' }}>
              {t(
                'settings.cloudstorage.help.description',
                'Sync game saves with your own S3-compatible object storage (AWS S3, MinIO, Backblaze B2, Cloudflare R2, Wasabi, ...). Once configured, enable "Sync saves to cloud storage" in the Cloud Saves Sync tab of a game to use it. Credentials are stored encrypted when your system supports it.'
              )}
            </span>
          </InfoBox>
        }
      >
        <MenuItem value="none">
          {t('settings.cloudstorage.provider.none', 'Disabled')}
        </MenuItem>
        <MenuItem value="s3">
          {t('settings.cloudstorage.provider.s3', 'S3-compatible storage')}
        </MenuItem>
      </SelectField>

      {isS3 && (
        <>
          <TextInputField
            htmlId="cloudstorage-endpoint"
            label={t('settings.cloudstorage.endpoint.title', 'Endpoint URL')}
            placeholder={t(
              'settings.cloudstorage.endpoint.placeholder',
              'Leave empty for AWS S3, e.g. https://s3.eu-central-1.wasabisys.com'
            )}
            value={config.endpoint}
            onChange={(endpoint) => update({ endpoint })}
          />
          <TextInputField
            htmlId="cloudstorage-region"
            label={t('settings.cloudstorage.region', 'Region')}
            placeholder="us-east-1"
            value={config.region}
            onChange={(region) => update({ region })}
          />
          <TextInputField
            htmlId="cloudstorage-bucket"
            label={t('settings.cloudstorage.bucket.title', 'Bucket')}
            placeholder={t(
              'settings.cloudstorage.bucket.placeholder',
              'Name of an existing bucket'
            )}
            value={config.bucket}
            onChange={(bucket) => update({ bucket })}
          />
          <TextInputField
            htmlId="cloudstorage-prefix"
            label={t(
              'settings.cloudstorage.prefix',
              'Folder inside the bucket (optional)'
            )}
            placeholder="heroic-saves"
            value={config.prefix}
            onChange={(prefix) => update({ prefix })}
          />
          <TextInputField
            htmlId="cloudstorage-access-key"
            label={t('settings.cloudstorage.accesskey', 'Access Key ID')}
            value={config.accessKeyId}
            onChange={(accessKeyId) => update({ accessKeyId })}
          />
          <TextInputField
            htmlId="cloudstorage-secret-key"
            label={t('settings.cloudstorage.secret.title', 'Secret Access Key')}
            type="password"
            placeholder={secretPlaceholder}
            value={config.secretAccessKey ?? ''}
            onChange={(secretAccessKey) => update({ secretAccessKey })}
          />
          <ToggleSwitch
            htmlId="cloudstorage-path-style"
            value={config.forcePathStyle}
            handleChange={() =>
              update({ forcePathStyle: !config.forcePathStyle })
            }
            title={t(
              'settings.cloudstorage.pathstyle',
              'Use path-style addressing (required by MinIO and some other providers)'
            )}
          />
          <div className="Field">
            <button
              className="button is-small settings"
              onClick={handleTest}
              disabled={testing || !config.bucket}
            >
              {testing
                ? t('settings.cloudstorage.testing', 'Testing...')
                : t('settings.cloudstorage.test', 'Test Connection')}
            </button>
            {testResult && (
              <span
                className="smallMessage"
                style={{
                  marginInlineStart: '12px',
                  color: testResult.success ? 'var(--success)' : 'var(--danger)'
                }}
              >
                {testResult.success
                  ? t(
                      'settings.cloudstorage.test_success',
                      'Connection successful'
                    )
                  : t(
                      'settings.cloudstorage.test_failed',
                      'Failed: {{error}}',
                      {
                        error: testResult.message
                      }
                    )}
              </span>
            )}
          </div>
        </>
      )}
    </>
  )
}
