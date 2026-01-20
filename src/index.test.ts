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
    const es = new ExpoEventSource('http://test.com')
    const onOpen = vi.fn()
    es.addEventListener('open', onOpen)

    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('http://test.com', expect.anything())
    })

    mockStream.enqueue(':ok\n\n')

    await vi.waitFor(() => {
      expect(es.readyState).toBe(1)
      expect(onOpen).toHaveBeenCalled()
    })
  })

  test('parses a simple data message', async () => {
    const es = new ExpoEventSource('http://test.com')
    const onMessage = vi.fn()
    es.addEventListener('message', onMessage)

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled())

    mockStream.enqueue('data: hello world\n\n')

    await vi.waitFor(() => {
      expect(onMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'message',
          data: 'hello world',
          origin: 'http://test.com',
        }),
      )
    })
  })

  test('handles packet fragmentation (The "broken device" fix)', async () => {
    const es = new ExpoEventSource('http://test.com')
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
    const es = new ExpoEventSource('http://test.com')
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
    const es = new ExpoEventSource('http://test.com')
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
    const es = new ExpoEventSource('http://test.com')
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
    const es = new ExpoEventSource('http://test.com')
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

    const es = new ExpoEventSource('http://test.com')
    const onOpen = vi.fn()
    es.addEventListener('open', onOpen)

    expect(mockFetch).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1000)

    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  test('handles "retry" field', async () => {
    const es = new ExpoEventSource('http://test.com')

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled())

    mockStream.enqueue('retry: 5000\n\n')

    // @ts-expect-error accessing private field for testing
    await es.connect()
  })
})
