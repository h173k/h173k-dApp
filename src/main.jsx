import React from 'react'
import ReactDOM from 'react-dom/client'
import { Buffer } from 'buffer'
import App from './App'
import './App.css'

// Polyfill for Solana libraries
window.Buffer = Buffer
globalThis.Buffer = Buffer


const MIGRATION_KEY = 'h173k_mainnet_migration_v1'
if (!localStorage.getItem(MIGRATION_KEY)) {
  // Wyczyść stare dane devnet
  localStorage.removeItem('h173k_offers_cache')
  localStorage.removeItem('h173k_last_sync')
  localStorage.setItem(MIGRATION_KEY, 'true')
  console.log('🔄 Cleared devnet cache for mainnet migration')
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
