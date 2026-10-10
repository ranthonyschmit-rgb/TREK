import { useCallback, useEffect, useState } from 'react'
import type { AssistantMessage, AssistantModelId, AssistantModelOption } from '@trek/shared'
import { assistantApi } from '../../api/assistant'
import { addListener, removeListener } from '../../api/websocket'
import { getApiErrorMessage } from '../../utils/apiError'

const MODEL_PREF_KEY = 'trek_assistant_model'

function readModelPref(): AssistantModelId | null {
  try {
    const v = localStorage.getItem(MODEL_PREF_KEY)
    return v === 'sonnet' || v === 'haiku' || v === 'gemini' ? v : null
  } catch {
    return null
  }
}

function writeModelPref(id: AssistantModelId): void {
  try { localStorage.setItem(MODEL_PREF_KEY, id) } catch { /* private mode — just don't remember */ }
}

function upsert(list: AssistantMessage[], msg: AssistantMessage): AssistantMessage[] {
  if (list.some(m => m.id === msg.id)) return list
  return [...list, msg].sort((a, b) => a.id - b.id)
}

/** The question being asked right now, shown before the server has stored it. */
export interface PendingQuestion { text: string; model: AssistantModelId }

/**
 * State + actions for the Collab-page trip assistant (fork addition).
 * Online-only by design. Messages arrive from the initial load, from this
 * tab's own send, and from other travelers via the WebSocket; all three are
 * merged by id so nothing shows twice.
 */
export function useTripAssistant(tripId: number) {
  const [messages, setMessages] = useState<AssistantMessage[]>([])
  const [models, setModels] = useState<AssistantModelOption[]>([])
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState<PendingQuestion | null>(null)
  const [model, setModelState] = useState<AssistantModelId | null>(readModelPref)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([assistantApi.getMessages(tripId), assistantApi.getConfig(tripId)])
      .then(([msgs, cfg]) => {
        if (cancelled) return
        setMessages(msgs.messages)
        setModels(cfg.models)
      })
      .catch(() => {
        if (!cancelled) { setMessages([]); setModels([]) }
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [tripId])

  useEffect(() => {
    const handler = (msg: Record<string, unknown>) => {
      if (String(msg?.tripId) !== String(tripId)) return
      if (msg.type === 'assistant:message:created' && msg.message) {
        setMessages(prev => upsert(prev, msg.message as AssistantMessage))
      }
      if (msg.type === 'assistant:cleared') setMessages([])
    }
    addListener(handler)
    return () => removeListener(handler)
  }, [tripId])

  // The picked model, falling back to the first one the server can run.
  const available = models.filter(m => m.available)
  const activeModel: AssistantModelId | null =
    model && available.some(m => m.id === model) ? model : (available[0]?.id ?? null)

  const setModel = useCallback((id: AssistantModelId) => {
    setModelState(id)
    writeModelPref(id)
  }, [])

  /** Ask a question. Resolves to an error message, or null on success. */
  const send = useCallback(async (text: string): Promise<string | null> => {
    const trimmed = text.trim()
    if (!trimmed || !activeModel) return null
    setPending({ text: trimmed, model: activeModel })
    try {
      const res = await assistantApi.send(tripId, { text: trimmed, model: activeModel })
      setMessages(prev => upsert(upsert(prev, res.question), res.answer))
      return null
    } catch (err) {
      return getApiErrorMessage(err, '')
    } finally {
      setPending(null)
    }
  }, [tripId, activeModel])

  const clear = useCallback(async (): Promise<boolean> => {
    try {
      await assistantApi.clear(tripId)
      setMessages([])
      return true
    } catch {
      return false
    }
  }, [tripId])

  return { messages, models, loading, pending, activeModel, setModel, send, clear }
}
