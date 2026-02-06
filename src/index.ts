import type { FetchRequestInit } from 'expo/fetch'
import { fetch as expoFetch } from 'expo/fetch'

export type MessageEvent = {
  data?: unknown
  origin?: string
  lastEventId?: string
  type: string
  source?: unknown
  ports?: unknown[]
}

export interface EventSourceOptions {
  credentials?: FetchRequestInit['credentials']
  headers?: Record<string, string>
  debugLog?: (message: string, args?: any) => void
}

export class ExpoEventSource {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 2

  url: string
  readyState: number = ExpoEventSource.CONNECTING
  private abortController: AbortController | null = null
  lastEventId: string | null = null
  private cache = ''
  private handlers = new Map<string, Set<(event: MessageEvent) => void>>()
  private decoder = new TextDecoder()
  private reconnectionTimeout: number | null = null
  private opts: EventSourceOptions | undefined

  private currentEventData: string[] = []
  private currentEventType = 'message'

  constructor(url: string, opts?: EventSourceOptions) {
    this.url = url
    this.opts = opts

    void this.connect()
  }

  private debugLog(message: string, args?: any) {
    this.opts?.debugLog?.(`[EventSource] ${message}`, args)
  }

  private async connect() {
    if (this.readyState === ExpoEventSource.CLOSED) {
      this.debugLog('EventSource is closed, not reconnecting')
      return
    }

    try {
      this.abortController = new AbortController()
      const headers: Record<string, string> = {
        'Accept': 'text/event-stream',
        'Cache-Control': 'no-cache',
        ...this.opts?.headers,
      }

      if (this.lastEventId) {
        headers['Last-Event-ID'] = this.lastEventId
      }

      this.debugLog('Connecting', {
        url: this.url,
        ...headers,
      })

      const response = await expoFetch(this.url, {
        method: 'GET',
        headers,
        signal: this.abortController.signal,
        credentials: this.opts?.credentials,
      })

      if (!response.ok) {
        this.debugLog('HTTP error', response)
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      if (response.status === 204) {
        this.readyState = ExpoEventSource.CLOSED
        this.dispatchEvent('error', { type: 'error' })
        return
      }

      const contentType = response.headers.get('Content-Type')
      if (!contentType || !contentType.includes('text/event-stream')) {
        this.debugLog('Invalid Content-Type', contentType)
        throw new Error(`Invalid Content-Type: ${contentType}`)
      }

      this.debugLog('Connected', response)

      if (this.readyState === ExpoEventSource.CONNECTING) {
        this.readyState = ExpoEventSource.OPEN
        this.dispatchEvent('open', { type: 'open' })
      }

      if (!response.body) {
        this.debugLog('HTTP response body is undefined')
        throw new Error('HTTP response body is undefined')
      }

      const reader = response.body.getReader()

      while (true) {
        const { value, done } = await reader.read()
        if (done) break

        // value is a Uint8Array
        const chunk = this.decoder.decode(value, { stream: true })
        this.processChunk(chunk)
      }
    } catch (err) {
      this.debugLog('Connection error', err)
      if (this.readyState !== ExpoEventSource.CLOSED) {
        this.readyState = ExpoEventSource.CONNECTING
        this.dispatchEvent('error', { type: 'error', data: (err as Error).message })
        this.scheduleReconnectionAfter(5000)
      }
    }
  }

  private processChunk(chunk: string) {
    this.cache += chunk
    const lines = this.cache.split('\n')
    this.cache = lines.pop() ?? ''

    for (const line of lines) {
      const trimmedLine = line.trim()

      if (!trimmedLine) {
        if (this.currentEventData.length > 0) {
          this.dispatchEvent(this.currentEventType, {
            data: this.currentEventData.join('\n'),
            lastEventId: this.lastEventId ?? undefined,
            origin: new URL(this.url).origin,
            type: this.currentEventType,
            source: null,
            ports: [],
          })
          this.currentEventData = []
          this.currentEventType = 'message'
        }
        continue
      }

      const colonIndex = trimmedLine.indexOf(':')
      if (colonIndex === -1) continue

      const field = trimmedLine.slice(0, colonIndex)
      const value = trimmedLine.slice(colonIndex + 1).trim()

      if (field === 'data' && value === '') continue

      this.debugLog('Processing line', { field, value })

      switch (field) {
        case 'event': {
          this.currentEventType = value
          break
        }
        case 'data': {
          this.currentEventData.push(value.endsWith('\n') ? value.slice(0, -1) : value)
          break
        }
        case 'id': {
          if (!value.includes('\0')) this.lastEventId = value || null
          break
        }
        case 'retry': {
          const retry = Number.parseInt(value)
          if (!Number.isNaN(retry)) {
            this.scheduleReconnectionAfter(retry)
          }
          break
        }
      }
    }
  }

  private scheduleReconnectionAfter(ms: number) {
    this.debugLog('Scheduling reconnection after', ms)
    if (this.reconnectionTimeout) clearTimeout(this.reconnectionTimeout)

    this.reconnectionTimeout = setTimeout(() => {
      void this.connect()
    }, ms)
  }

  addEventListener(type: string, handler: (event: MessageEvent) => void) {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set())
    }
    this.handlers.get(type)!.add(handler)
  }

  removeEventListener(type: string, handler: (event: MessageEvent) => void) {
    const handlers = this.handlers.get(type)
    if (handlers) {
      handlers.delete(handler)
    }
  }

  dispatchEvent(type: string, event: MessageEvent) {
    const handlers = this.handlers.get(type)
    if (handlers) {
      for (const handler of handlers) {
        handler.call(this, event)
      }
    }
  }

  close() {
    this.readyState = ExpoEventSource.CLOSED
    if (this.abortController) {
      this.abortController.abort()
    }
  }
}
