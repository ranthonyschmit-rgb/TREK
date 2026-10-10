import { useCallback, useEffect, useState } from 'react'
import { TRIP_HOME_CURRENCY, type TripCurrenciesResponse } from '@trek/shared'
import { assistantApi } from '../../api/assistant'
import { fetchExchangeRates } from '../../hooks/useExchangeRates'
import { useTripStore } from '../../store/tripStore'

const extraKey = (tripId: number) => `trek_trip_fx_extra_${tripId}`

function readExtra(tripId: number): string[] {
  try {
    const raw = localStorage.getItem(extraKey(tripId))
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === 'string' && /^[A-Z]{3}$/.test(c)) : []
  } catch {
    return []
  }
}

function writeExtra(tripId: number, codes: string[]): void {
  try { localStorage.setItem(extraKey(tripId), JSON.stringify(codes)) } catch { /* private mode — not remembered */ }
}

/**
 * Data for the per-trip currency converter (fork addition): the currencies of
 * the trip's destinations (derived on the server from its places), any extra
 * currencies picked by hand on this device, and live USD-based rates.
 */
export function useTripCurrencies(tripId: number) {
  // Re-derive when places are added or removed.
  const placeCount = useTripStore((s) => s.places.length)
  const [info, setInfo] = useState<TripCurrenciesResponse | null>(null)
  const [rates, setRates] = useState<Record<string, number> | null>(null)
  const [extra, setExtraState] = useState<string[]>(() => readExtra(tripId))

  useEffect(() => { setExtraState(readExtra(tripId)) }, [tripId])

  useEffect(() => {
    let cancelled = false
    assistantApi.getCurrencies(tripId)
      .then((d) => { if (!cancelled) setInfo(d) })
      .catch(() => { if (!cancelled) setInfo(null) })
    return () => { cancelled = true }
  }, [tripId, placeCount])

  const loadRates = useCallback(() => {
    let cancelled = false
    fetchExchangeRates(TRIP_HOME_CURRENCY).then((r) => { if (!cancelled) setRates(r) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => loadRates(), [loadRates])

  const setExtra = useCallback((codes: string[]) => {
    setExtraState(codes)
    writeExtra(tripId, codes)
  }, [tripId])

  const destinationCodes = info?.currencies.map((c) => c.code) ?? []
  const codes = [...destinationCodes, ...extra.filter((c) => !destinationCodes.includes(c) && c !== TRIP_HOME_CURRENCY)]

  return { info, rates, codes, extra, setExtra, refreshRates: loadRates }
}
