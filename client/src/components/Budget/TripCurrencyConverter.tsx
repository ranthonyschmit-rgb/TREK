import { useState, type CSSProperties } from 'react'
import { ArrowRightLeft, X } from 'lucide-react'
import { TRIP_HOME_CURRENCY } from '@trek/shared'
import { useTranslation } from '../../i18n'
import CustomSelect from '../shared/CustomSelect'
import { CURRENCIES } from './BudgetPanel.constants'
import { useTripCurrencies } from './useTripCurrencies'

const bodyText = { fontSize: 'calc(13px * var(--fs-scale-body, 1))' } as const
const smallText = { fontSize: 'calc(11.5px * var(--fs-scale-caption, 1))' } as const

function formatAmount(value: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: value >= 1000 ? 0 : 2 }).format(value)
  } catch {
    return `${value.toFixed(2)} ${currency}`
  }
}

/**
 * Per-trip currency converter (fork addition). Always converts from USD into
 * the currencies of the trip's destinations, plus any picked by hand.
 */
export default function TripCurrencyConverter({ tripId, className, style }: { tripId: number; className?: string; style?: CSSProperties }) {
  const { t, locale } = useTranslation()
  const { info, rates, codes, extra, setExtra } = useTripCurrencies(tripId)
  const [amount, setAmount] = useState('100')
  const usd = Number.parseFloat(amount.replace(',', '.')) || 0

  const pickable = (rates ? Object.keys(rates) : CURRENCIES)
    .filter((c) => c !== TRIP_HOME_CURRENCY && !codes.includes(c))
    .sort()
    .map((c) => ({ value: c, label: c }))

  const empty = codes.length === 0
  const emptyNote = !info || !info.hasDestinations ? t('tripFx.noDestinations') : t('tripFx.domestic')

  return (
    <div className={`bg-surface-card border border-edge-faint ${className ?? ''}`} style={{ borderRadius: 22, padding: '20px 22px', ...style }}>
      <div className="flex items-center gap-2 text-content-muted" style={{ ...smallText, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 12 }}>
        <ArrowRightLeft size={13} /> {t('tripFx.title')}
      </div>

      <label className="flex items-center gap-2 bg-surface-input border border-edge" style={{ borderRadius: 12, padding: '8px 12px' }}>
        <span className="text-content-muted" style={{ ...smallText, fontWeight: 600 }}>{TRIP_HOME_CURRENCY}</span>
        <input
          className="flex-1 bg-transparent border-0 outline-none text-content"
          style={{ ...bodyText, fontWeight: 600, fontFamily: 'inherit', minWidth: 0 }}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          aria-label={`${t('tripFx.from')} ${TRIP_HOME_CURRENCY}`}
        />
      </label>

      {empty ? (
        <div className="text-content-muted" style={{ ...smallText, marginTop: 10, lineHeight: 1.45 }}>{emptyNote}</div>
      ) : (
        <div className="flex flex-col" style={{ gap: 8, marginTop: 12 }}>
          {codes.map((code) => {
            const rate = rates?.[code]
            const isExtra = extra.includes(code)
            const countries = info?.currencies.find((c) => c.code === code)?.countries ?? []
            return (
              <div key={code} className="flex items-center gap-3 bg-surface-secondary" style={{ borderRadius: 12, padding: '9px 12px' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="text-content" style={{ ...bodyText, fontWeight: 700 }}>
                    {rate != null ? formatAmount(usd * rate, code, locale) : `— ${code}`}
                  </div>
                  <div className="text-content-faint" style={smallText}>
                    {rate != null ? t('tripFx.rate', { from: TRIP_HOME_CURRENCY, rate: rate.toFixed(rate < 10 ? 4 : 2), to: code }) : t('tripFx.rateUnavailable')}
                    {countries.length > 0 ? ` · ${countries.join(', ')}` : ''}
                  </div>
                </div>
                {isExtra && (
                  <button
                    type="button"
                    onClick={() => setExtra(extra.filter((c) => c !== code))}
                    className="text-content-faint hover:text-content bg-transparent border-0 cursor-pointer"
                    aria-label={`Remove ${code}`}
                    style={{ padding: 4, display: 'inline-flex' }}
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}

      <div style={{ marginTop: 10 }}>
        <CustomSelect
          value=""
          onChange={(v) => { const c = String(v); if (c && !extra.includes(c)) setExtra([...extra, c]) }}
          options={pickable}
          placeholder={t('tripFx.other')}
          searchable
          size="sm"
        />
      </div>
    </div>
  )
}
