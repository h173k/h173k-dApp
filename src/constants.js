import { PublicKey, clusterApiUrl } from '@solana/web3.js'

// ========== MAINNET CONFIGURATION ==========

// Network configuration - MAINNET
export const NETWORK = 'mainnet-beta'
//export const DEFAULT_RPC_ENDPOINT = clusterApiUrl('mainnet-beta')
// Zalecane: użyj własnego RPC dla produkcji:
export const DEFAULT_RPC_ENDPOINT = 'https://mainnet.helius-rpc.com/?api-key=8ca1ae57-4ed8-4896-a299-bfe3e0a4a886'

// RPC Settings localStorage key
export const RPC_SETTINGS_KEY = 'h173k_rpc_settings'

// Get RPC endpoint from settings or use default
export function getRpcEndpoint() {
  try {
    const stored = localStorage.getItem(RPC_SETTINGS_KEY)
    if (stored) {
      const settings = JSON.parse(stored)
      if (settings.customRpcUrl && settings.customRpcUrl.trim()) {
        return settings.customRpcUrl.trim()
      }
    }
  } catch (err) {
    console.error('Error reading RPC settings:', err)
  }
  return DEFAULT_RPC_ENDPOINT
}

// Get RPC headers (for API keys)
export function getRpcHeaders() {
  try {
    const stored = localStorage.getItem(RPC_SETTINGS_KEY)
    if (stored) {
      const settings = JSON.parse(stored)
      if (settings.apiKeyName && settings.apiKeyValue) {
        return { [settings.apiKeyName]: settings.apiKeyValue }
      }
    }
  } catch (err) {
    console.error('Error reading RPC headers:', err)
  }
  return {}
}

// Legacy export for backward compatibility
export const RPC_ENDPOINT = DEFAULT_RPC_ENDPOINT

// ========== PROGRAM ID - ZMIEŃ NA NOWY PO DEPLOY! ==========
export const PROGRAM_ID = new PublicKey('pLEzeCQ8t7oz2YGzZmqz4a1mXNhhE3mJC89GSveijrG')

// ========== TOKEN MINT - MAINNET ==========
export const TOKEN_MINT = new PublicKey('173AvoJNQoWsaR1wdYTMNLUqZc1b7d4SzB2ZZRZVyz3')

// Zachowaj dla referencji (usunięte z produkcji)
// export const DEVNET_TOKEN_MINT = new PublicKey('DcAwQFCWCLjbaFa2j67pXx4S9Caeo6YkdZURmAsLkZTT')

// Token decimals
export const TOKEN_DECIMALS = 9

// CoinGecko API - checking every 30 seconds to avoid rate limiting
export const PRICE_UPDATE_INTERVAL = 30000

// Refresh interval limits
export const MIN_REFRESH_INTERVAL = 5000 // 5 seconds

// Offer status enum matching the smart contract v7
export const OfferStatus = {
  PendingSeller: 0,
  Locked: 1,
  BuyerConfirmed: 2,
  SellerConfirmed: 3,
  Completed: 4,
  Burned: 5,
  Cancelled: 6,
}

// Status labels for UI
export const STATUS_LABELS = {
  [OfferStatus.PendingSeller]: 'Pending',
  [OfferStatus.Locked]: 'Ongoing',
  [OfferStatus.BuyerConfirmed]: 'Pending Release',
  [OfferStatus.SellerConfirmed]: 'Pending Release',
  [OfferStatus.Completed]: 'Released',
  [OfferStatus.Burned]: 'Burned',
  [OfferStatus.Cancelled]: 'Cancelled',
}

// Status CSS classes
export const STATUS_CLASSES = {
  [OfferStatus.PendingSeller]: 'pending',
  [OfferStatus.Locked]: 'ongoing',
  [OfferStatus.BuyerConfirmed]: 'pending-release',
  [OfferStatus.SellerConfirmed]: 'pending-release',
  [OfferStatus.Completed]: 'released',
  [OfferStatus.Burned]: 'burned',
  [OfferStatus.Cancelled]: 'cancelled',
}