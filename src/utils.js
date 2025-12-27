import { PublicKey, SystemProgram } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from '@solana/spl-token'
import { sha256 } from 'js-sha256'
import { BN } from '@coral-xyz/anchor'
import { PROGRAM_ID, TOKEN_MINT, TOKEN_DECIMALS, OfferStatus } from './constants'

/**
 * Derives the buyer index PDA
 */
export function getBuyerIndexPDA(buyerPubkey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('buyer_index'), buyerPubkey.toBuffer()],
    PROGRAM_ID
  )
}

/**
 * Derives the seller index PDA
 */
export function getSellerIndexPDA(sellerPubkey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('seller_index'), sellerPubkey.toBuffer()],
    PROGRAM_ID
  )
}

/**
 * Derives the offer PDA
 */
export function getOfferPDA(buyerPubkey, nonce) {
  const nonceBuffer = Buffer.alloc(8)
  nonceBuffer.writeBigUInt64LE(BigInt(nonce))
  return PublicKey.findProgramAddressSync(
    [Buffer.from('offer'), buyerPubkey.toBuffer(), nonceBuffer],
    PROGRAM_ID
  )
}

/**
 * Derives the escrow vault authority PDA
 */
export function getEscrowVaultAuthorityPDA(offerPubkey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('escrow'), offerPubkey.toBuffer()],
    PROGRAM_ID
  )
}

/**
 * Hash code with offer key for verification
 */
export function hashCode(code, offerPubkey) {
  const trimmed = code.trim()
  const hash = sha256.create()
  hash.update(offerPubkey.toBuffer())
  hash.update(trimmed)
  return new Uint8Array(hash.arrayBuffer())
}

/**
 * Generate a random code for a new offer
 */
export function generateCode(length = 8) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let result = ''
  const array = new Uint8Array(length)
  crypto.getRandomValues(array)
  for (let i = 0; i < length; i++) {
    result += chars[array[i] % chars.length]
  }
  return result
}

/**
 * Convert amount from human readable to lamports
 */
export function toTokenAmount(amount) {
  return new BN(Math.floor(amount * Math.pow(10, TOKEN_DECIMALS)))
}

/**
 * Convert amount from lamports to human readable
 */
export function fromTokenAmount(amount) {
  if (!amount) return 0
  const num = typeof amount === 'object' && amount.toNumber ? amount.toNumber() : Number(amount)
  return num / Math.pow(10, TOKEN_DECIMALS)
}

/**
 * Format number with commas
 */
export function formatNumber(num, decimals = 2) {
  if (num === null || num === undefined || isNaN(num)) return '0'
  return num.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  })
}

/**
 * Format USD amount
 */
export function formatUSD(amount) {
  if (amount === null || amount === undefined || isNaN(amount)) return '$0.00'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)
}

/**
 * Format date and time for display
 * Examples:
 * - "Today, 14:30"
 * - "Yesterday, 09:15"
 * - "Dec 20, 22:45"
 * - "Dec 20, 2024, 22:45" (if different year)
 */
export function formatDateTime(date) {
  if (!date) return ''
  
  const d = new Date(date)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const isYesterday = d.toDateString() === yesterday.toDateString()
  
  const time = d.toLocaleTimeString('en-US', { 
    hour: '2-digit', 
    minute: '2-digit',
    hour12: false 
  })
  
  if (isToday) {
    return `Today, ${time}`
  } else if (isYesterday) {
    return `Yesterday, ${time}`
  } else {
    const dateStr = d.toLocaleDateString('en-US', { 
      month: 'short', 
      day: 'numeric',
      year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
    })
    return `${dateStr}, ${time}`
  }
}

/**
 * Shorten address for display
 */
export function shortenAddress(address, chars = 4) {
  if (!address) return ''
  const str = address.toString()
  return `${str.slice(0, chars)}...${str.slice(-chars)}`
}


/**
 * Get status display info with context (buyer/seller perspective)
 * @param {Object} status - Offer status
 * @param {Object} offer - Full offer object (optional, for context-aware labels)
 * @param {PublicKey} userPubkey - Current user's public key (optional)
 */
export function getStatusInfo(status, offer = null, userPubkey = null) {
  // Parse status value
  let statusValue = status
  if (typeof status === 'number') {
    statusValue = status
  } else if (typeof status === 'object') {
    if ('pendingSeller' in status) statusValue = OfferStatus.PendingSeller
    else if ('locked' in status) statusValue = OfferStatus.Locked
    else if ('buyerConfirmed' in status) statusValue = OfferStatus.BuyerConfirmed
    else if ('sellerConfirmed' in status) statusValue = OfferStatus.SellerConfirmed
    else if ('completed' in status) statusValue = OfferStatus.Completed
    else if ('burned' in status) statusValue = OfferStatus.Burned
    else if ('cancelled' in status) statusValue = OfferStatus.Cancelled
  }
  
  // Context-aware labels for BuyerConfirmed and SellerConfirmed
  if (offer && userPubkey) {
    const buyerStr = offer.buyer?.toString ? offer.buyer.toString() : offer.buyer
    const sellerStr = offer.seller?.toString ? offer.seller.toString() : offer.seller
    const userStr = userPubkey?.toString ? userPubkey.toString() : userPubkey
    
    const isBuyer = buyerStr === userStr
    const isSeller = sellerStr && sellerStr !== '11111111111111111111111111111111' && sellerStr === userStr
    
    if (statusValue === OfferStatus.BuyerConfirmed && isSeller) {
      return { label: 'Confirm Release', class: 'pending-release' }
    }
    if (statusValue === OfferStatus.BuyerConfirmed && isBuyer) {
      return { label: 'Awaiting Release', class: 'pending-release' }
    }
    if (statusValue === OfferStatus.SellerConfirmed && isBuyer) {
      return { label: 'Confirm Release', class: 'pending-release' }
    }
    if (statusValue === OfferStatus.SellerConfirmed && isSeller) {
      return { label: 'Awaiting Release', class: 'pending-release' }
    }
  }
  
  // Default status map
  const statusMap = {
    [OfferStatus.PendingSeller]: { label: 'Pending', class: 'pending' },
    [OfferStatus.Locked]: { label: 'Ongoing', class: 'ongoing' },
    [OfferStatus.BuyerConfirmed]: { label: 'Pending Release', class: 'pending-release' },
    [OfferStatus.SellerConfirmed]: { label: 'Pending Release', class: 'pending-release' },
    [OfferStatus.Completed]: { label: 'Released', class: 'released' },
    [OfferStatus.Burned]: { label: 'Burned', class: 'burned' },
    [OfferStatus.Cancelled]: { label: 'Cancelled', class: 'cancelled' },
  }
  
  return statusMap[statusValue] || { label: 'Unknown', class: 'pending' }
}

/**
 * Parse offer status from Anchor format
 */
export function parseOfferStatus(status) {
  if (typeof status === 'number') return status
  if (typeof status === 'object') {
    if ('pendingSeller' in status) return OfferStatus.PendingSeller
    if ('locked' in status) return OfferStatus.Locked
    if ('buyerConfirmed' in status) return OfferStatus.BuyerConfirmed
    if ('sellerConfirmed' in status) return OfferStatus.SellerConfirmed
    if ('completed' in status) return OfferStatus.Completed
    if ('burned' in status) return OfferStatus.Burned
    if ('cancelled' in status) return OfferStatus.Cancelled
  }
  return OfferStatus.PendingSeller
}

/**
 * Check if offer can be cancelled (only if pending)
 */
export function canCancelOffer(offer, userPubkey) {
  const status = parseOfferStatus(offer.status)
  const buyerStr = offer.buyer?.toString ? offer.buyer.toString() : offer.buyer
  const userStr = userPubkey?.toString ? userPubkey.toString() : userPubkey
  return status === OfferStatus.PendingSeller && buyerStr === userStr
}

/**
 * Check if offer can be released (ongoing state)
 */
export function canReleaseOffer(offer, userPubkey) {
  const status = parseOfferStatus(offer.status)
  const buyerStr = offer.buyer?.toString ? offer.buyer.toString() : offer.buyer
  const sellerStr = offer.seller?.toString ? offer.seller.toString() : offer.seller
  const userStr = userPubkey?.toString ? userPubkey.toString() : userPubkey
  
  return (status === OfferStatus.Locked || 
          status === OfferStatus.BuyerConfirmed || 
          status === OfferStatus.SellerConfirmed) &&
    (buyerStr === userStr || sellerStr === userStr)
}

/**
 * Check if offer can be burned (ongoing state)
 */
export function canBurnOffer(offer, userPubkey) {
  const status = parseOfferStatus(offer.status)
  const buyerStr = offer.buyer?.toString ? offer.buyer.toString() : offer.buyer
  const sellerStr = offer.seller?.toString ? offer.seller.toString() : offer.seller
  const userStr = userPubkey?.toString ? userPubkey.toString() : userPubkey
  
  return (status === OfferStatus.Locked || 
          status === OfferStatus.BuyerConfirmed || 
          status === OfferStatus.SellerConfirmed) &&
    (buyerStr === userStr || sellerStr === userStr)
}

/**
 * Check if status is terminal (completed, burned, or cancelled)
 */
export function isTerminalStatus(status) {
  const statusValue = parseOfferStatus(status)
  return statusValue === OfferStatus.Completed || 
         statusValue === OfferStatus.Burned || 
         statusValue === OfferStatus.Cancelled
}

/**
 * Sleep helper
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Copy text to clipboard
 */
export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch (err) {
    // Fallback for older browsers
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    try {
      document.execCommand('copy')
      document.body.removeChild(textarea)
      return true
    } catch (e) {
      document.body.removeChild(textarea)
      return false
    }
  }
}