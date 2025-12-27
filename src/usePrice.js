import { useState, useEffect, useCallback, useRef } from 'react'
import { PRICE_UPDATE_INTERVAL } from './constants'

const POOL_ADDRESS = 'J9ED7D3pR7Uw5W6Y52p1Mq3Gfkmumg8fHRvLEiHLL2S7'

export function useTokenPrice() {
  const [price, setPrice] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastUpdated, setLastUpdated] = useState(null)
  const intervalRef = useRef(null)

  const fetchPrice = useCallback(async () => {
    try {
      const response = await fetch(
        `https://api.geckoterminal.com/api/v2/networks/solana/pools/${POOL_ADDRESS}`,
        { headers: { 'Accept': 'application/json' } }
      )

      if (!response.ok) {
        if (response.status === 429) {
          console.warn('GeckoTerminal rate limited, will retry later')
          return
        }
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      const data = await response.json()
      const tokenPrice = parseFloat(data?.data?.attributes?.base_token_price_usd)

      if (tokenPrice && !isNaN(tokenPrice)) {
        setPrice(tokenPrice)
        setLastUpdated(new Date())
        setError(null)
      } else {
        setPrice(null)
        setError('Price unavailable')
      }
    } catch (err) {
      console.error('Error fetching price:', err)
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchPrice()
    intervalRef.current = setInterval(fetchPrice, PRICE_UPDATE_INTERVAL)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [fetchPrice])

  const toUSD = useCallback((tokenAmount) => {
    if (price === null || tokenAmount === null || tokenAmount === undefined) return null
    return tokenAmount * price
  }, [price])

  return { price, loading, error, lastUpdated, toUSD, refetch: fetchPrice }
}

export function formatLastUpdated(date) {
  if (!date) return ''
  const now = new Date()
  const diff = Math.floor((now - date) / 1000)
  if (diff < 60) return 'just now'
  if (diff < 120) return '1 min ago'
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`
  return date.toLocaleTimeString()
}