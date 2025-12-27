import { useCallback, useState, useRef } from 'react'
import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import { 
  TOKEN_PROGRAM_ID, 
  ASSOCIATED_TOKEN_PROGRAM_ID, 
  getAssociatedTokenAddress,
  getAccount,
  createAssociatedTokenAccountInstruction
} from '@solana/spl-token'
import { Program, AnchorProvider, BN } from '@coral-xyz/anchor'
import { PROGRAM_ID, TOKEN_MINT, TOKEN_DECIMALS, OfferStatus } from './constants'
import { IDL } from './idl'
import { 
  getBuyerIndexPDA, 
  getSellerIndexPDA,
  getOfferPDA, 
  getEscrowVaultAuthorityPDA, 
  hashCode,
  toTokenAmount,
  fromTokenAmount,
  parseOfferStatus
} from './utils'

// ============================================================================
// LOCAL STORAGE KEYS & CACHE MANAGEMENT
// ============================================================================

const OFFERS_CACHE_KEY = 'h173k_offers_cache'
const LAST_SYNC_KEY = 'h173k_last_sync'

/**
 * Load cached offers from localStorage
 */
function loadCachedOffers(walletPubkey) {
  try {
    const cached = localStorage.getItem(OFFERS_CACHE_KEY)
    if (!cached) return {}
    const data = JSON.parse(cached)
    // Return only offers for this wallet
    return data[walletPubkey] || {}
  } catch (err) {
    console.error('Error loading cached offers:', err)
    return {}
  }
}

/**
 * Save offers to localStorage cache
 */
function saveCachedOffers(walletPubkey, offers) {
  try {
    const cached = localStorage.getItem(OFFERS_CACHE_KEY)
    const data = cached ? JSON.parse(cached) : {}
    data[walletPubkey] = offers
    localStorage.setItem(OFFERS_CACHE_KEY, JSON.stringify(data))
  } catch (err) {
    console.error('Error saving cached offers:', err)
  }
}

/**
 * Update single offer in cache
 */
function updateCachedOffer(walletPubkey, offerPubkey, offerData) {
  const cached = loadCachedOffers(walletPubkey)
  cached[offerPubkey] = {
    ...cached[offerPubkey],
    ...offerData,
    lastUpdated: Date.now()
  }
  saveCachedOffers(walletPubkey, cached)
}

/**
 * Mark offer as terminal state in cache (completed/burned/cancelled)
 */
function markOfferTerminal(walletPubkey, offerPubkey, status) {
  const cached = loadCachedOffers(walletPubkey)
  if (cached[offerPubkey]) {
    cached[offerPubkey] = {
      ...cached[offerPubkey],
      status,
      isTerminal: true,
      terminalAt: Date.now()
    }
    saveCachedOffers(walletPubkey, cached)
  }
}

/**
 * Serialize offer data for cache (convert PublicKeys to strings, BN to numbers)
 */
function serializeOffer(offer, pubkey) {
  return {
    publicKey: pubkey.toString(),
    buyer: offer.buyer.toString(),
    seller: offer.seller?.toString() || null,
    amount: typeof offer.amount === 'object' ? offer.amount.toNumber() : Number(offer.amount),
    buyerDeposit: typeof offer.buyerDeposit === 'object' ? offer.buyerDeposit.toNumber() : Number(offer.buyerDeposit),
    sellerDeposit: typeof offer.sellerDeposit === 'object' ? offer.sellerDeposit.toNumber() : Number(offer.sellerDeposit),
    status: parseOfferStatus(offer.status),
    nonce: typeof offer.nonce === 'object' ? offer.nonce.toNumber() : Number(offer.nonce),
    buyerConfirmed: offer.buyerConfirmed,
    sellerConfirmed: offer.sellerConfirmed,
    isClosed: offer.isClosed,
    codeHash: Array.from(offer.codeHash),
    lastUpdated: Date.now()
  }
}

/**
 * Deserialize offer from cache (convert strings back to PublicKeys)
 */
function deserializeOffer(cached) {
  return {
    publicKey: new PublicKey(cached.publicKey),
    buyer: new PublicKey(cached.buyer),
    seller: cached.seller ? new PublicKey(cached.seller) : new PublicKey('11111111111111111111111111111111'),
    amount: { toNumber: () => cached.amount },
    buyerDeposit: { toNumber: () => cached.buyerDeposit },
    sellerDeposit: { toNumber: () => cached.sellerDeposit },
    status: cached.status,
    nonce: { toNumber: () => cached.nonce, toString: () => cached.nonce.toString() },
    buyerConfirmed: cached.buyerConfirmed,
    sellerConfirmed: cached.sellerConfirmed,
    isClosed: cached.isClosed,
    codeHash: new Uint8Array(cached.codeHash),
    _fromCache: true,
    _isTerminal: cached.isTerminal || false,
    _lastUpdated: cached.lastUpdated
  }
}

/**
 * Check if status is terminal (no need to refresh from blockchain)
 */
function isTerminalStatus(status) {
  const statusValue = parseOfferStatus(status)
  return statusValue === OfferStatus.Completed || 
         statusValue === OfferStatus.Burned || 
         statusValue === OfferStatus.Cancelled
}

// ============================================================================
// MAIN HOOK
// ============================================================================

/**
 * Hook for interacting with the escrow program with optimized RPC usage
 */
export function useEscrowProgram(connection, wallet) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  
  // Cache for seller index existence check
  const sellerIndexExistsRef = useRef({})

  console.log('🔐 Program ID:', PROGRAM_ID.toString())
  console.log('📋 IDL:', IDL.name)

  /**
   * Get Anchor program instance
   */
  const getProgram = useCallback(() => {
    if (!wallet?.publicKey) return null
    
    const provider = new AnchorProvider(
      connection,
      wallet,
      { commitment: 'confirmed', preflightCommitment: 'confirmed' }
    )
    
    return new Program(IDL, PROGRAM_ID, provider)
  }, [connection, wallet])

  /**
   * Get or create buyer index
   */
  const getOrCreateBuyerIndex = useCallback(async () => {
    const program = getProgram()
    if (!program || !wallet?.publicKey) throw new Error('Wallet not connected')

    const [buyerIndexPDA] = getBuyerIndexPDA(wallet.publicKey)
    
    try {
      const account = await program.account.buyerIndex.fetch(buyerIndexPDA)
      return { pda: buyerIndexPDA, account, exists: true }
    } catch (err) {
      return { pda: buyerIndexPDA, account: null, exists: false }
    }
  }, [getProgram, wallet?.publicKey])

  /**
   * Get seller index (if exists)
   */
  const getSellerIndex = useCallback(async () => {
    const program = getProgram()
    if (!program || !wallet?.publicKey) return { pda: null, account: null, exists: false }

    const [sellerIndexPDA] = getSellerIndexPDA(wallet.publicKey)
    
    // Use cached result if available
    const cacheKey = wallet.publicKey.toString()
    if (sellerIndexExistsRef.current[cacheKey] === false) {
      return { pda: sellerIndexPDA, account: null, exists: false }
    }
    
    try {
      const account = await program.account.sellerIndex.fetch(sellerIndexPDA)
      sellerIndexExistsRef.current[cacheKey] = true
      return { pda: sellerIndexPDA, account, exists: true }
    } catch (err) {
      sellerIndexExistsRef.current[cacheKey] = false
      return { pda: sellerIndexPDA, account: null, exists: false }
    }
  }, [getProgram, wallet?.publicKey])

  /**
   * Initialize buyer index if needed
   */
  const initializeBuyerIndex = useCallback(async () => {
    const program = getProgram()
    if (!program || !wallet?.publicKey) throw new Error('Wallet not connected')

    const [buyerIndexPDA] = getBuyerIndexPDA(wallet.publicKey)

    const tx = await program.methods
      .initializeBuyerIndex()
      .accounts({
        buyer: wallet.publicKey,
        buyerIndex: buyerIndexPDA,
        systemProgram: SystemProgram.programId,
      })
      .rpc()

    return tx
  }, [getProgram, wallet?.publicKey])

  /**
   * Initialize seller index if needed
   */
  const initializeSellerIndex = useCallback(async () => {
    const program = getProgram()
    if (!program || !wallet?.publicKey) throw new Error('Wallet not connected')

    const [sellerIndexPDA] = getSellerIndexPDA(wallet.publicKey)

    const tx = await program.methods
      .initializeSellerIndex()
      .accounts({
        seller: wallet.publicKey,
        sellerIndex: sellerIndexPDA,
        systemProgram: SystemProgram.programId,
      })
      .rpc()

    // Update cache
    sellerIndexExistsRef.current[wallet.publicKey.toString()] = true

    return tx
  }, [getProgram, wallet?.publicKey])

  /**
   * Get user's token balance
   */
  const getTokenBalance = useCallback(async () => {
    if (!wallet?.publicKey || !connection) return 0

    try {
      const tokenAccount = await getAssociatedTokenAddress(TOKEN_MINT, wallet.publicKey)
      const accountInfo = await connection.getAccountInfo(tokenAccount)
      
      if (!accountInfo) {
        console.log('⚠️ Token account does not exist')
        return 0
      }
      
      const account = await getAccount(connection, tokenAccount)
      return fromTokenAmount(account.amount)
    } catch (err) {
      console.error('❌ Error getting balance:', err.message)
      return 0
    }
  }, [connection, wallet?.publicKey])

  /**
   * OPTIMIZED: Fetch all user offers using indexes + localStorage cache
   * 
   * Strategy:
   * 1. Load cached offers from localStorage
   * 2. Fetch buyerIndex and sellerIndex (2 RPC calls max)
   * 3. For offers in index: fetch from blockchain (only active offers)
   * 4. For cached offers NOT in index: 
   *    - If cancelled locally → use cache (no RPC needed)
   *    - If was active but disappeared → verify status once, then cache
   * 5. Update cache with fresh data
   */
  const fetchAllUserOffers = useCallback(async () => {
    const program = getProgram()
    if (!program || !wallet?.publicKey) return []

    const walletKey = wallet.publicKey.toString()
    const cachedOffers = loadCachedOffers(walletKey)
    
    console.log(`📦 Cached offers: ${Object.keys(cachedOffers).length}`)

    try {
      // 1. Get active offer keys from both indexes (efficient - just 2 account fetches)
      const activeOfferKeys = new Set()
      
      // Buyer index
      const buyerIndex = await getOrCreateBuyerIndex()
      if (buyerIndex.exists && buyerIndex.account) {
        for (const pk of buyerIndex.account.activeOffers) {
          activeOfferKeys.add(pk.toString())
        }
        console.log(`📋 Buyer index: ${buyerIndex.account.activeOffers.length} active`)
      }

      // Seller index (may not exist)
      const sellerIndex = await getSellerIndex()
      if (sellerIndex.exists && sellerIndex.account) {
        for (const pk of sellerIndex.account.activeOffers) {
          activeOfferKeys.add(pk.toString())
        }
        console.log(`📋 Seller index: ${sellerIndex.account.activeOffers.length} active`)
      }

      console.log(`📊 Total unique active offers in indexes: ${activeOfferKeys.size}`)

      // 2. Fetch active offers from blockchain
      const offers = []
      const updatedCache = { ...cachedOffers }

      for (const pkStr of activeOfferKeys) {
        try {
          const offerPubkey = new PublicKey(pkStr)
          const offer = await program.account.offer.fetch(offerPubkey)
          
          // Serialize and cache
          const serialized = serializeOffer(offer, offerPubkey)
          updatedCache[pkStr] = serialized
          
          offers.push({
            publicKey: offerPubkey,
            ...offer,
            _fromBlockchain: true
          })
          
          console.log(`  ✅ Fetched active offer ${pkStr.slice(0, 8)}...`)
        } catch (err) {
          console.warn(`  ❌ Failed to fetch ${pkStr.slice(0, 8)}:`, err.message)
        }
      }

      // 3. Handle cached offers that are NOT in active indexes
      for (const [pkStr, cached] of Object.entries(cachedOffers)) {
        if (activeOfferKeys.has(pkStr)) continue // Already fetched above

        // Check if this offer belongs to this wallet
        if (cached.buyer !== walletKey && cached.seller !== walletKey) continue

        // If already marked as terminal, just use cache - NO RPC!
        if (cached.isTerminal) {
          console.log(`  📄 Using cached terminal offer ${pkStr.slice(0, 8)}: ${cached.status}`)
          offers.push(deserializeOffer(cached))
          continue
        }

        // If offer disappeared from index but not marked terminal, verify once
        try {
          const offerPubkey = new PublicKey(pkStr)
          const offer = await program.account.offer.fetch(offerPubkey)
          const status = parseOfferStatus(offer.status)
          
          // Update cache with fresh status
          const serialized = serializeOffer(offer, offerPubkey)
          
          if (isTerminalStatus(status)) {
            serialized.isTerminal = true
            serialized.terminalAt = Date.now()
            console.log(`  ✅ Offer ${pkStr.slice(0, 8)} now terminal: ${status}`)
          }
          
          updatedCache[pkStr] = serialized
          offers.push({
            publicKey: offerPubkey,
            ...offer,
            _fromBlockchain: true
          })
        } catch (err) {
          // Account may be closed - mark as terminal in cache based on last known status
          console.log(`  ⚠️ Could not fetch ${pkStr.slice(0, 8)}, using cached status`)
          
          // Infer terminal status if offer was in progress
          if (!cached.isTerminal) {
            const inferredStatus = cached.buyerConfirmed && cached.sellerConfirmed 
              ? OfferStatus.Completed 
              : cached.status
            cached.isTerminal = true
            cached.terminalAt = Date.now()
            cached.status = inferredStatus
            updatedCache[pkStr] = cached
          }
          
          offers.push(deserializeOffer(cached))
        }
      }

      // 4. Save updated cache
      saveCachedOffers(walletKey, updatedCache)

      console.log(`📊 Total offers returned: ${offers.length}`)
      return offers

    } catch (err) {
      console.error('Error fetching offers:', err)
      
      // Fallback to cache only
      const fallbackOffers = Object.values(cachedOffers)
        .filter(c => c.buyer === walletKey || c.seller === walletKey)
        .map(deserializeOffer)
      
      console.log(`⚠️ Using ${fallbackOffers.length} cached offers as fallback`)
      return fallbackOffers
    }
  }, [getProgram, getOrCreateBuyerIndex, getSellerIndex, wallet?.publicKey])

  /**
   * Search for offer by code - optimized for sellers accepting offers
   * Only searches pending offers (not all offers)
   */
  const findOfferByCode = useCallback(async (code) => {
    const program = getProgram()
    if (!program) throw new Error('Wallet not connected')

    try {
      // Get all offers - but only check PendingSeller status
      // This is necessary since we don't know the buyer
      const offers = await program.account.offer.all()
      
      console.log(`🔍 Searching ${offers.length} offers for code...`)
      
      for (const { publicKey, account } of offers) {
        const status = parseOfferStatus(account.status)
        if (status !== OfferStatus.PendingSeller) continue
        
        const testHash = hashCode(code.trim(), publicKey)
        if (Buffer.from(testHash).equals(Buffer.from(account.codeHash))) {
          console.log('✅ Found matching offer:', publicKey.toString())
          return { publicKey, ...account }
        }
      }
      
      console.log('❌ No matching offer found')
      return null
    } catch (err) {
      console.error('Error searching:', err)
      throw err
    }
  }, [getProgram])

  /**
   * Read offer by code - for import functionality
   * This is the ONLY case where we search all offers including closed ones
   */
  const readOfferByCode = useCallback(async (code, forceBlockchainCheck = false) => {
    const program = getProgram()
    if (!program) throw new Error('Wallet not connected')

    const walletKey = wallet.publicKey.toString()
    const cachedOffers = loadCachedOffers(walletKey)

    // First check cache if not forcing blockchain
    if (!forceBlockchainCheck) {
      for (const [pkStr, cached] of Object.entries(cachedOffers)) {
        // We can't check code hash without the publicKey, so we need to verify
        const offerPubkey = new PublicKey(pkStr)
        const testHash = hashCode(code.trim(), offerPubkey)
        if (Buffer.from(testHash).equals(Buffer.from(new Uint8Array(cached.codeHash)))) {
          console.log('✅ Found in cache:', pkStr.slice(0, 8))
          return deserializeOffer(cached)
        }
      }
    }

    // Full blockchain search for import
    console.log('🔍 Searching blockchain for import...')
    try {
      const offers = await program.account.offer.all()
      
      for (const { publicKey, account } of offers) {
        const testHash = hashCode(code.trim(), publicKey)
        if (Buffer.from(testHash).equals(Buffer.from(account.codeHash))) {
          console.log('✅ Found on blockchain:', publicKey.toString())
          
          // Check participation
          const isBuyer = account.buyer.equals(wallet.publicKey)
          const isSeller = account.seller && 
            !account.seller.equals(new PublicKey('11111111111111111111111111111111')) && 
            account.seller.equals(wallet.publicKey)
          
          if (!isBuyer && !isSeller) {
            const status = parseOfferStatus(account.status)
            if (status !== OfferStatus.PendingSeller) {
              throw new Error('You are not a participant in this contract')
            }
          }
          
          // Cache this offer
          const serialized = serializeOffer(account, publicKey)
          if (isTerminalStatus(account.status)) {
            serialized.isTerminal = true
            serialized.terminalAt = Date.now()
          }
          updateCachedOffer(walletKey, publicKey.toString(), serialized)
          
          return { publicKey, ...account }
        }
      }
      
      return null
    } catch (err) {
      console.error('Error in readOfferByCode:', err)
      throw err
    }
  }, [getProgram, wallet?.publicKey])

  /**
   * Create a new offer
   */
  const createOffer = useCallback(async (amount, code, name) => {
    setLoading(true)
    setError(null)

    try {
      const program = getProgram()
      if (!program || !wallet?.publicKey) throw new Error('Wallet not connected')

      console.log('🔐 Creating offer...')

      // Ensure buyer index exists
      const buyerIndex = await getOrCreateBuyerIndex()
      if (!buyerIndex.exists) {
        console.log('  Creating buyer index...')
        await initializeBuyerIndex()
        await new Promise(r => setTimeout(r, 2000))
      }

      // Get current nonce
      const [buyerIndexPDA] = getBuyerIndexPDA(wallet.publicKey)
      const buyerIndexAccount = await program.account.buyerIndex.fetch(buyerIndexPDA)
      const nonce = buyerIndexAccount.nextNonce

      // Derive PDAs
      const [offerPDA] = getOfferPDA(wallet.publicKey, nonce)
      const [escrowVaultAuthorityPDA] = getEscrowVaultAuthorityPDA(offerPDA)

      const buyerTokenAccount = await getAssociatedTokenAddress(TOKEN_MINT, wallet.publicKey)
      const escrowVault = await getAssociatedTokenAddress(TOKEN_MINT, escrowVaultAuthorityPDA, true)

      const codeHash = hashCode(code, offerPDA)
      const tokenAmount = toTokenAmount(amount)

      const tx = await program.methods
        .createOffer(tokenAmount, Array.from(codeHash))
        .accounts({
          buyer: wallet.publicKey,
          buyerIndex: buyerIndexPDA,
          offer: offerPDA,
          escrowVault: escrowVault,
          escrowVaultAuthority: escrowVaultAuthorityPDA,
          mint: TOKEN_MINT,
          buyerToken: buyerTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc()

      console.log('✅ Created:', tx)

      // Cache the new offer immediately
      const walletKey = wallet.publicKey.toString()
      updateCachedOffer(walletKey, offerPDA.toString(), {
        publicKey: offerPDA.toString(),
        buyer: wallet.publicKey.toString(),
        seller: null,
        amount: amount * Math.pow(10, TOKEN_DECIMALS),
        buyerDeposit: amount * 2 * Math.pow(10, TOKEN_DECIMALS),
        sellerDeposit: 0,
        status: OfferStatus.PendingSeller,
        nonce: nonce.toNumber(),
        buyerConfirmed: false,
        sellerConfirmed: false,
        isClosed: false,
        codeHash: Array.from(codeHash),
        lastUpdated: Date.now()
      })

      return {
        success: true,
        txHash: tx,
        offerPDA,
        code,
        name,
        amount,
      }
    } catch (err) {
      console.error('❌ Create error:', err)
      setError(err.message)
      throw err
    } finally {
      setLoading(false)
    }
  }, [getProgram, wallet?.publicKey, getOrCreateBuyerIndex, initializeBuyerIndex])

  /**
   * Accept an offer (as seller)
   */
  const acceptOffer = useCallback(async (offerPubkey, code) => {
    setLoading(true)
    setError(null)

    try {
      const program = getProgram()
      if (!program || !wallet?.publicKey) throw new Error('Wallet not connected')

      console.log('🔵 Accepting offer:', offerPubkey.toString())

      const offer = await program.account.offer.fetch(offerPubkey)
      const [escrowVaultAuthorityPDA] = getEscrowVaultAuthorityPDA(offerPubkey)
      const [sellerIndexPDA] = getSellerIndexPDA(wallet.publicKey)

      // Check if seller index exists, create if not
      const sellerIndex = await getSellerIndex()
      if (!sellerIndex.exists) {
        console.log('  Creating seller index...')
        await initializeSellerIndex()
        await new Promise(r => setTimeout(r, 2000))
      }

      const sellerTokenAccount = await getAssociatedTokenAddress(TOKEN_MINT, wallet.publicKey)
      const escrowVault = await getAssociatedTokenAddress(TOKEN_MINT, escrowVaultAuthorityPDA, true)

      const tx = await program.methods
        .acceptOffer(code)
        .accounts({
          seller: wallet.publicKey,
          sellerIndex: sellerIndexPDA,
          offer: offerPubkey,
          sellerToken: sellerTokenAccount,
          escrowVault: escrowVault,
          escrowVaultAuthority: escrowVaultAuthorityPDA,
          mint: TOKEN_MINT,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc()

      console.log('✅ Accepted:', tx)

      // Update cache
      const walletKey = wallet.publicKey.toString()
      updateCachedOffer(walletKey, offerPubkey.toString(), {
        seller: wallet.publicKey.toString(),
        sellerDeposit: offer.amount.toNumber(),
        status: OfferStatus.Locked,
        lastUpdated: Date.now()
      })

      return { success: true, txHash: tx }
    } catch (err) {
      console.error('❌ Accept error:', err)
      setError(err.message)
      throw err
    } finally {
      setLoading(false)
    }
  }, [getProgram, wallet?.publicKey, getSellerIndex, initializeSellerIndex])

  /**
   * Cancel an offer (only if pending)
   */
  const cancelOffer = useCallback(async (offerPubkey) => {
    setLoading(true)
    setError(null)

    try {
      const program = getProgram()
      if (!program || !wallet?.publicKey) throw new Error('Wallet not connected')

      const offer = await program.account.offer.fetch(offerPubkey)
      const [buyerIndexPDA] = getBuyerIndexPDA(offer.buyer)
      const [escrowVaultAuthorityPDA] = getEscrowVaultAuthorityPDA(offerPubkey)

      const buyerTokenAccount = await getAssociatedTokenAddress(TOKEN_MINT, offer.buyer)
      const escrowVault = await getAssociatedTokenAddress(TOKEN_MINT, escrowVaultAuthorityPDA, true)

      const tx = await program.methods
        .cancelOffer()
        .accounts({
          buyer: wallet.publicKey,
          offer: offerPubkey,
          buyerToken: buyerTokenAccount,
          escrowVault: escrowVault,
          escrowVaultAuthority: escrowVaultAuthorityPDA,
          buyerIndex: buyerIndexPDA,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc()

      console.log('✅ Cancelled:', tx)

      // Mark as terminal in cache - NO future RPC needed!
      const walletKey = wallet.publicKey.toString()
      markOfferTerminal(walletKey, offerPubkey.toString(), OfferStatus.Cancelled)

      return { success: true, txHash: tx }
    } catch (err) {
      console.error('❌ Cancel error:', err)
      setError(err.message)
      throw err
    } finally {
      setLoading(false)
    }
  }, [getProgram, wallet?.publicKey])

  /**
   * Release/confirm completion of an offer
   */
  const releaseOffer = useCallback(async (offerPubkey) => {
    setLoading(true)
    setError(null)

    try {
      const program = getProgram()
      if (!program || !wallet?.publicKey) throw new Error('Wallet not connected')

      const offer = await program.account.offer.fetch(offerPubkey)
      const [buyerIndexPDA] = getBuyerIndexPDA(offer.buyer)
      const [sellerIndexPDA] = getSellerIndexPDA(offer.seller)
      const [escrowVaultAuthorityPDA] = getEscrowVaultAuthorityPDA(offerPubkey)

      const buyerTokenAccount = await getAssociatedTokenAddress(TOKEN_MINT, offer.buyer)
      const sellerTokenAccount = await getAssociatedTokenAddress(TOKEN_MINT, offer.seller)
      const escrowVault = await getAssociatedTokenAddress(TOKEN_MINT, escrowVaultAuthorityPDA, true)

      const tx = await program.methods
        .confirmCompletion()
        .accounts({
          user: wallet.publicKey,
          offer: offerPubkey,
          buyerToken: buyerTokenAccount,
          sellerToken: sellerTokenAccount,
          escrowVault: escrowVault,
          escrowVaultAuthority: escrowVaultAuthorityPDA,
          buyerIndex: buyerIndexPDA,
          sellerIndex: sellerIndexPDA,
          buyer: offer.buyer,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc()

      console.log('✅ Released:', tx)

      // Update cache based on who confirmed
      const walletKey = wallet.publicKey.toString()
      const isBuyer = offer.buyer.equals(wallet.publicKey)
      
      const cached = loadCachedOffers(walletKey)[offerPubkey.toString()] || {}
      const newStatus = isBuyer 
        ? (cached.sellerConfirmed ? OfferStatus.Completed : OfferStatus.BuyerConfirmed)
        : (cached.buyerConfirmed ? OfferStatus.Completed : OfferStatus.SellerConfirmed)
      
      updateCachedOffer(walletKey, offerPubkey.toString(), {
        buyerConfirmed: isBuyer ? true : cached.buyerConfirmed,
        sellerConfirmed: !isBuyer ? true : cached.sellerConfirmed,
        status: newStatus,
        ...(newStatus === OfferStatus.Completed && { isTerminal: true, terminalAt: Date.now() })
      })

      return { success: true, txHash: tx }
    } catch (err) {
      console.error('❌ Release error:', err)
      setError(err.message)
      throw err
    } finally {
      setLoading(false)
    }
  }, [getProgram, wallet?.publicKey])

  /**
   * Burn all deposits for an offer
   */
  const burnOffer = useCallback(async (offerPubkey) => {
    setLoading(true)
    setError(null)

    try {
      const program = getProgram()
      if (!program || !wallet?.publicKey) throw new Error('Wallet not connected')

      const offer = await program.account.offer.fetch(offerPubkey)
      const [buyerIndexPDA] = getBuyerIndexPDA(offer.buyer)
      const [sellerIndexPDA] = getSellerIndexPDA(offer.seller)
      const [escrowVaultAuthorityPDA] = getEscrowVaultAuthorityPDA(offerPubkey)

      const escrowVault = await getAssociatedTokenAddress(TOKEN_MINT, escrowVaultAuthorityPDA, true)

      const tx = await program.methods
        .burnDeposits()
        .accounts({
          signer: wallet.publicKey,
          offer: offerPubkey,
          escrowVault: escrowVault,
          escrowVaultAuthority: escrowVaultAuthorityPDA,
          buyerIndex: buyerIndexPDA,
          sellerIndex: sellerIndexPDA,
          buyer: offer.buyer,
          mint: TOKEN_MINT,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc()

      console.log('✅ Burned:', tx)

      // Mark as terminal
      const walletKey = wallet.publicKey.toString()
      markOfferTerminal(walletKey, offerPubkey.toString(), OfferStatus.Burned)

      return { success: true, txHash: tx }
    } catch (err) {
      console.error('❌ Burn error:', err)
      setError(err.message)
      throw err
    } finally {
      setLoading(false)
    }
  }, [getProgram, wallet?.publicKey])

  /**
   * Fetch single offer status (for manual refresh)
   */
  const fetchOfferStatus = useCallback(async (offerPubkey) => {
    const program = getProgram()
    if (!program) throw new Error('Wallet not connected')

    try {
      const offer = await program.account.offer.fetch(offerPubkey)
      
      // Update cache
      const walletKey = wallet.publicKey.toString()
      const serialized = serializeOffer(offer, offerPubkey)
      if (isTerminalStatus(offer.status)) {
        serialized.isTerminal = true
        serialized.terminalAt = Date.now()
      }
      updateCachedOffer(walletKey, offerPubkey.toString(), serialized)
      
      return { publicKey: offerPubkey, ...offer }
    } catch (err) {
      console.error('Error fetching offer:', err)
      throw err
    }
  }, [getProgram, wallet?.publicKey])

  return {
    loading,
    error,
    getTokenBalance,
    fetchAllUserOffers,
    findOfferByCode,
    readOfferByCode,
    fetchOfferStatus,
    createOffer,
    acceptOffer,
    cancelOffer,
    releaseOffer,
    burnOffer,
    initializeBuyerIndex,
    initializeSellerIndex,
  }
}