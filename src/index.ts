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

type EventHandler = (event: MessageEvent) => void

export class ExpoEventSource {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 2

  private abortController: AbortController | null = null
  private handlers = new Map<string, Set<EventHandler>>()
  private reconnectionTimeout: ReturnType<typeof setTimeout> | null = null
  private reconnectionDelay = 5000
  private opts: EventSourceOptions | undefined

  private decoder = new TextDecoder()
  private buffer = ''
  private dataBuffer = ''
  private eventTypeBuffer = ''
  private lastEventIdBuffer = ''

  url: string
  readyState: number = ExpoEventSource.CONNECTING
  lastEventId = ''
  onopen: EventHandler | null = null
  onmessage: EventHandler | null = null
  onerror: EventHandler | null = null

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

    this.decoder = new TextDecoder()
    this.buffer = ''
    this.dataBuffer = ''
    this.eventTypeBuffer = ''

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

      const contentType = response.headers.get('Content-Type')
      const mimeType = contentType?.split(';', 1)[0]?.trim().toLowerCase()
      if (response.status !== 200 || mimeType !== 'text/event-stream' || !response.body) {
        this.debugLog('Failing the connection', { status: response.status, contentType })
        this.failConnection(`HTTP ${response.status}, Content-Type ${contentType}`)
        return
      }

      this.debugLog('Connected', response)
      this.readyState = ExpoEventSource.OPEN
      this.dispatchEvent('open', { type: 'open' })

      const reader = response.body.getReader()

      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        this.processChunk(this.decoder.decode(value, { stream: true }))
      }

      this.debugLog('Stream ended')
      this.reestablishConnection('Stream ended')
    } catch (err) {
      this.debugLog('Connection error', err)
      this.reestablishConnection((err as Error).message)
    }
  }

  private failConnection(reason: string) {
    if (this.readyState === ExpoEventSource.CLOSED) return
    this.readyState = ExpoEventSource.CLOSED
    this.dispatchEvent('error', { type: 'error', data: reason })
  }

  private reestablishConnection(reason: string) {
    if (this.readyState === ExpoEventSource.CLOSED) return
    this.readyState = ExpoEventSource.CONNECTING
    this.dispatchEvent('error', { type: 'error', data: reason })
    this.scheduleReconnectionAfter(this.reconnectionDelay)
  }

  private processChunk(chunk: string) {
    const buffer = this.buffer + chunk
    let lineStart = 0

    for (let i = 0; i < buffer.length; i++) {
      const char = buffer[i]
      if (char !== '\r' && char !== '\n') continue
      if (char === '\r' && i === buffer.length - 1) break

      this.processLine(buffer.slice(lineStart, i))
      if (char === '\r' && buffer[i + 1] === '\n') i++
      lineStart = i + 1
    }

    this.buffer = buffer.slice(lineStart)
  }

  private processLine(line: string) {
    if (line === '') {
      this.dispatchBufferedEvent()
      return
    }
    if (line.startsWith(':')) return

    const colonIndex = line.indexOf(':')
    const field = colonIndex === -1 ? line : line.slice(0, colonIndex)
    let value = colonIndex === -1 ? '' : line.slice(colonIndex + 1)
    if (value.startsWith(' ')) value = value.slice(1)

    this.debugLog('Processing line', { field, value })

    switch (field) {
      case 'event': {
        this.eventTypeBuffer = value
        break
      }
      case 'data': {
        this.dataBuffer += `${value}\n`
        break
      }
      case 'id': {
        if (!value.includes('\0')) this.lastEventIdBuffer = value
        break
      }
      case 'retry': {
        if (/^\d+$/.test(value)) this.reconnectionDelay = Number(value)
        break
      }
    }
  }

  private dispatchBufferedEvent() {
    this.lastEventId = this.lastEventIdBuffer

    if (this.dataBuffer === '') {
      this.eventTypeBuffer = ''
      return
    }

    const type = this.eventTypeBuffer || 'message'
    const data = this.dataBuffer.slice(0, -1)
    this.dataBuffer = ''
    this.eventTypeBuffer = ''

    this.dispatchEvent(type, {
      type,
      data,
      lastEventId: this.lastEventId,
      origin: new URL(this.url).origin,
      source: null,
      ports: [],
    })
  }

  private scheduleReconnectionAfter(ms: number) {
    this.debugLog('Scheduling reconnection after', ms)
    if (this.reconnectionTimeout) clearTimeout(this.reconnectionTimeout)

    this.reconnectionTimeout = setTimeout(() => {
      this.reconnectionTimeout = null
      void this.connect()
    }, ms)
  }

  addEventListener(type: string, handler: EventHandler) {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set())
    }
    this.handlers.get(type)!.add(handler)
  }

  removeEventListener(type: string, handler: EventHandler) {
    this.handlers.get(type)?.delete(handler)
  }

  dispatchEvent(type: string, event: MessageEvent) {
    const attributeHandler =
      type === 'open'
        ? this.onopen
        : type === 'message'
          ? this.onmessage
          : type === 'error'
            ? this.onerror
            : null
    attributeHandler?.call(this, event)

    const handlers = this.handlers.get(type) ?? []
    for (const handler of handlers) {
      handler.call(this, event)
    }
  }

  close() {
    this.readyState = ExpoEventSource.CLOSED
    if (this.reconnectionTimeout) clearTimeout(this.reconnectionTimeout)
    this.reconnectionTimeout = null
    this.abortController?.abort()
  }
}
