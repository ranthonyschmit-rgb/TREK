import apiClient from './client'
import type {
  AssistantConfigResponse,
  AssistantMessagesResponse,
  AssistantSendRequest,
  AssistantSendResponse,
  CollabNoteCreateRequest,
  TripCurrenciesResponse,
} from '@trek/shared'

/**
 * Fork addition: the Collab-page AI trip assistant and the per-trip currency
 * lookup. Deliberately online-only — a model call can't be queued offline and
 * replayed later, and the currency list is derived on the server from the
 * trip's places.
 */
export const assistantApi = {
  getConfig: (tripId: number | string): Promise<AssistantConfigResponse> =>
    apiClient.get(`/trips/${tripId}/assistant/config`).then(r => r.data),
  getMessages: (tripId: number | string): Promise<AssistantMessagesResponse> =>
    apiClient.get(`/trips/${tripId}/assistant/messages`).then(r => r.data),
  // Model calls can take a while; give them longer than the default timeout.
  send: (tripId: number | string, data: AssistantSendRequest): Promise<AssistantSendResponse> =>
    apiClient.post(`/trips/${tripId}/assistant/messages`, data, { timeout: 150_000 }).then(r => r.data),
  clear: (tripId: number | string): Promise<{ success: true }> =>
    apiClient.delete(`/trips/${tripId}/assistant/messages`).then(r => r.data),
  /**
   * Save an assistant answer as a shared note. Sends a socket id that matches
   * no connection so the server's broadcast also reaches this tab's Notes panel
   * (which dedupes by id) instead of being echo-suppressed.
   */
  saveAsNote: (tripId: number | string, data: CollabNoteCreateRequest) =>
    apiClient.post(`/trips/${tripId}/collab/notes`, data, { headers: { 'X-Socket-Id': 'assistant' } }).then(r => r.data),
  getCurrencies: (tripId: number | string): Promise<TripCurrenciesResponse> =>
    apiClient.get(`/trips/${tripId}/currencies`).then(r => r.data),
}
