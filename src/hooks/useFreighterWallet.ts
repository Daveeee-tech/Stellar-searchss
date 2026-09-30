/**
 * useFreighterWallet.ts
 * Real Freighter wallet integration using @stellar/freighter-api
 * Fetches live balances from Stellar Horizon
 */

import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import {
  isConnected,
  requestAccess,
  getAddress,
  getNetwork,
} from '@stellar/freighter-api'
import { Horizon } from '@stellar/stellar-sdk'
import { getHorizonUrl, getUsdcIssuer } from '../lib/stellar'

export interface WalletState {
  publicKey: string | null
  connected: boolean
  network: string
  xlmBalance: string
  usdcBalance: string
  loading: boolean
  error: string | null
}

export interface StellarTransaction {
  id: string
  hash: string
  type: string
  amount: string
  asset: string
  from: string
  to: string
  timestamp: string
  memo?: string
}

export function useFreighterWallet() {
  const [wallet, setWallet] = useState<WalletState>({
    publicKey: null,
    connected: false,
    network: 'TESTNET',
    xlmBalance: '0',
    usdcBalance: '0',
    loading: false,
    error: null,
  })
  const [transactions, setTransactions] = useState<StellarTransaction[]>([])
  const [txLoading, setTxLoading] = useState(false)
  const requestId = useRef(0)
  const activeWallet = useRef({ publicKey: wallet.publicKey, network: wallet.network })
  activeWallet.current = { publicKey: wallet.publicKey, network: wallet.network }
  const horizon = useMemo(
    () => new Horizon.Server(getHorizonUrl(wallet.network)),
    [wallet.network]
  )
  const usdcIssuer = getUsdcIssuer(wallet.network)

  // Fetch real balances from Horizon
  const fetchBalances = useCallback(async (publicKey: string, fetchId: number) => {
    try {
      const account = await horizon.loadAccount(publicKey)

      let xlm = '0'
      let usdc = '0'

      for (const balance of account.balances) {
        if (balance.asset_type === 'native') {
          xlm = parseFloat(balance.balance).toFixed(4)
        } else if (
          balance.asset_type === 'credit_alphanum4' &&
          (balance as any).asset_code === 'USDC' &&
          (balance as any).asset_issuer === usdcIssuer
        ) {
          usdc = parseFloat(balance.balance).toFixed(6)
        }
      }

      if (
        requestId.current === fetchId &&
        activeWallet.current.publicKey === publicKey &&
        activeWallet.current.network === wallet.network
      ) {
        setWallet(prev => prev.network === wallet.network && prev.publicKey === publicKey
          ? { ...prev, xlmBalance: xlm, usdcBalance: usdc, error: null }
          : prev)
      }
    } catch (err: any) {
      if (
        requestId.current === fetchId &&
        activeWallet.current.publicKey === publicKey &&
        activeWallet.current.network === wallet.network
      ) {
        setWallet(prev => prev.network === wallet.network && prev.publicKey === publicKey
          ? { ...prev, error: err.message || 'Failed to load account' }
          : prev)
      }
    }
  }, [horizon, usdcIssuer, wallet.network])

  // Fetch real transaction history from Horizon
  const fetchTransactions = useCallback(async (publicKey: string, fetchId: number) => {
    setTxLoading(true)
    try {
      const ops = await horizon
        .operations()
        .forAccount(publicKey)
        .order('desc')
        .limit(15)
        .call()

      const txs: StellarTransaction[] = ops.records
        .filter((op: any) => op.type === 'payment' || op.type === 'create_account')
        .map((op: any) => ({
          id: op.id,
          hash: op.transaction_hash,
          type: op.type,
          amount: op.amount ? parseFloat(op.amount).toFixed(4) : '—',
          asset:
            op.asset_type === 'native'
              ? 'XLM'
              : op.asset_code || 'Unknown',
          from: op.from || op.funder || '',
          to: op.to || op.account || '',
          timestamp: op.created_at,
          memo: op.transaction?.memo,
        }))

      if (
        requestId.current === fetchId &&
        activeWallet.current.publicKey === publicKey &&
        activeWallet.current.network === wallet.network
      ) setTransactions(txs)
    } catch (_) {
      if (
        requestId.current === fetchId &&
        activeWallet.current.publicKey === publicKey &&
        activeWallet.current.network === wallet.network
      ) setTransactions([])
    } finally {
      if (
        requestId.current === fetchId &&
        activeWallet.current.publicKey === publicKey &&
        activeWallet.current.network === wallet.network
      ) setTxLoading(false)
    }
  }, [horizon])

  // Connect Freighter wallet
  const connect = useCallback(async () => {
    setWallet(prev => ({ ...prev, loading: true, error: null }))

    try {
      const connected = await isConnected()
      if (!connected.isConnected) {
        throw new Error(
          'Freighter extension not found. Install it from freighter.app'
        )
      }

      const accessResult = await requestAccess()
      if (accessResult.error) {
        throw new Error(accessResult.error.message)
      }

      const addressResult = await getAddress()
      if (addressResult.error || !addressResult.address) {
        throw new Error('Could not get wallet address')
      }

      const networkResult = await getNetwork()
      const network = networkResult.network || 'TESTNET'

      setWallet(prev => ({
        ...prev,
        publicKey: addressResult.address,
        connected: true,
        network,
        loading: false,
        error: null,
      }))

    } catch (err: any) {
      setWallet(prev => ({
        ...prev,
        loading: false,
        connected: false,
        error: err.message || 'Connection failed',
      }))
    }
  }, [])

  const disconnect = useCallback(() => {
    requestId.current += 1
    setWallet({
      publicKey: null,
      connected: false,
      network: 'TESTNET',
      xlmBalance: '0',
      usdcBalance: '0',
      loading: false,
      error: null,
    })
    setTransactions([])
  }, [])

  const refresh = useCallback(async () => {
    if (wallet.publicKey) {
      const networkResult = await getNetwork()
      const network = networkResult.network || wallet.network
      if (network !== wallet.network) {
        setWallet(prev => ({ ...prev, network }))
        return
      }
      const fetchId = ++requestId.current
      await Promise.all([
        fetchBalances(wallet.publicKey, fetchId),
        fetchTransactions(wallet.publicKey, fetchId),
      ])
    }
  }, [wallet.publicKey, wallet.network, fetchBalances, fetchTransactions])

  // Re-fetch on account/network changes, discarding any previous network's data.
  useEffect(() => {
    const fetchId = ++requestId.current
    setWallet(prev => ({ ...prev, xlmBalance: '0', usdcBalance: '0', error: null }))
    setTransactions([])

    if (wallet.publicKey) {
      fetchBalances(wallet.publicKey, fetchId)
      fetchTransactions(wallet.publicKey, fetchId)
    } else {
      setTxLoading(false)
    }
  }, [wallet.publicKey, wallet.network, fetchBalances, fetchTransactions])

  // Freighter does not expose a network-change event, so observe its active network.
  useEffect(() => {
    if (!wallet.connected) return

    let cancelled = false
    const syncNetwork = async () => {
      try {
        const result = await getNetwork()
        if (!cancelled && result.network && result.network !== wallet.network) {
          setWallet(prev => ({ ...prev, network: result.network! }))
        }
      } catch {
        // Ignore transient Freighter availability errors.
      }
    }

    const interval = window.setInterval(syncNetwork, 5000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [wallet.connected, wallet.network])

  // Auto-check if already connected on mount
  useEffect(() => {
    const check = async () => {
      try {
        const connected = await isConnected()
        if (connected.isConnected) {
          const addr = await getAddress()
          if (addr.address) {
            const net = await getNetwork()
            setWallet(prev => ({
              ...prev,
              publicKey: addr.address,
              connected: true,
              network: net.network || 'TESTNET',
            }))
          }
        }
      } catch {
        // Freighter not installed, silent fail
      }
    }
    check()
  }, [])

  return {
    wallet,
    transactions,
    txLoading,
    connect,
    disconnect,
    refresh,
  }
}
