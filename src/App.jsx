import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Connection, clusterApiUrl, PublicKey } from '@solana/web3.js'
import { 
  ConnectionProvider, 
  WalletProvider, 
  useWallet, 
  useConnection 
} from '@solana/wallet-adapter-react'
import { 
  WalletModalProvider, 
  useWalletModal 
} from '@solana/wallet-adapter-react-ui'
import { 
  PhantomWalletAdapter,
  SolflareWalletAdapter,
  TorusWalletAdapter,
} from '@solana/wallet-adapter-wallets'
import { NETWORK, DEFAULT_RPC_ENDPOINT, RPC_SETTINGS_KEY, getRpcEndpoint, getRpcHeaders, MIN_REFRESH_INTERVAL, OfferStatus } from './constants'
import { useEscrowProgram } from './useEscrow'
import { useTokenPrice, formatLastUpdated } from './usePrice'
import { 
  formatNumber, 
  formatUSD, 
  shortenAddress, 
  getStatusInfo, 
  parseOfferStatus,
  canCancelOffer,
  canReleaseOffer,
  canBurnOffer,
  copyToClipboard,
  generateCode,
  fromTokenAmount,
  hashCode,
  formatDateTime
} from './utils'

// Import wallet adapter styles
import '@solana/wallet-adapter-react-ui/styles.css'

// Local storage keys for contract metadata
const CONTRACTS_METADATA_KEY = 'h173k_contracts_metadata'

function App() {
  // State for RPC settings - triggers re-render when changed
  const [rpcEndpoint, setRpcEndpoint] = useState(() => getRpcEndpoint())
  const [rpcVersion, setRpcVersion] = useState(0) // Force re-mount on RPC change

  const endpoint = useMemo(() => rpcEndpoint, [rpcEndpoint])
  
  // Create connection config with potential API headers
  const connectionConfig = useMemo(() => {
    const headers = getRpcHeaders()
    if (Object.keys(headers).length > 0) {
      return {
        commitment: 'confirmed',
        httpHeaders: headers
      }
    }
    return { commitment: 'confirmed' }
  }, [rpcVersion])

  const wallets = useMemo(() => [
    new PhantomWalletAdapter(),
    new SolflareWalletAdapter(),
    new TorusWalletAdapter(),
  ], [])

  // Handler to update RPC settings
  const handleRpcSettingsChange = useCallback(() => {
    setRpcEndpoint(getRpcEndpoint())
    setRpcVersion(v => v + 1)
  }, [])

  return (
    <ConnectionProvider endpoint={endpoint} config={connectionConfig} key={rpcVersion}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <div className="app-background">
            <div className="light-streak" />
          </div>
          <div className="app-container">
            <MainContent onRpcSettingsChange={handleRpcSettingsChange} />
          </div>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  )
}

function MainContent({ onRpcSettingsChange }) {
  const { publicKey, connected, disconnect, signMessage } = useWallet()
  const { connection } = useConnection()
  const { setVisible } = useWalletModal()
  const escrow = useEscrowProgram(connection, useWallet())
  const priceHook = useTokenPrice()
  const { price, toUSD, loading: priceLoading, error: priceError } = priceHook

// State
  const [balance, setBalance] = useState(0)
  const [contracts, setContracts] = useState([])
  const [contractsMetadata, setContractsMetadata] = useState(() => {
    // Load metadata from localStorage on mount
    try {
      const stored = localStorage.getItem(CONTRACTS_METADATA_KEY)
      return stored ? JSON.parse(stored) : {}
    } catch (err) {
      console.error('Error loading contracts metadata:', err)
      return {}
    }
  })
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [lastRefresh, setLastRefresh] = useState(0)
  const [priceRefreshCooldown, setPriceRefreshCooldown] = useState(false)

  // Panels state
  const [showNewPanel, setShowNewPanel] = useState(false)
  const [showAcceptPanel, setShowAcceptPanel] = useState(false)
  const [showDetailPanel, setShowDetailPanel] = useState(null)
  const [showBurnConfirm, setShowBurnConfirm] = useState(null)
  const [showImportPanel, setShowImportPanel] = useState(false)
  const [showSettingsPanel, setShowSettingsPanel] = useState(false)

  // Toast
  const [toast, setToast] = useState(null)
  

  // Pull to refresh
  const contractsListRef = useRef(null)
  const touchStartY = useRef(0)
  const isPulling = useRef(false)

// Detect if desktop (non-touch device)
  const [isDesktop, setIsDesktop] = useState(false)

 useEffect(() => {
    const checkIsDesktop = () => {
      setIsDesktop(window.innerWidth > 768 && !('ontouchstart' in window))
    }
    checkIsDesktop()
    window.addEventListener('resize', checkIsDesktop)
    return () => window.removeEventListener('resize', checkIsDesktop)
  }, [])

  // Initial fetch and auto-refresh
  useEffect(() => {
    if (!connected || !publicKey) return
    
    let timer
    let interval
    
    if (isDesktop) {
      console.log("Device type: Desktop")
      timer = setTimeout(() => {
        fetchData()
      }, 500)
      fetchData()
      interval = setInterval(() => {
        fetchData()
      }, 60000) // 60 seconds
    } else {
      console.log("Device type: Mobile")
      timer = setTimeout(() => {
        fetchData()
      }, 500)
    }
    
    return () => {
      clearTimeout(timer)
      if (interval) clearInterval(interval)
    }
  }, [connected, publicKey, isDesktop])


  
  const showToast = useCallback((message, type = 'info') => {
  console.log("showToast CALLED:", message, type)
  setToast({ message, type })
  setTimeout(() => setToast(null), 3000)
}, [])

  // Save contracts metadata to localStorage
  const saveMetadata = useCallback((newMetadata) => {
    setContractsMetadata(newMetadata)
    try {
      localStorage.setItem(CONTRACTS_METADATA_KEY, JSON.stringify(newMetadata))
    } catch (err) {
      console.error('Error saving contracts metadata:', err)
    }
  }, [])


const deleteCompletedContract = useCallback((contractPublicKey) => {
  const key = contractPublicKey.toString()
  
  // First mark the contract as removing to trigger animation
  setContracts(prev => prev.map(c => 
    c.publicKey.toString() === key ? { ...c, _isRemoving: true } : c
  ))
  
  // Close the detail panel immediately
  setShowDetailPanel(null)
  
  // Wait for animation to complete before actually removing
  setTimeout(() => {
    let currentMetadata = {}
    try {
      const stored = localStorage.getItem(CONTRACTS_METADATA_KEY)
      currentMetadata = stored ? JSON.parse(stored) : {}
    } catch (err) {
      console.error('Error reading metadata:', err)
    }
    
    // ⬇️ ZMIANA: Zamiast usuwać, oznacz jako hidden
    const newMetadata = {
      ...currentMetadata,
      [key]: {
        ...currentMetadata[key],
        hidden: true,
        hiddenAt: Date.now()
      }
    }
    
    try {
      localStorage.setItem(CONTRACTS_METADATA_KEY, JSON.stringify(newMetadata))
      setContractsMetadata(newMetadata)
    } catch (err) {
      console.error('Error saving metadata:', err)
    }
    
    showToast('Contract deleted', 'success')
    setContracts(prev => prev.filter(c => c.publicKey.toString() !== key))
  }, 450)
}, [showToast])

const fetchData = useCallback(async () => {
  if (!connected || !publicKey) return
  
  try {
    // 1. Pobierz balance
    const tokenBalance = await escrow.getTokenBalance()
    setBalance(tokenBalance)
    
    // 2. Pobierz oferty
    const activeOffers = await escrow.fetchAllUserOffers()
    
    // 3. Load metadata
    let currentMetadata = {}
    try {
      const stored = localStorage.getItem(CONTRACTS_METADATA_KEY)
      currentMetadata = stored ? JSON.parse(stored) : {}
    } catch (err) {
      console.error('Error loading metadata:', err)
    }
    
    // ⬇️ NOWE: Filtruj ukryte kontrakty
    const visibleOffers = activeOffers.filter(offer => {
      const meta = currentMetadata[offer.publicKey.toString()]
      return !meta?.hidden
    })
    
    // 4. Mapuj z metadata
    const offersWithMetadata = visibleOffers.map(offer => ({
      ...offer,
      _metadata: currentMetadata[offer.publicKey.toString()]
    }))
    
    // 5. Sortuj
    offersWithMetadata.sort((a, b) => {
      const statusA = parseOfferStatus(a.status)
      const statusB = parseOfferStatus(b.status)
      
      const aTerminal = [OfferStatus.Completed, OfferStatus.Burned, OfferStatus.Cancelled].includes(statusA)
      const bTerminal = [OfferStatus.Completed, OfferStatus.Burned, OfferStatus.Cancelled].includes(statusB)
      
      if (aTerminal && !bTerminal) return 1
      if (!aTerminal && bTerminal) return -1
      
      return (b._metadata?.timestamp || 0) - (a._metadata?.timestamp || 0)
    })
    
    setContracts(offersWithMetadata)
    setContractsMetadata(currentMetadata)
    
  } catch (err) {
    console.error('Error in fetchData:', err)
  }
}, [connected, publicKey, escrow])

// Zmień funkcję handlePriceRefresh na:
const handlePriceRefresh = useCallback(async () => {
  if (priceRefreshCooldown) return
  
  setPriceRefreshCooldown(true)
  
  // Refresh price
  await priceHook.refetch()
  
  // Refresh contracts (only on desktop)
  if (isDesktop) {
    await fetchData()
  }
  
  setTimeout(() => {
    setPriceRefreshCooldown(false)
  }, 5000) // 5 second cooldown
}, [priceRefreshCooldown, priceHook, isDesktop, fetchData])



  // Pull to refresh handler
  const handleRefresh = useCallback(async () => {
    const now = Date.now()
    if (now - lastRefresh < MIN_REFRESH_INTERVAL) return
    
    setRefreshing(true)
    setLastRefresh(now)
    await fetchData()
    setRefreshing(false)
  }, [fetchData, lastRefresh])

  // Touch handlers for pull to refresh
  const handleTouchStart = useCallback((e) => {
    if (contractsListRef.current?.scrollTop === 0) {
      touchStartY.current = e.touches[0].clientY
      isPulling.current = true
    }
  }, [])

  const handleTouchMove = useCallback((e) => {
    if (!isPulling.current) return
    const diff = e.touches[0].clientY - touchStartY.current
    if (diff > 100 && !refreshing) {
      handleRefresh()
      isPulling.current = false
    }
  }, [handleRefresh, refreshing])

  const handleTouchEnd = useCallback(() => {
    isPulling.current = false
  }, [])

  // Connect wallet
  const handleConnect = useCallback(() => {
    setVisible(true)
  }, [setVisible])

  // Disconnect wallet
  const handleDisconnect = useCallback(() => {
    disconnect()
  }, [disconnect])

  // Render based on connection state
  if (!connected) {
    return <ConnectScreen onConnect={handleConnect} />
  }

  return (
    <Dashboard
      publicKey={publicKey}
      balance={balance}
      contracts={contracts}
      contractsMetadata={contractsMetadata}
      price={price}
      toUSD={toUSD}
      priceLoading={priceLoading}
      onDisconnect={handleDisconnect}
      onPriceRefresh={handlePriceRefresh}
      priceRefreshCooldown={priceRefreshCooldown}
      isDesktop={isDesktop}
      onNewContract={() => setShowNewPanel(true)}
      onAcceptContract={() => setShowAcceptPanel(true)}
      onImportContract={() => setShowImportPanel(true)}
      onOpenSettings={() => setShowSettingsPanel(true)}
      onViewContract={(contract) => setShowDetailPanel(contract)}
      onRefresh={handleRefresh}
      refreshing={refreshing}
      contractsListRef={contractsListRef}
      handleTouchStart={handleTouchStart}
      handleTouchMove={handleTouchMove}
      handleTouchEnd={handleTouchEnd}
      showToast={showToast}
    >
      {/* Settings Panel */}
      {showSettingsPanel && (
        <SettingsPanel
          onClose={() => setShowSettingsPanel(false)}
          onSave={() => {
            setShowSettingsPanel(false)
            onRpcSettingsChange()
            showToast('RPC settings updated!', 'success')
          }}
          showToast={showToast}
        />
      )}

      {/* New Contract Panel */}
      {showNewPanel && (
        <NewContractPanel
          escrow={escrow}
          balance={balance}
          toUSD={toUSD}
          onClose={() => setShowNewPanel(false)}
          onSuccess={(result) => {
            const newMetadata = {
              ...contractsMetadata,
              [result.offerPDA.toString()]: {
                name: result.name,
                code: result.code,
                amount: result.amount,
                timestamp: Date.now(),
                createdAt: new Date().toISOString(),
              },
            }
            saveMetadata(newMetadata)
            setShowNewPanel(false)
            showToast('Contract created successfully!', 'success')
            fetchData()
          }}
          showToast={showToast}
        />
      )}

      {/* Accept Contract Panel */}
      {showAcceptPanel && (
        <AcceptContractPanel
          escrow={escrow}
          balance={balance}
          toUSD={toUSD}
          onClose={() => setShowAcceptPanel(false)}
          onSuccess={(result) => {
            const newMetadata = {
              ...contractsMetadata,
              [result.offerPDA.toString()]: {
                name: result.name,
                code: result.code,
                amount: result.amount,
                timestamp: Date.now(),
                acceptedAt: new Date().toISOString(),
              },
            }
            saveMetadata(newMetadata)
            setShowAcceptPanel(false)
            showToast('Contract accepted successfully!', 'success')
            fetchData()
          }}
          showToast={showToast}
        />
      )}

      {/* Import Contract Panel */}
      {showImportPanel && (
        <ImportContractPanel
          escrow={escrow}
          onClose={() => setShowImportPanel(false)}
          onSuccess={(result) => {
  const newMetadata = {
    ...contractsMetadata,
    [result.publicKey.toString()]: {
      name: result.name,
      code: result.code,
      amount: result.amount,
      timestamp: Date.now(),
      importedAt: new Date().toISOString(),
      hidden: false,  // ⬅️ DODAJ TO - przywraca ukryty kontrakt przy imporcie
      ...(result.isClosed && {
        completed: true,
        completedAt: new Date().toISOString(),
        status: result.statusLabel
      })
    },
  }
  saveMetadata(newMetadata)
  setShowImportPanel(false)
  showToast('Contract imported successfully!', 'success')
  fetchData()
}}
          showToast={showToast}
        />
      )}

      {/* Contract Detail Panel */}
      {showDetailPanel && (
        <ContractDetailPanel
          contract={showDetailPanel}
          metadata={contractsMetadata[showDetailPanel.publicKey?.toString()]}
          publicKey={publicKey}
          escrow={escrow}
          toUSD={toUSD}
          onClose={() => setShowDetailPanel(null)}
          onCancel={async () => {
            try {
              await escrow.cancelOffer(showDetailPanel.publicKey)
              setShowDetailPanel(null)
              showToast('Contract cancelled successfully!', 'success')
              fetchData()
            } catch (err) {
              showToast(err.message, 'error')
            }
          }}
          onRelease={async () => {
            try {
              const contractKey = showDetailPanel.publicKey.toString()
              
              let currentMetadata = {}
              try {
                const stored = localStorage.getItem(CONTRACTS_METADATA_KEY)
                currentMetadata = stored ? JSON.parse(stored) : {}
              } catch (err) {
                console.error('Error reading metadata:', err)
              }
              
              const newMetadata = {
                ...currentMetadata,
                [contractKey]: {
                  ...currentMetadata[contractKey],
                  releaseInitiated: true,
                  releaseInitiatedAt: new Date().toISOString()
                }
              }
              
              try {
                localStorage.setItem(CONTRACTS_METADATA_KEY, JSON.stringify(newMetadata))
                setContractsMetadata(newMetadata)
              } catch (err) {
                console.error('Error saving metadata:', err)
              }
              
              await escrow.releaseOffer(showDetailPanel.publicKey)
              setShowDetailPanel(null)
              showToast('Confirmation sent!', 'success')
              fetchData()
            } catch (err) {
              showToast(err.message, 'error')
            }
          }}
          onBurn={() => setShowBurnConfirm(showDetailPanel)}
          onDelete={() => {
            deleteCompletedContract(showDetailPanel.publicKey)
            setShowDetailPanel(null)
          }}
          showToast={showToast}
        />
      )}

      {/* Burn Confirmation Panel */}
      {showBurnConfirm && (
        <BurnConfirmPanel
          contract={showBurnConfirm}
          metadata={contractsMetadata[showBurnConfirm.publicKey?.toString()]}
          escrow={escrow}
          onClose={() => setShowBurnConfirm(null)}
          onConfirm={async () => {
            try {
              const contractKey = showBurnConfirm.publicKey.toString()
              const newMetadata = {
                ...contractsMetadata,
                [contractKey]: {
                  ...contractsMetadata[contractKey],
                  completed: true,
                  completedAt: new Date().toISOString(),
                  status: 'burned'
                }
              }
              saveMetadata(newMetadata)
              
              await escrow.burnOffer(showBurnConfirm.publicKey)
              setShowBurnConfirm(null)
              setShowDetailPanel(null)
              showToast('Contract burned successfully!', 'success')
              fetchData()
            } catch (err) {
              showToast(err.message, 'error')
            }
          }}
          showToast={showToast}
        />
      )}

      {/* Toast */}
      {toast && (
        <div className="toast-container">
          <div className={`toast ${toast.type}`}>{toast.message}</div>
        </div>
      )}

      {/* Loading Overlay */}
      {escrow.loading && (
        <div className="loading-overlay">
          <div className="loading-spinner" />
          <div className="loading-text">Processing transaction...</div>
        </div>
      )}
    </Dashboard>
  )
}

// Connect Screen Component
function ConnectScreen({ onConnect }) {
  return (
    <div className="connect-screen">
      <div className="logo-container centered">
        <div className="logo large logo-placeholder">
          <img src="/logo.png" alt="h173k" className="logo large" />
        </div>
      </div>
      <button className="btn btn-primary btn-action connect-wallet-btn" onClick={onConnect}>
        Connect Wallet
      </button>
    </div>
  )
}

// Dashboard Component
function Dashboard({ 
  publicKey, 
  balance, 
  contracts, 
  contractsMetadata,
  price,
  toUSD,
  priceLoading,
  onDisconnect,
  onNewContract,
  onAcceptContract,
  onImportContract,
  onOpenSettings,
  onViewContract,
  onRefresh,
  refreshing,
  isDesktop,
  onPriceRefresh,
  priceRefreshCooldown,
  contractsListRef,
  handleTouchStart,
  handleTouchMove,
  handleTouchEnd,
  showToast,
  children 
}) {
  const hasBalance = balance > 0
  const usdBalance = toUSD(balance)

  return (
    <div className="dashboard">
      <button className="btn btn-small disconnect-btn" onClick={onDisconnect}>
        Disconnect
      </button>

      {/* Settings Icon */}
      <button className="settings-btn" onClick={onOpenSettings} title="RPC Settings">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>

      <div className="logo-container top">
        <div className="logo small logo-placeholder">
          <img src="/logo.png" alt="h173k" className="logo small" />
        </div>
      </div>

      <div className="action-buttons">
        <div className="action-button-group">
          <span className="action-label">Create Contract</span>
          <button className="btn btn-action" onClick={onNewContract}>New</button>
        </div>
        <div className="action-button-group">
          <span className="action-label">Accept Contract</span>
          <button className="btn btn-action" onClick={onAcceptContract}>Accept</button>
        </div>
      </div>

      <div className="balance-section">
        {hasBalance ? (
          <>
            <div className="balance-amount">{formatNumber(balance)} h173k</div>
            <div className="balance-usd">
              {usdBalance !== null ? formatUSD(usdBalance) : 'Price unavailable'}
            </div>
          </>
        ) : (
          <>
            <div className="balance-amount">0 h173k</div>
            <div className="balance-warning">
              No h173k on balance. This app only works with h173k tokens.
            </div>
          </>
        )}
        {isDesktop && (
          <button 
            className="btn btn-small refresh-btn" 
            onClick={onPriceRefresh}
            disabled={priceRefreshCooldown}
            title={priceRefreshCooldown ? "Please wait 5 seconds" : "Refresh price and contracts"}
          >
            ↻
          </button>
        )}
      </div>

      <div className="contracts-section">
        <div className="contracts-header-row">
          <div className="contracts-header">Your Contracts</div>
          <button 
            className="import-link" 
            onClick={onImportContract}
          >
            import
          </button>
        </div>
        <div 
          className="contracts-list"
          ref={contractsListRef}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          <div className={`pull-refresh-indicator ${refreshing ? 'visible refreshing' : ''}`}>
            {refreshing ? 'Refreshing...' : 'Pull to refresh'}
          </div>
          
          {contracts.length === 0 ? (
            <div className="contracts-empty">No Contracts Yet</div>
          ) : (
            contracts.map((contract) => (
  <ContractCard
    key={contract.publicKey.toString()}
    contract={contract}
    metadata={contractsMetadata[contract.publicKey.toString()]}
    toUSD={toUSD}
    onClick={() => onViewContract(contract)}
    publicKey={publicKey}
    showToast={showToast}  // <-- DODANE
  />
))
          )}
        </div>
      </div>

      <div className="wallet-address">
        <span 
          className="wallet-address-short"
          onClick={() => copyToClipboard(publicKey.toString())}
          title="Click to copy"
        >
          {shortenAddress(publicKey)}
        </span>
      </div>

      {children}
    </div>
  )
}

// Contract Card Component
function ContractCard({ contract, metadata, toUSD, onClick, publicKey, showToast }) {
  const statusInfo = getStatusInfo(contract.status, contract, publicKey)
  const amount = fromTokenAmount(contract.amount)
  const usdAmount = toUSD(amount)
  const name = metadata?.name || `Contract #${contract.nonce?.toString() || '?'}`
  const code = metadata?.code
  const timestamp = metadata?.timestamp
  const dateTime = timestamp ? formatDateTime(new Date(timestamp)) : null

  const handleCopy = async (e) => {
    e.stopPropagation()
    if (code) {
      const success = await copyToClipboard(code)
      console.log("Copy triggered!")
      if (showToast) {
        console.log("showToast: true")
        showToast(success ? 'Code copied!' : 'Failed to copy', success ? 'success' : 'error')
      }else{
        console.log("showToast: false")
      }
    }
  }

  return (
    <div className="contract-card" onClick={onClick}>
      <div className="contract-card-header">
        <div className="contract-name">
          {name}
          {dateTime && <div className="contract-date">{dateTime}</div>}
        </div>
        <div className={`contract-status ${statusInfo.class}`}>{statusInfo.label}</div>
      </div>
      <div className="contract-card-body">
        <div>
          <div className="contract-amount">{formatNumber(amount)} h173k</div>
          <div className="contract-amount-usd">
            {usdAmount !== null ? formatUSD(usdAmount) : '—'}
          </div>
        </div>
        {code && (
          <button className="btn btn-small btn-copy" onClick={handleCopy}>
            Copy
          </button>
        )}
      </div>
    </div>
  )
}

// Panel Overlay Component
function PanelOverlay({ children, onClose, title, isClosing: externalIsClosing }) {
  const [isClosing, setIsClosing] = useState(false)

  const handleClose = () => {
    setIsClosing(true)
    setTimeout(() => {
      onClose()
    }, 400)
  }

  const closingState = externalIsClosing !== undefined ? externalIsClosing : isClosing

  return (
    <div className={`panel-overlay active ${closingState ? 'closing' : ''}`}>
      <div className="panel-overlay-backdrop" onClick={handleClose} />
      <div className="panel">
        <button className="panel-close" onClick={handleClose} />
        {title && <h2 className="panel-title">{title}</h2>}
        {children}
      </div>
    </div>
  )
}

// New Contract Panel
function NewContractPanel({ escrow, balance, toUSD, onClose, onSuccess, showToast }) {
  const [name, setName] = useState('')
  const [amount, setAmount] = useState('')
  const [code] = useState(() => generateCode())
  const [loading, setLoading] = useState(false)

  const amountNum = parseFloat(amount) || 0
  const usdAmount = toUSD(amountNum)
  const requiredDeposit = amountNum * 2
  const hasEnoughBalance = balance >= requiredDeposit

  const handleCreate = async () => {
    if (!name.trim()) {
      showToast('Please enter a contract name', 'error')
      return
    }
    if (amountNum <= 0) {
      showToast('Please enter a valid amount', 'error')
      return
    }
    if (!hasEnoughBalance) {
      showToast('Insufficient balance. Need 2x the contract amount as deposit.', 'error')
      return
    }

    setLoading(true)
    try {
      const result = await escrow.createOffer(amountNum, code, name.trim())
      onSuccess(result)
    } catch (err) {
      showToast(err.message, 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <PanelOverlay onClose={onClose} title="New Contract">
      <div className="form-group">
        <label className="form-label">Contract Name</label>
        <input
          type="text"
          className="form-input"
          placeholder="Enter name..."
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={50}
        />
      </div>

      <div className="form-group">
        <label className="form-label">Amount (h173k)</label>
        <div className="amount-input-wrapper">
          <input
            type="number"
            className="form-input"
            placeholder="0.00"
            value={amount}
            onChange={(e) => {
              const value = e.target.value;
              if (value === '' || parseFloat(value) >= 0) {
                setAmount(value);
              }
            }}
            min="0"
            step="any"
            onKeyDown={(e) => {
              if (e.key === '-' || e.key === 'e' || e.key === 'E') {
                e.preventDefault();
              }
            }}
          />
          {usdAmount !== null && amountNum > 0 && (
            <span className="amount-usd-preview">≈ {formatUSD(usdAmount)}</span>
          )}
        </div>
        <div className="form-input-hint">
          Required deposit: {formatNumber(requiredDeposit)} h173k (2x amount)
        </div>
      </div>

      <div className="form-group">
        <label className="form-label">Contract Code</label>
        <div className="code-display">{code}</div>
        <div className="form-input-hint">
          Share this code with the seller to accept the contract
        </div>
      </div>

      {!hasEnoughBalance && amountNum > 0 && (
        <div className="error-message">
          Insufficient balance. You need {formatNumber(requiredDeposit)} h173k but only have {formatNumber(balance)} h173k.
        </div>
      )}

      <button 
        className="btn btn-primary" 
        onClick={handleCreate}
        disabled={loading || !hasEnoughBalance || amountNum <= 0}
        style={{ width: '100%', marginTop: '16px' }}
      >
        {loading ? 'Creating...' : 'Create'}
      </button>
    </PanelOverlay>
  )
}

// Accept Contract Panel - z funkcją "Click to Paste"

function AcceptContractPanel({ escrow, balance, toUSD, onClose, onSuccess, showToast }) {
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(false)

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (text) {
        setCode(text.toUpperCase().trim())
        showToast('Code pasted!', 'success')
      }
    } catch (err) {
      console.error('Failed to paste:', err)
      showToast('Failed to paste. Please paste manually.', 'error')
    }
  }

  const handleAccept = async () => {
    if (!name.trim()) {
      showToast('Please enter a contract name', 'error')
      return
    }
    
    if (!code.trim()) {
      showToast('Please enter a contract code', 'error')
      return
    }

    setLoading(true)
    try {
      const matchingOffer = await escrow.findOfferByCode(code.trim())
      
      if (!matchingOffer) {
        showToast('Invalid code or offer not found', 'error')
        setLoading(false)
        return
      }
      
      const requiredAmount = fromTokenAmount(matchingOffer.amount) * 2
      if (balance < requiredAmount) {
        showToast(`Insufficient balance. Need ${formatNumber(requiredAmount)} h173k`, 'error')
        setLoading(false)
        return
      }
      
      await escrow.acceptOffer(matchingOffer.publicKey, code.trim())
      showToast('Contract accepted successfully!', 'success')
      
      onSuccess({
        offerPDA: matchingOffer.publicKey,
        code: code.trim(),
        amount: fromTokenAmount(matchingOffer.amount),
        name: name.trim()
      })
    } catch (err) {
      console.error('Accept error:', err)
      showToast(err.message, 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <PanelOverlay onClose={onClose} title="Accept Contract">
      <div className="accept-contract-info">
        <p>
          Enter the contract code shared by the buyer to accept their offer.
          You will need to deposit the contract amount as collateral.
        </p>
      </div>

      <div className="form-group">
        <label className="form-label">Contract Name</label>
        <input
          type="text"
          className="form-input"
          placeholder="Enter name..."
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={50}
        />
      </div>

      <div className="form-group">
  <label className="form-label">Contract Code</label>
  <div className="input-with-button-wrapper">
    <input
      type="text"
      className="form-input"
      placeholder="Click to paste or enter code..."
      value={code}
      onChange={(e) => setCode(e.target.value.toUpperCase())}
      onClick={handlePaste}
      maxLength={20}
      style={{ cursor: 'pointer' }}
    />
    <button 
      type="button"
      className="btn btn-small input-paste-btn" 
      onClick={handlePaste}
    >
      Paste
    </button>
  </div>
  <div className="form-input-hint">Click the field or button to paste from clipboard</div>
</div>

      <button 
        className="btn btn-primary" 
        onClick={handleAccept}
        disabled={loading || !code.trim() || !name.trim()}
        style={{ width: '100%', marginTop: '16px' }}
      >
        {loading ? 'Accepting...' : 'Accept'}
      </button>
    </PanelOverlay>
  )
}

// Contract Detail Panel
function ContractDetailPanel({ 
  contract, 
  metadata, 
  publicKey,
  escrow, 
  toUSD, 
  onClose, 
  onCancel, 
  onRelease, 
  onBurn,
  onDelete,
  showToast 
}) {
  const [isClosing, setIsClosing] = useState(false)

  const handleClose = () => {
    setIsClosing(true)
    setTimeout(() => {
      onClose()
    }, 400)
  }

  const handleDelete = () => {
    setIsClosing(true)
    setTimeout(() => {
      onDelete()
    }, 400)
  }

  const handleCancel = async () => {
    setIsClosing(true)
    setTimeout(async () => {
      await onCancel()
    }, 400)
  }

  const handleRelease = async () => {
    setIsClosing(true)
    setTimeout(async () => {
      await onRelease()
    }, 400)
  }

  const handleBurn = () => {
    setIsClosing(true)
    setTimeout(() => {
      onBurn()
    }, 400)
  }

  const statusInfo = getStatusInfo(contract.status, contract, publicKey)
  const amount = fromTokenAmount(contract.amount)
  const buyerDeposit = fromTokenAmount(contract.buyerDeposit)
  const sellerDeposit = buyerDeposit / 2
  const usdAmount = toUSD(amount)
  const name = metadata?.name || `Contract #${contract.nonce?.toString() || '?'}`
  const code = metadata?.code
  const timestamp = metadata?.timestamp
  const dateTime = timestamp ? formatDateTime(new Date(timestamp)) : null

  const status = parseOfferStatus(contract.status)
  const isCompleted = metadata?.completed || status === OfferStatus.Completed || status === OfferStatus.Burned || status === OfferStatus.Cancelled
  const canCancel = !isCompleted && canCancelOffer(contract, publicKey)
  const canRelease = !isCompleted && canReleaseOffer(contract, publicKey)
  const canBurn = !isCompleted && canBurnOffer(contract, publicKey)

  const isBuyer = contract.buyer.equals(publicKey)
  const DEFAULT_PUBKEY = new PublicKey('11111111111111111111111111111111')
  const isSeller = contract.seller && !contract.seller.equals(DEFAULT_PUBKEY) && contract.seller.equals(publicKey)

  const handleCopyCode = async () => {
    if (code) {
      const success = await copyToClipboard(code)
      showToast(success ? 'Code copied!' : 'Failed to copy', success ? 'success' : 'error')
    }
  }

  return (
    <PanelOverlay onClose={handleClose} title={name} isClosing={isClosing}>
      <div className="contract-detail-row">
        <span className="contract-detail-label">Status</span>
        <span className={`contract-status ${statusInfo.class}`}>{statusInfo.label}</span>
      </div>

      {dateTime && (
        <div className="contract-detail-row">
          <span className="contract-detail-label">Date</span>
          <span className="contract-detail-value">{dateTime}</span>
        </div>
      )}

      <div className="contract-detail-row">
        <span className="contract-detail-label">Amount</span>
        <span className="contract-detail-value">
          {formatNumber(amount)} h173k
          {usdAmount !== null && <span style={{ opacity: 0.7, marginLeft: 8 }}>({formatUSD(usdAmount)})</span>}
        </span>
      </div>

      <div className="contract-detail-row">
        <span className="contract-detail-label">Your Role</span>
        <span className="contract-detail-value">
          {isBuyer ? 'Buyer' : isSeller ? 'Seller' : '—'}
        </span>
      </div>

      <div className="contract-detail-row">
        <span className="contract-detail-label">Buyer Deposit</span>
        <span className="contract-detail-value">{formatNumber(buyerDeposit)} h173k</span>
      </div>

      {sellerDeposit > 0 && (
        <div className="contract-detail-row">
          <span className="contract-detail-label">Seller Deposit</span>
          <span className="contract-detail-value">{formatNumber(sellerDeposit)} h173k</span>
        </div>
      )}

      {code && (
        <div className="contract-detail-row">
          <span className="contract-detail-label">Code</span>
          <button className="btn btn-small" onClick={handleCopyCode}>
            Copy Code
          </button>
        </div>
      )}

      <div className="contract-actions">
        {isCompleted ? (
          <button className="btn btn-danger" onClick={handleDelete}>
            Delete
          </button>
        ) : (
          <>
            {canCancel && (
              <button className="btn btn-warning" onClick={handleCancel}>
                Cancel Contract
              </button>
            )}
            {canRelease && (
              <button 
                className="btn btn-success" 
                onClick={handleRelease}
                disabled={(isBuyer && contract.buyerConfirmed) || (isSeller && contract.sellerConfirmed)}
              >
                {contract.buyerConfirmed && isSeller ? 'Confirm Release' : 
                 contract.sellerConfirmed && isBuyer ? 'Confirm Release' : 
                 contract.buyerConfirmed && isBuyer ? 'Waiting for Seller' :
                 contract.sellerConfirmed && isSeller ? 'Waiting for Buyer' :
                 'Release Funds'}
              </button>
            )}
            {canBurn && (
              <button className="btn btn-danger" onClick={handleBurn}>
                Burn Contract
              </button>
            )}
          </>
        )}
      </div>
    </PanelOverlay>
  )
}

// Burn Confirmation Panel
function BurnConfirmPanel({ contract, metadata, escrow, onClose, onConfirm, showToast }) {
  const [inputCode, setInputCode] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const expectedCode = metadata?.code

  const handleConfirm = async () => {
    if (!inputCode.trim()) {
      setError('Please enter the contract code')
      return
    }
    
    if (expectedCode && inputCode.trim().toUpperCase() !== expectedCode.toUpperCase()) {
      setError('Code does not match this contract')
      return
    }

    setLoading(true)
    try {
      await onConfirm()
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <PanelOverlay onClose={onClose} title="Burn Contract">
      <div className="confirm-dialog">
        <p className="confirm-dialog-message">
          ⚠️ Warning: This action will permanently burn ALL deposits in this contract. 
          Both buyer and seller deposits will be destroyed. This cannot be undone!
        </p>

        <div className="form-group">
          <label className="form-label">Enter Contract Code to Confirm</label>
          <input
            type="text"
            className="form-input"
            placeholder="Enter code..."
            value={inputCode}
            onChange={(e) => {
              setInputCode(e.target.value.toUpperCase())
              setError('')
            }}
            maxLength={20}
          />
        </div>

        {error && <div className="error-message">{error}</div>}

        <div className="confirm-dialog-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button 
            className="btn btn-danger" 
            onClick={handleConfirm}
            disabled={loading}
          >
            {loading ? 'Burning...' : 'Burn'}
          </button>
        </div>
      </div>
    </PanelOverlay>
  )
}

// Import Contract Panel
function ImportContractPanel({ escrow, onClose, onSuccess, showToast }) {
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [foundContract, setFoundContract] = useState(null)
  const [isClosing, setIsClosing] = useState(false)

  const handleClose = () => {
    setIsClosing(true)
    setTimeout(() => {
      onClose()
    }, 400)
  }

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText()
      setCode(text.trim().toUpperCase())
      setError('')
    } catch (err) {
      showToast('Could not read clipboard', 'error')
    }
  }

  const handleSearch = async () => {
    if (!code.trim()) {
      setError('Please enter a contract code')
      return
    }

    setLoading(true)
    setError('')
    setFoundContract(null)

    try {
      const offer = await escrow.readOfferByCode(code.trim())
      
      if (!offer) {
        setError('No contract found with this code')
        return
      }

      // Determine status
      const status = parseOfferStatus(offer.status)
      let statusLabel = 'unknown'
      if (status === OfferStatus.Completed) statusLabel = 'completed'
      else if (status === OfferStatus.Burned) statusLabel = 'burned'
      else if (status === OfferStatus.Cancelled) statusLabel = 'cancelled'
      else if (status === OfferStatus.Locked) statusLabel = 'ongoing'
      else if (status === OfferStatus.BuyerConfirmed || status === OfferStatus.SellerConfirmed) statusLabel = 'pending-release'
      else if (status === OfferStatus.PendingSeller) statusLabel = 'pending'

      setFoundContract({
        ...offer,
        statusLabel,
        isClosed: offer.isClosed || status === OfferStatus.Completed || status === OfferStatus.Burned || status === OfferStatus.Cancelled
      })
      
      // Auto-generate a name suggestion
      if (!name) {
        setName(`Imported #${offer.nonce?.toString() || '?'}`)
      }
    } catch (err) {
      console.error('Error searching for contract:', err)
      setError(err.message || 'Failed to find contract')
    } finally {
      setLoading(false)
    }
  }

  const handleImport = () => {
    if (!foundContract) return
    if (!name.trim()) {
      setError('Please enter a name for this contract')
      return
    }

    onSuccess({
      publicKey: foundContract.publicKey,
      name: name.trim(),
      code: code.trim(),
      amount: fromTokenAmount(foundContract.amount),
      isClosed: foundContract.isClosed,
      statusLabel: foundContract.statusLabel
    })
  }

  const amount = foundContract ? fromTokenAmount(foundContract.amount) : 0
  const statusInfo = foundContract ? getStatusInfo(foundContract.status) : null

  return (
    <PanelOverlay onClose={handleClose} title="Import Contract" isClosing={isClosing}>
      <div className="import-contract-info">
        <p>
          Lost a contract from your list? Enter the code to recover it. 
          This works even for completed, cancelled or burned contracts.
        </p>
      </div>

      <div className="form-group">
        <label className="form-label">Contract Code</label>
        <div className="input-with-button-wrapper">
          <input
            type="text"
            className="form-input"
            placeholder="Enter code..."
            value={code}
            onChange={(e) => {
              setCode(e.target.value.toUpperCase())
              setError('')
              setFoundContract(null)
            }}
            maxLength={20}
            style={{ cursor: 'pointer' }}
          />
          <button 
            type="button"
            className="btn btn-small input-paste-btn" 
            onClick={handlePaste}
          >
            Paste
          </button>
        </div>
      </div>

      {!foundContract && (
        <button 
          className="btn btn-primary" 
          onClick={handleSearch}
          disabled={loading || !code.trim()}
          style={{ width: '100%', marginTop: '16px' }}
        >
          {loading ? 'Searching...' : 'Find Contract'}
        </button>
      )}

      {error && <div className="error-message" style={{ marginTop: '12px' }}>{error}</div>}

      {foundContract && (
        <div className="found-contract-preview">
          <div className="contract-preview-row">
            <span className="contract-preview-label">Status</span>
            <span className={`contract-status ${statusInfo?.class}`}>{statusInfo?.label}</span>
          </div>
          <div className="contract-preview-row">
            <span className="contract-preview-label">Amount</span>
            <span className="contract-preview-value">{formatNumber(amount)} h173k</span>
          </div>
          {foundContract.isClosed && (
            <div className="contract-preview-closed">
              This contract is closed but will be added to your history.
            </div>
          )}

          <div className="form-group" style={{ marginTop: '16px' }}>
            <label className="form-label">Contract Name</label>
            <input
              type="text"
              className="form-input"
              placeholder="e.g. Payment from Alice"
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                setError('')
              }}
              maxLength={50}
            />
          </div>

          <button 
            className="btn btn-primary" 
            onClick={handleImport}
            disabled={!name.trim()}
            style={{ width: '100%', marginTop: '16px' }}
          >
            Import Contract
          </button>
        </div>
      )}
    </PanelOverlay>
  )
}

// Settings Panel Component - RPC Node Configuration
function SettingsPanel({ onClose, onSave, showToast }) {
  const [customRpcUrl, setCustomRpcUrl] = useState('')
  const [apiKeyName, setApiKeyName] = useState('')
  const [apiKeyValue, setApiKeyValue] = useState('')
  const [testingConnection, setTestingConnection] = useState(false)
  const [testResult, setTestResult] = useState(null)

  // Load existing settings on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(RPC_SETTINGS_KEY)
      if (stored) {
        const settings = JSON.parse(stored)
        setCustomRpcUrl(settings.customRpcUrl || '')
        setApiKeyName(settings.apiKeyName || '')
        setApiKeyValue(settings.apiKeyValue || '')
      }
    } catch (err) {
      console.error('Error loading RPC settings:', err)
    }
  }, [])

  const testConnection = async () => {
    const urlToTest = customRpcUrl.trim() || DEFAULT_RPC_ENDPOINT
    setTestingConnection(true)
    setTestResult(null)

    try {
      const headers = {
        'Content-Type': 'application/json',
      }
      if (apiKeyName && apiKeyValue) {
        headers[apiKeyName] = apiKeyValue
      }

      // Test z rzeczywistym zapytaniem które wymaga autoryzacji
      // Używamy getTokenAccountsByOwner z losowym adresem
      const testAddress = '11111111111111111111111111111111' // System program - zawsze istnieje
      const response = await fetch(urlToTest, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getBalance',
          params: [testAddress],
        }),
      })

      if (response.ok) {
        const data = await response.json()
        if (data.error) {
          // Sprawdź czy to błąd autoryzacji
          if (data.error.code === -32401 || data.error.message?.toLowerCase().includes('api key')) {
            setTestResult({ success: false, message: 'API key missing or invalid. For Helius, include the key in URL: https://mainnet.helius-rpc.com/?api-key=YOUR_KEY' })
          } else if (data.error.code === 403 || data.error.message?.toLowerCase().includes('forbidden')) {
            setTestResult({ success: false, message: 'Access forbidden. Check your API key or RPC URL.' })
          } else {
            setTestResult({ success: false, message: `RPC Error: ${data.error.message}` })
          }
        } else if (data.result !== undefined) {
          setTestResult({ success: true, message: 'Connection successful! RPC is working.' })
        } else {
          setTestResult({ success: false, message: 'Unexpected response from RPC' })
        }
      } else {
        if (response.status === 401) {
          setTestResult({ success: false, message: 'Unauthorized (401). For Helius, include API key in URL.' })
        } else if (response.status === 403) {
          setTestResult({ success: false, message: 'Forbidden (403). Check your API key or use a different RPC.' })
        } else {
          setTestResult({ success: false, message: `HTTP ${response.status}: ${response.statusText}` })
        }
      }
    } catch (err) {
      setTestResult({ success: false, message: `Connection failed: ${err.message}` })
    } finally {
      setTestingConnection(false)
    }
  }

  const handleSave = () => {
    try {
      const settings = {
        customRpcUrl: customRpcUrl.trim(),
        apiKeyName: apiKeyName.trim(),
        apiKeyValue: apiKeyValue.trim(),
        updatedAt: new Date().toISOString(),
      }
      localStorage.setItem(RPC_SETTINGS_KEY, JSON.stringify(settings))
      onSave()
    } catch (err) {
      showToast('Failed to save settings', 'error')
    }
  }

  const handleReset = () => {
    setCustomRpcUrl('')
    setApiKeyName('')
    setApiKeyValue('')
    setTestResult(null)
    try {
      localStorage.removeItem(RPC_SETTINGS_KEY)
      showToast('Settings reset to default', 'info')
    } catch (err) {
      console.error('Error resetting settings:', err)
    }
  }

  const isUsingCustomRpc = customRpcUrl.trim().length > 0

  return (
    <PanelOverlay onClose={onClose} title="RPC Settings">
      <div className="settings-panel-content">
        <div className="settings-info">
          <p>Configure a custom RPC node for improved performance or to use your own infrastructure.</p>
        </div>

        <div className="settings-current-rpc">
          <span className="settings-label">Current RPC:</span>
          <span className={`settings-rpc-badge ${isUsingCustomRpc ? 'custom' : 'default'}`}>
            {isUsingCustomRpc ? 'Custom' : 'Default (Mainnet)'}
          </span>
        </div>

        <div className="form-group">
          <label className="form-label">Custom RPC URL</label>
          <input
            type="url"
            className="form-input"
            placeholder="https://your-rpc-endpoint.com"
            value={customRpcUrl}
            onChange={(e) => {
              setCustomRpcUrl(e.target.value)
              setTestResult(null)
            }}
          />
          <span className="form-hint">Leave empty to use default Solana Mainnet</span>
        </div>

        <div className="settings-divider">
          <span>API Authentication (Optional)</span>
        </div>

        <div className="form-group">
          <label className="form-label">API Key Header Name</label>
          <input
            type="text"
            className="form-input"
            placeholder="e.g. x-api-key, Authorization"
            value={apiKeyName}
            onChange={(e) => setApiKeyName(e.target.value)}
          />
        </div>

        <div className="form-group">
          <label className="form-label">API Key Value</label>
          <input
            type="password"
            className="form-input"
            placeholder="Your API key..."
            value={apiKeyValue}
            onChange={(e) => setApiKeyValue(e.target.value)}
          />
          <span className="form-hint">Stored locally in your browser</span>
        </div>

        {testResult && (
          <div className={`settings-test-result ${testResult.success ? 'success' : 'error'}`}>
            {testResult.success ? '✓' : '✗'} {testResult.message}
          </div>
        )}

        <div className="settings-actions">
          <button 
            className="btn btn-secondary" 
            onClick={testConnection}
            disabled={testingConnection}
          >
            {testingConnection ? 'Testing...' : 'Test Connection'}
          </button>
          
          <button 
            className="btn btn-primary" 
            onClick={handleSave}
          >
            Save & Apply
          </button>
        </div>

        <button 
          className="btn btn-text settings-reset-btn" 
          onClick={handleReset}
        >
          Reset to Default
        </button>
      </div>
    </PanelOverlay>
  )
}

export default App
