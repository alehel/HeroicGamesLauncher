import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret
} from 'backend/utils/secure_secret'

const CIPHERTEXT_PREFIX = 'sgdb:v1:'
const LABEL = 'SteamGridDB API key'

export function isEncryptedValue(stored: string): boolean {
  return isEncryptedSecret(stored, CIPHERTEXT_PREFIX)
}

export function encryptApiKey(plain: string): string {
  return encryptSecret(plain, CIPHERTEXT_PREFIX, LABEL)
}

export function decryptApiKey(stored: string): string {
  return decryptSecret(stored, CIPHERTEXT_PREFIX, LABEL)
}
