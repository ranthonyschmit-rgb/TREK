import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Sparkles, Send, Trash2, MapPin, StickyNote, Check, AlertCircle } from 'lucide-react'
import { ASSISTANT_MAX_INPUT_CHARS, type AssistantMessage, type AssistantSuggestion } from '@trek/shared'
import { sanitizedMarkdownComponents, sanitizedMarkdownPlugins } from '../shared/markdownSanitize'
import { useTranslation } from '../../i18n'
import { useToast } from '../shared/Toast'
import { useCanDo } from '../../store/permissionsStore'
import { useTripStore } from '../../store/tripStore'
import { assistantApi } from '../../api/assistant'
import CustomSelect from '../shared/CustomSelect'
import ConfirmDialog from '../shared/ConfirmDialog'
import { useTripAssistant } from './useTripAssistant'
import type { User } from '../../types'

// Block styling for markdown answers. Sizes in em so the user's text-size
// setting keeps working (same approach as the poll questions used).
const answerMarkdown: Components = {
  ...sanitizedMarkdownComponents,
  p: ({ children }) => <p style={{ margin: '0 0 0.6em' }}>{children}</p>,
  h1: ({ children }) => <h3 style={{ margin: '0.4em 0 0.4em', fontSize: '1.15em', fontWeight: 700 }}>{children}</h3>,
  h2: ({ children }) => <h3 style={{ margin: '0.4em 0 0.4em', fontSize: '1.1em', fontWeight: 700 }}>{children}</h3>,
  h3: ({ children }) => <h4 style={{ margin: '0.4em 0 0.35em', fontSize: '1.05em', fontWeight: 700 }}>{children}</h4>,
  ul: ({ children }) => <ul style={{ margin: '0 0 0.6em', paddingLeft: 20, listStyle: 'disc' }}>{children}</ul>,
  ol: ({ children }) => <ol style={{ margin: '0 0 0.6em', paddingLeft: 20, listStyle: 'decimal' }}>{children}</ol>,
  li: ({ children }) => <li style={{ margin: '0.15em 0' }}>{children}</li>,
}

const bodyText = { fontSize: 'calc(13px * var(--fs-scale-body, 1))', lineHeight: 1.5 } as const
const smallText = { fontSize: 'calc(11.5px * var(--fs-scale-caption, 1))' } as const

function clipTitle(text: string, max = 80): string {
  const s = text.replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

interface TripAssistantProps {
  tripId: number
  currentUser: User | null
}

export default function TripAssistant({ tripId, currentUser }: TripAssistantProps) {
  const { t } = useTranslation()
  const toast = useToast()
  const can = useCanDo()
  const trip = useTripStore((s) => s.trip)
  const addPlace = useTripStore((s) => s.addPlace)
  const canAsk = can('collab_edit', trip)
  const { messages, models, loading, pending, activeModel, setModel, send, clear } = useTripAssistant(tripId)
  const [draft, setDraft] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)
  const [added, setAdded] = useState<Set<string>>(() => new Set())
  const [savedNotes, setSavedNotes] = useState<Set<number>>(() => new Set())
  const scrollRef = useRef<HTMLDivElement>(null)

  const anyAvailable = models.some((m) => m.available)

  // Keep the newest message in view.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, pending])

  const submit = async () => {
    const text = draft.trim()
    if (!text || pending || !activeModel) return
    setDraft('')
    const error = await send(text)
    if (error !== null) {
      setDraft(text)
      toast.error(error || t('assistant.error'))
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submit()
    }
  }

  const questionBefore = (answer: AssistantMessage): AssistantMessage | undefined =>
    [...messages].reverse().find((m) => m.role === 'user' && m.id < answer.id)

  const saveNote = async (answer: AssistantMessage) => {
    const q = questionBefore(answer)
    try {
      await assistantApi.saveAsNote(tripId, {
        title: clipTitle(q ? `AI: ${q.content}` : t('assistant.title')),
        content: answer.content,
        category: 'AI ideas',
      })
      setSavedNotes((prev) => new Set(prev).add(answer.id))
      toast.success(t('assistant.noteSaved'))
    } catch {
      toast.error(t('common.error'))
    }
  }

  const addSuggestion = async (s: AssistantSuggestion) => {
    try {
      await addPlace(tripId, { name: s.name, description: s.description ?? null })
      setAdded((prev) => new Set(prev).add(s.name))
      toast.success(t('assistant.addedToPlan', { name: s.name }))
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : t('common.error'))
    }
  }

  const modelOptions = models.map((m) => ({
    value: m.id,
    label: m.available ? `${m.name} · ${m.tag}` : `${m.name} · ${t('assistant.modelUnavailable')}`,
  }))

  const pendingLabel = models.find((m) => m.id === pending?.model)?.name

  return (
    <div className="flex flex-col h-full min-h-0" style={{ fontFamily: 'var(--font-system)' }}>
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-edge-faint" style={{ padding: '10px 14px', flexWrap: 'wrap' }}>
        <Sparkles size={15} className="text-content-muted" />
        <span className="text-content-secondary" style={{ ...smallText, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
          {t('assistant.title')}
        </span>
        <div className="flex items-center gap-2" style={{ marginLeft: 'auto' }}>
          {models.length > 0 && (
            <div style={{ minWidth: 220 }} title={t('assistant.model')}>
              <CustomSelect
                value={activeModel ?? ''}
                onChange={(v) => {
                  const id = String(v)
                  if (id === 'sonnet' || id === 'haiku' || id === 'gemini') setModel(id)
                }}
                options={modelOptions}
                size="sm"
                disabled={!anyAvailable || !!pending}
              />
            </div>
          )}
          {canAsk && messages.length > 0 && (
            <button
              type="button"
              onClick={() => setConfirmClear(true)}
              className="text-content-muted hover:text-content bg-transparent border-0 cursor-pointer"
              aria-label={t('assistant.clear')}
              title={t('assistant.clear')}
              style={{ padding: 6, borderRadius: 8, display: 'inline-flex' }}
            >
              <Trash2 size={15} />
            </button>
          )}
        </div>
      </div>

      {/* Conversation */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto" style={{ padding: '14px 14px 6px' }}>
        {!loading && messages.length === 0 && !pending && (
          <div className="text-center text-content-muted" style={{ padding: '28px 12px', ...bodyText }}>
            <Sparkles size={26} className="text-content-faint" style={{ margin: '0 auto 10px' }} />
            <div className="text-content" style={{ fontWeight: 600, marginBottom: 6 }}>{t('assistant.emptyTitle')}</div>
            <div>{anyAvailable ? t('assistant.examples') : t('assistant.notConfigured')}</div>
            <div className="text-content-faint" style={{ ...smallText, marginTop: 10 }}>{t('assistant.subtitle')}</div>
          </div>
        )}

        <div className="flex flex-col" style={{ gap: 12 }}>
          {messages.map((m) => m.role === 'user' ? (
            <div key={m.id} className="flex flex-col items-end">
              <div className="text-content-faint" style={{ ...smallText, marginBottom: 3 }}>
                {m.user_id === currentUser?.id ? t('assistant.you') : (m.username ?? '—')}
              </div>
              <div className="bg-accent text-accent-text" style={{ ...bodyText, padding: '8px 12px', borderRadius: 14, borderBottomRightRadius: 4, maxWidth: '85%', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {m.content}
              </div>
            </div>
          ) : (
            <div key={m.id} className="flex flex-col items-start">
              <div className="text-content-faint flex items-center gap-1" style={{ ...smallText, marginBottom: 3 }}>
                <Sparkles size={11} /> {models.find((x) => x.id === m.model)?.name ?? t('assistant.title')}
              </div>
              <div
                className={m.is_error ? 'bg-danger-soft text-content border border-edge-faint' : 'bg-surface-secondary text-content border border-edge-faint'}
                style={{ ...bodyText, padding: '10px 12px', borderRadius: 14, borderBottomLeftRadius: 4, maxWidth: '95%', overflowWrap: 'anywhere' }}
              >
                {m.is_error ? (
                  <span className="flex items-start gap-2"><AlertCircle size={15} className="text-danger" style={{ flexShrink: 0, marginTop: 2 }} />{m.content}</span>
                ) : (
                  <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={sanitizedMarkdownPlugins} components={answerMarkdown}>
                    {m.content}
                  </ReactMarkdown>
                )}

                {!m.is_error && m.suggestions.length > 0 && (
                  <div className="border-t border-edge-faint" style={{ marginTop: 8, paddingTop: 8 }}>
                    <div className="text-content-muted" style={{ ...smallText, fontWeight: 600, marginBottom: 6 }}>{t('assistant.suggestions')}</div>
                    <div className="flex flex-col" style={{ gap: 6 }}>
                      {m.suggestions.map((s) => {
                        const done = added.has(s.name)
                        return (
                          <div key={s.name} className="flex items-center gap-2 bg-surface-card border border-edge-faint" style={{ padding: '6px 8px', borderRadius: 10 }}>
                            <MapPin size={13} className="text-content-muted" style={{ flexShrink: 0 }} />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div className="text-content" style={{ ...smallText, fontWeight: 600 }}>{s.name}</div>
                              {s.description && <div className="text-content-muted" style={smallText}>{s.description}</div>}
                            </div>
                            {canAsk && (
                              <button
                                type="button"
                                disabled={done}
                                onClick={() => { void addSuggestion(s) }}
                                className={done ? 'text-content-muted bg-transparent border border-edge-faint' : 'bg-accent text-accent-text border-0 cursor-pointer'}
                                style={{ ...smallText, fontWeight: 600, padding: '4px 9px', borderRadius: 8, whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                              >
                                {done ? <Check size={12} /> : null}{t('assistant.addToPlan')}
                              </button>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
              {!m.is_error && canAsk && (
                <button
                  type="button"
                  disabled={savedNotes.has(m.id)}
                  onClick={() => { void saveNote(m) }}
                  className="text-content-muted hover:text-content bg-transparent border-0 cursor-pointer flex items-center gap-1"
                  style={{ ...smallText, padding: '4px 2px', marginTop: 2 }}
                >
                  {savedNotes.has(m.id) ? <Check size={12} /> : <StickyNote size={12} />}
                  {savedNotes.has(m.id) ? t('assistant.noteSaved') : t('assistant.saveNote')}
                </button>
              )}
            </div>
          ))}

          {pending && (
            <>
              <div className="flex flex-col items-end">
                <div className="text-content-faint" style={{ ...smallText, marginBottom: 3 }}>{t('assistant.you')}</div>
                <div className="bg-accent text-accent-text" style={{ ...bodyText, padding: '8px 12px', borderRadius: 14, borderBottomRightRadius: 4, maxWidth: '85%', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', opacity: 0.85 }}>
                  {pending.text}
                </div>
              </div>
              <div className="flex items-center gap-2 text-content-muted" style={bodyText}>
                <Sparkles size={14} className="animate-pulse" />
                {pendingLabel ? `${pendingLabel} · ` : ''}{t('assistant.thinking')}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Composer */}
      {canAsk ? (
        <div className="border-t border-edge-faint flex items-end gap-2" style={{ padding: 10 }}>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value.slice(0, ASSISTANT_MAX_INPUT_CHARS))}
            onKeyDown={onKeyDown}
            placeholder={t('assistant.placeholder')}
            disabled={!anyAvailable}
            rows={2}
            className="flex-1 bg-surface-input text-content border border-edge rounded-xl resize-none outline-none"
            style={{ ...bodyText, padding: '8px 10px', fontFamily: 'inherit', maxHeight: 140 }}
          />
          <button
            type="button"
            onClick={() => { void submit() }}
            disabled={!draft.trim() || !!pending || !activeModel}
            aria-label={t('assistant.send')}
            title={t('assistant.send')}
            className="bg-accent text-accent-text border-0 cursor-pointer disabled:opacity-40 disabled:cursor-default"
            style={{ width: 38, height: 38, borderRadius: 12, display: 'grid', placeItems: 'center', flexShrink: 0 }}
          >
            <Send size={16} />
          </button>
        </div>
      ) : (
        <div className="border-t border-edge-faint text-content-muted" style={{ padding: 12, ...smallText }}>{t('assistant.readOnly')}</div>
      )}

      <ConfirmDialog
        isOpen={confirmClear}
        onClose={() => setConfirmClear(false)}
        onConfirm={async () => {
          setConfirmClear(false)
          if (!(await clear())) toast.error(t('common.error'))
        }}
        title={t('assistant.confirmClearTitle')}
        message={t('assistant.confirmClearBody')}
        confirmLabel={t('assistant.clear')}
      />
    </div>
  )
}
