import browser from "webextension-polyfill"

import {
  EncryptedVault,
  decryptVault,
  deprecatedDerivePbkdf2KeyFromPassword,
  deriveSymmetricKeyFromPassword,
  encryptVault,
} from "./encryption"
import { UNIXTime } from "../../types"

export enum VaultVersion {
  PBKDF2 = 1,
  Argon2 = 2,
}

export type SerializedEncryptedVault = {
  timeSaved: UNIXTime
  vault: EncryptedVault
}

type SerializedEncryptedVaults = {
  version: VaultVersion
  vaults: SerializedEncryptedVault[]
}

/**
 * Retrieve all serialized encrypted vaults from extension storage.
 *
 * @returns a schema version and array of serialized vaults
 */
export async function getEncryptedVaults(): Promise<SerializedEncryptedVaults> {
  const data = await browser.storage.local.get("tallyVaults")
  if (!("tallyVaults" in data)) {
    return {
      version: VaultVersion.Argon2,
      vaults: [],
    }
  }
  const { tallyVaults } = data
  if (
    "version" in tallyVaults &&
    "vaults" in tallyVaults &&
    (tallyVaults.version === VaultVersion.PBKDF2 ||
      tallyVaults.version === VaultVersion.Argon2) &&
    Array.isArray(tallyVaults.vaults)
  ) {
    return tallyVaults as SerializedEncryptedVaults
  }
  throw new Error("Encrypted vaults are using an unkown serialization format")
}

function equalVaults(vault1: EncryptedVault, vault2: EncryptedVault): boolean {
  if (vault1.salt !== vault2.salt) {
    return false
  }
  if (vault1.initializationVector !== vault2.initializationVector) {
    return false
  }
  if (vault1.cipherText !== vault2.cipherText) {
    return false
  }
  return true
}

/**
 * Write an encryptedVault to extension storage if and only if it's different
 * than the most recently saved vault.
 *
 * @param encryptedVault - an encrypted keyring vault
 */
export async function writeLatestEncryptedVault(
  encryptedVault: EncryptedVault
): Promise<void> {
  const serializedVaults = await getEncryptedVaults()
  const vaults = [...serializedVaults.vaults]
  const currentLatest = vaults.reduce<SerializedEncryptedVault | null>(
    (newestVault, nextVault) =>
      newestVault && newestVault.timeSaved > nextVault.timeSaved
        ? newestVault
        : nextVault,
    null
  )
  const oldVault = currentLatest && currentLatest.vault
  // if there's been a change, persist the vault
  if (!oldVault || !equalVaults(oldVault, encryptedVault)) {
    await browser.storage.local.set({
      tallyVaults: {
        ...serializedVaults,
        vaults: [
          ...serializedVaults.vaults,
          {
            timeSaved: Date.now(),
            vault: encryptedVault,
          },
        ],
      },
    })
  }
}

export async function migrateVaultsToArgon(
  password: string
): Promise<SerializedEncryptedVault[]> {
  const serializedVaults = await getEncryptedVaults()
  if (serializedVaults.version === VaultVersion.Argon2) {
    return serializedVaults.vaults
  }
  const { vaults } = serializedVaults

  const newVaults = await Promise.all(
    vaults.map(async ({ vault, timeSaved }) => {
      const deprecatedSaltedKey = await deprecatedDerivePbkdf2KeyFromPassword(
        password,
        vault.salt
      )
      const newSaltedKey = await deriveSymmetricKeyFromPassword(
        password,
        vault.salt
      )

      const deprecatedDecryptedVault = await decryptVault(
        vault,
        deprecatedSaltedKey
      )
      const newEncryptedVault = await encryptVault(
        deprecatedDecryptedVault,
        newSaltedKey
      )

      return {
        timeSaved,
        vault: newEncryptedVault,
      }
    })
  )

  await browser.storage.local.set({
    tallyVaults: {
      version: VaultVersion.Argon2,
      vaults: newVaults,
    },
  })

  return newVaults
}
