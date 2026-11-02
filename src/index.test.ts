import type { MessageEvent } from './index'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ExpoEventSource } from './index'

const mockFetch = vi.fn()

vi.mock('expo/fetch', () => ({
  // eslint-disable-next-line ts/no-unsafe-return, ts/no-unsafe-argument
  fetch: (...args: any[]) => mockFetch(...args),
}))

function createMockStream() {
  let controller: ReadableStreamDefaultController
  const stream = new ReadableStream({
    start(c) {
      controller = c
    },
  })
  const encoder = new TextEncoder()

  return {
    stream,
    enqueue: (text: string) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
    error: (err: Error) => controller.error(err),
  }
}

function sseResponse(
  stream: ReadableStream,
  {
    status = 200,
    contentType = 'text/event-stream',
  }: { status?: number; contentType?: string } = {},
) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name === 'Content-Type' ? contentType : null) },
    body: { getReader: () => stream.getReader() },
  }
}

describe('expoEventSource', () => {
  let mockStream: ReturnType<typeof createMockStream>

  beforeEach(() => {
    vi.useFakeTimers()
    mockStream = createMockStream()

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => {
          if (name === 'Content-Type') return 'text/event-stream'
          return null
        },
      },
      body: {
        getReader: () => mockStream.stream.getReader(),
      },
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  test('connects and sets readyState to OPEN', async () => {
    const es = new ExpoEventSource('https://test.com')
    const onOpen = vi.fn()
    es.addEventListener('open', onOpen)

    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('https://test.com', expect.anything())
    })

    mockStream.enqueue(':ok\n\n')

    await vi.waitFor(() => {
      expect(es.readyState).toBe(1)
      expect(onOpen).toHaveBeenCalled()
    })
  })

  test('parses a simple data message', async () => {
    const es = new ExpoEventSource('https://test.com')
    const onMessage = vi.fn()
    es.addEventListener('message', onMessage)

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled())

    mockStream.enqueue('data: hello world\n\n')

    await vi.waitFor(() => {
      expect(onMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'message',
          data: 'hello world',
          origin: 'https://test.com',
        }),
      )
    })
  })

  test('handles packet fragmentation (The "broken device" fix)', async () => {
    const es = new ExpoEventSource('https://test.com')
    const onMessage = vi.fn()
    es.addEventListener('message', onMessage)

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled())

    mockStream.enqueue('data: part 1 ')
    mockStream.enqueue('and part 2\n')
    mockStream.enqueue('\n')

    await vi.waitFor(() => {
      expect(onMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          data: 'part 1 and part 2',
        }),
      )
    })
  })

  test('handles multi-line data', async () => {
    const es = new ExpoEventSource('https://test.com')
    const onMessage = vi.fn()
    es.addEventListener('message', onMessage)

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled())

    mockStream.enqueue('data: line 1\n')
    mockStream.enqueue('data: line 2\n\n')

    await vi.waitFor(() => {
      expect(onMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          data: 'line 1\nline 2',
        }),
      )
    })
  })

  test('handles custom event types', async () => {
    const es = new ExpoEventSource('https://test.com')
    const onCustom = vi.fn()
    es.addEventListener('update', onCustom)

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled())

    mockStream.enqueue('event: update\n')
    mockStream.enqueue('data: payload\n\n')

    await vi.waitFor(() => {
      expect(onCustom).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'update',
          data: 'payload',
        }),
      )
    })
  })

  test('ignores comments (lines starting with :)', async () => {
    const es = new ExpoEventSource('https://test.com')
    const onMessage = vi.fn()
    es.addEventListener('message', onMessage)

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled())

    mockStream.enqueue(': this is a comment\n')
    mockStream.enqueue('data: real data\n\n')

    await vi.waitFor(() => {
      expect(onMessage).toHaveBeenCalledTimes(1)
      expect(onMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          data: 'real data',
        }),
      )
    })
  })

  test('respects Last-Event-ID', async () => {
    const es = new ExpoEventSource('https://test.com')
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled())

    mockStream.enqueue('id: 123\n')
    mockStream.enqueue('data: test\n\n')

    await vi.waitFor(() => {
      expect(es.lastEventId).toBe('123')
    })
  })

  test('reconnects automatically on error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network Error'))

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => 'text/event-stream' },
      body: { getReader: () => mockStream.stream.getReader() },
    })

    const es = new ExpoEventSource('https://test.com')
    const onOpen = vi.fn()
    es.addEventListener('open', onOpen)

    expect(mockFetch).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(5000)

    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  test('event type resets to "message" after data-less event (ping heartbeat)', async () => {
    const es = new ExpoEventSource('https://test.com')
    const onMessage = vi.fn()
    const onPing = vi.fn()
    es.addEventListener('message', onMessage)
    es.addEventListener('ping', onPing)

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled())

    // Server sends a data-less ping heartbeat, then a real message.
    // The ping's empty-line must reset currentEventType so the next
    // event is not incorrectly dispatched as "ping".
    mockStream.enqueue('event: ping\n')
    mockStream.enqueue('\n')
    mockStream.enqueue('data: hello\n')
    mockStream.enqueue('\n')

    await vi.waitFor(() => {
      expect(onPing).not.toHaveBeenCalled()
      expect(onMessage).toHaveBeenCalledTimes(1)
      expect(onMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'message', data: 'hello' }),
      )
    })
  })

  test('dispatches an event with an empty data line (tRPC ping)', async () => {
    const es = new ExpoEventSource('https://test.com')
    const onPing = vi.fn()
    es.addEventListener('ping', onPing)

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled())

    mockStream.enqueue('event: ping\ndata: \n\n')

    await vi.waitFor(() => {
      expect(onPing).toHaveBeenCalledWith(expect.objectContaining({ type: 'ping', data: '' }))
    })
  })

  test('uses the "retry" field as the reconnection delay without dropping the stream', async () => {
    const es = new ExpoEventSource('https://test.com')

    await vi.waitFor(() => expect(es.readyState).toBe(1))

    mockStream.enqueue('retry: 1000\n\n')
    await vi.advanceTimersByTimeAsync(1000)
    expect(mockFetch).toHaveBeenCalledTimes(1)

    mockStream.error(new Error('Network Error'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  test('reconnects after the server ends the stream and discards a partial event', async () => {
    const next = createMockStream()
    mockFetch
      .mockResolvedValueOnce(sseResponse(mockStream.stream))
      .mockResolvedValueOnce(sseResponse(next.stream))
    const es = new ExpoEventSource('https://test.com')
    const onMessage = vi.fn()
    const onError = vi.fn()
    es.addEventListener('message', onMessage)
    es.addEventListener('error', onError)
    await vi.waitFor(() => expect(es.readyState).toBe(ExpoEventSource.OPEN))

    mockStream.enqueue('data: partial\n')
    mockStream.close()
    await vi.waitFor(() => expect(onError).toHaveBeenCalled())
    expect(es.readyState).toBe(ExpoEventSource.CONNECTING)

    await vi.advanceTimersByTimeAsync(5000)
    await vi.waitFor(() => expect(es.readyState).toBe(ExpoEventSource.OPEN))
    next.enqueue('data: whole\n\n')

    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(1))
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ data: 'whole' }))
  })

  test.each([
    ['a non-200 status', { status: 500 }],
    ['a 204 status', { status: 204 }],
    ['a wrong Content-Type', { contentType: 'text/plain' }],
  ])('fails the connection without reconnecting on %s', async (_, response) => {
    mockFetch.mockResolvedValueOnce(sseResponse(mockStream.stream, response))
    const es = new ExpoEventSource('https://test.com')
    const onError = vi.fn()
    es.addEventListener('error', onError)

    await vi.waitFor(() => expect(onError).toHaveBeenCalled())
    expect(es.readyState).toBe(ExpoEventSource.CLOSED)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  test('accepts a Content-Type with parameters', async () => {
    mockFetch.mockResolvedValueOnce(
      sseResponse(mockStream.stream, { contentType: 'Text/Event-Stream; charset=utf-8' }),
    )
    const es = new ExpoEventSource('https://test.com')

    await vi.waitFor(() => expect(es.readyState).toBe(ExpoEventSource.OPEN))
  })

  test('splits lines on CR, LF and CRLF, also when a chunk splits CRLF', async () => {
    const es = new ExpoEventSource('https://test.com')
    const onMessage = vi.fn()
    es.addEventListener('message', onMessage)
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled())

    mockStream.enqueue('data: a\r')
    mockStream.enqueue('\ndata: b\rdata: c\n\r\n')

    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(1))
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ data: 'a\nb\nc' }))
  })

  test('removes only one leading space from a value and keeps lines without a colon', async () => {
    const es = new ExpoEventSource('https://test.com')
    const onMessage = vi.fn()
    es.addEventListener('message', onMessage)
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled())

    mockStream.enqueue('data:  two spaces \ndata\n\n')

    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(1))
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ data: ' two spaces \n' }))
  })

  test('does not treat a whitespace-only line as the end of an event', async () => {
    const es = new ExpoEventSource('https://test.com')
    const onMessage = vi.fn()
    es.addEventListener('message', onMessage)
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled())

    mockStream.enqueue('data: a\n \ndata: b\n\n')

    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(1))
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ data: 'a\nb' }))
  })

  test('dispatches an event with an empty type as "message"', async () => {
    const es = new ExpoEventSource('https://test.com')
    const onMessage = vi.fn()
    es.addEventListener('message', onMessage)
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled())

    mockStream.enqueue('event:\ndata: x\n\n')

    await vi.waitFor(() => {
      expect(onMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'message', data: 'x' }),
      )
    })
  })

  test('sets lastEventId when the event ends and ignores ids containing NULL', async () => {
    const es = new ExpoEventSource('https://test.com')
    const onMessage = vi.fn<(event: MessageEvent) => void>()
    es.addEventListener('message', onMessage)
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled())

    mockStream.enqueue('id: 1\n')
    await vi.advanceTimersByTimeAsync(0)
    expect(es.lastEventId).toBe('')

    mockStream.enqueue('data: a\n\nid: 2\0\ndata: b\n\nid: 3\n\n')

    await vi.waitFor(() => expect(es.lastEventId).toBe('3'))
    expect(onMessage.mock.calls.map(([event]) => event.lastEventId)).toEqual(['1', '1'])
  })

  test('calls onopen, onmessage and onerror', async () => {
    const es = new ExpoEventSource('https://test.com')
    const onopen = vi.fn()
    const onmessage = vi.fn()
    const onerror = vi.fn()
    /* eslint-disable unicorn/prefer-add-event-listener -- these assignments are what this test covers */
    es.onopen = onopen
    es.onmessage = onmessage
    es.onerror = onerror
    /* eslint-enable unicorn/prefer-add-event-listener */

    await vi.waitFor(() =>
      expect(onopen).toHaveBeenCalledWith(expect.objectContaining({ type: 'open' })),
    )
    mockStream.enqueue('data: x\n\n')
    await vi.waitFor(() =>
      expect(onmessage).toHaveBeenCalledWith(expect.objectContaining({ data: 'x' })),
    )
    mockStream.error(new Error('Network Error'))
    await vi.waitFor(() =>
      expect(onerror).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })),
    )
  })

  test('close() cancels a scheduled reconnection', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network Error'))
    const es = new ExpoEventSource('https://test.com')
    const onError = vi.fn()
    es.addEventListener('error', onError)
    await vi.waitFor(() => expect(onError).toHaveBeenCalled())

    es.close()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(es.readyState).toBe(ExpoEventSource.CLOSED)
  })
})
