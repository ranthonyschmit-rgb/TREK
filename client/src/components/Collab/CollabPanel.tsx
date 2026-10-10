import { useState, useEffect, useMemo } from 'react'
import { useAuthStore } from '../../store/authStore'
import { useTranslation } from '../../i18n'
import { MessageCircle, StickyNote, Link2, Bot } from 'lucide-react'
import CollabChat from './CollabChat'
import CollabNotes from './CollabNotes'
import TripAssistant from './TripAssistant'
import CollabLinks from './CollabLinks'

function useIsDesktop(breakpoint = 1024) {
  const [isDesktop, setIsDesktop] = useState(window.innerWidth >= breakpoint)
  useEffect(() => {
    const check = () => setIsDesktop(window.innerWidth >= breakpoint)
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [breakpoint])
  return isDesktop
}

const cardClass = 'flex flex-col bg-surface-card rounded-2xl border border-edge-faint overflow-hidden min-h-0'

interface TripMember {
  id: number
  username: string
  avatar_url?: string | null
}

interface CollabFeatures {
  chat: boolean
  notes: boolean
  links?: boolean
  polls: boolean
  whatsnext: boolean
}

interface CollabPanelProps {
  tripId: number
  tripMembers?: TripMember[]
  collabFeatures?: CollabFeatures
}

const ALL_TABS = [
  { id: 'chat', featureKey: 'chat' as const, labelKey: 'collab.tabs.chat', fallback: 'Chat', icon: MessageCircle },
  { id: 'notes', featureKey: 'notes' as const, labelKey: 'collab.tabs.notes', fallback: 'Notes', icon: StickyNote },
  { id: 'links', featureKey: 'links' as const, labelKey: 'collab.tabs.links', fallback: 'Links', icon: Link2 },
  // Fork: the 'polls' slot (and its admin toggle) now holds the AI trip assistant.
  { id: 'polls', featureKey: 'polls' as const, labelKey: 'collab.tabs.polls', fallback: 'Assistant', icon: Bot },
]

export default function CollabPanel({ tripId, collabFeatures }: CollabPanelProps) {
  const { user } = useAuthStore()
  const { t } = useTranslation()
  const isDesktop = useIsDesktop()

  // Older server/admin configs predate the Links feature; merge defaults so a
  // missing `links` key does not silently hide the new panel.
  const features = { chat: true, notes: true, links: true, polls: true, whatsnext: true, ...(collabFeatures || {}) }

  const tabs = useMemo(() =>
    ALL_TABS.filter(tab => features[tab.featureKey]).map(tab => ({
      ...tab,
      label: t(tab.labelKey) || tab.fallback,
    })),
  [features, t])

  const [mobileTab, setMobileTab] = useState(() => tabs[0]?.id || 'chat')

  // If active tab gets disabled, switch to first available
  useEffect(() => {
    if (tabs.length > 0 && !tabs.some(t => t.id === mobileTab)) {
      setMobileTab(tabs[0].id)
    }
  }, [tabs, mobileTab])

  // Fork layout (desktop): three full-height columns — chat 20%, notes and
  // links sharing one box 40%, trip assistant 40%. What's Next is dropped.
  // A column whose feature is off is left out and the rest share its space.
  const writtenOn = features.notes || features.links
  const columns = [
    features.chat && { id: 'chat', flex: 2 },
    writtenOn && { id: 'written', flex: 4 },
    features.polls && { id: 'assistant', flex: 4 },
  ].filter(Boolean) as { id: string; flex: number }[]

  const renderColumn = (id: string) => {
    if (id === 'chat') return <CollabChat tripId={tripId} currentUser={user} />
    if (id === 'assistant') return <TripAssistant tripId={tripId} currentUser={user} />
    // Notes and links in one box: links sized to their content (capped, scrolls
    // on its own), notes fill the rest.
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        {features.links && (
          <div style={{ flex: features.notes ? '0 1 auto' : 1, maxHeight: features.notes ? '38%' : undefined, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <CollabLinks tripId={tripId} compact={features.notes} />
          </div>
        )}
        {features.links && features.notes && <div className="border-t border-edge-faint" style={{ margin: '0 12px' }} />}
        {features.notes && (
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <CollabNotes tripId={tripId} currentUser={user} />
          </div>
        )}
      </div>
    )
  }

  if (tabs.length === 0) return null

  if (isDesktop) {
    if (columns.length === 0) return null
    return (
      <div style={{ height: '100%', display: 'flex', gap: 12, padding: 12, overflow: 'hidden', minHeight: 0 }}>
        {columns.map(c => (
          <div key={c.id} className={cardClass} style={{ flex: `${c.flex} 1 0`, minWidth: c.id === 'chat' ? 280 : 0 }}>
            {renderColumn(c.id)}
          </div>
        ))}
      </div>
    )
  }

  // Mobile: tab bar + single panel (only enabled tabs)
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'absolute', inset: 0 }}>
      <div style={{
        display: 'flex', gap: 2, padding: '8px 12px', borderBottom: '1px solid var(--border-faint)',
        background: 'var(--bg-card)', flexShrink: 0,
      }}>
        {tabs.map(tab => {
          const active = mobileTab === tab.id
          return (
            <button key={tab.id} onClick={() => setMobileTab(tab.id)} style={{
              flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              padding: '8px 0', borderRadius: 10, border: 'none', cursor: 'pointer',
              background: active ? 'var(--accent)' : 'transparent',
              color: active ? 'var(--accent-text)' : 'var(--text-muted)',
              fontSize: 'calc(11px * var(--fs-scale-caption, 1))', fontWeight: 600, fontFamily: 'inherit',
              transition: 'all 0.15s',
            }}>
              {tab.label}
            </button>
          )
        })}
      </div>

      <div style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
        {mobileTab === 'chat' && features.chat && <CollabChat tripId={tripId} currentUser={user} />}
        {mobileTab === 'notes' && features.notes && <CollabNotes tripId={tripId} currentUser={user} />}
        {mobileTab === 'links' && features.links && <CollabLinks tripId={tripId} />}
        {mobileTab === 'polls' && features.polls && <TripAssistant tripId={tripId} currentUser={user} />}
      </div>
    </div>
  )
}
