import { safeStorage } from 'electron'
import { logWarning, LogPrefix } from 'backend/logger'

/**
 * Helpers to store secrets (API keys, access tokens, ...) at rest using
 * Electron's `safeStorage`. Encrypted values are prefixed with a short
 * marker so we can tell them apart from legacy plaintext values.
 */

function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

export function isEncryptedSecret(stored: string, prefix: string): boolean {
  return stored.startsWith(prefix)
}

export function encryptSecret(
  plain: string,
  prefix: string,
  label: string
): string {
  if (!plain) return ''
  if (!encryptionAvailable()) {
    logWarning(
      `safeStorage unavailable, storing ${label} in plaintext`,
      LogPrefix.Backend
    )
    return plain
  }
  const ciphertext = safeStorage.encryptString(plain).toString('base64')
  return `${prefix}${ciphertext}`
}

export function decryptSecret(
  stored: string,
  prefix: string,
  label: string
): string {
  if (!stored) return ''
  if (!isEncryptedSecret(stored, prefix)) {
    // Legacy plaintext from before encryption was introduced.
    return stored
  }
  if (!encryptionAvailable()) return ''
  try {
    const buf = Buffer.from(stored.slice(prefix.length), 'base64')
    return safeStorage.decryptString(buf)
  } catch (error) {
    logWarning([`Failed to decrypt ${label}:`, error], LogPrefix.Backend)
    return ''
  }
}
