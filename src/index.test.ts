import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExpoEventSource } from './index'

const mockFetch = vi.fn()

vi.mock('expo/fetch', () => ({
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
    push: (text: string) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
  }
}

describe('ExpoEventSource', () => {
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

  it('connects and sets readyState to OPEN', async () => {
    const es = new ExpoEventSource('http://test.com')
    const onOpen = vi.fn()
    es.addEventListener('open', onOpen)

    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('http://test.com', expect.anything())
    })

    mockStream.push(':ok\n\n')

    await vi.waitFor(() => {
      expect(es.readyState).toBe(1)
      expect(onOpen).toHaveBeenCalled()
    })
  })

  it('parses a simple data message', async () => {
    const es = new ExpoEventSource('http://test.com')
    const onMessage = vi.fn()
    es.addEventListener('message', onMessage)

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled())

    mockStream.push('data: hello world\n\n')

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

  it('handles packet fragmentation (The "broken device" fix)', async () => {
    const es = new ExpoEventSource('http://test.com')
    const onMessage = vi.fn()
    es.addEventListener('message', onMessage)

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled())

    mockStream.push('data: part 1 ')
    mockStream.push('and part 2\n')
    mockStream.push('\n')

    await vi.waitFor(() => {
      expect(onMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          data: 'part 1 and part 2',
        }),
      )
    })
  })

  it('handles multi-line data', async () => {
    const es = new ExpoEventSource('http://test.com')
    const onMessage = vi.fn()
    es.addEventListener('message', onMessage)

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled())

    mockStream.push('data: line 1\n')
    mockStream.push('data: line 2\n\n')

    await vi.waitFor(() => {
      expect(onMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          data: 'line 1\nline 2',
        }),
      )
    })
  })

  it('handles custom event types', async () => {
    const es = new ExpoEventSource('http://test.com')
    const onCustom = vi.fn()
    es.addEventListener('update', onCustom)

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled())

    mockStream.push('event: update\n')
    mockStream.push('data: payload\n\n')

    await vi.waitFor(() => {
      expect(onCustom).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'update',
          data: 'payload',
        }),
      )
    })
  })

  it('ignores comments (lines starting with :)', async () => {
    const es = new ExpoEventSource('http://test.com')
    const onMessage = vi.fn()
    es.addEventListener('message', onMessage)

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled())

    mockStream.push(': this is a comment\n')
    mockStream.push('data: real data\n\n')

    await vi.waitFor(() => {
      expect(onMessage).toHaveBeenCalledTimes(1)
      expect(onMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          data: 'real data',
        }),
      )
    })
  })

  it('respects Last-Event-ID', async () => {
    const es = new ExpoEventSource('http://test.com')
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled())

    mockStream.push('id: 123\n')
    mockStream.push('data: test\n\n')

    await vi.waitFor(() => {
      expect(es.lastEventId).toBe('123')
    })
  })

  it('reconnects automatically on error', async () => {
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

  it('handles "retry" field', async () => {
    const es = new ExpoEventSource('http://test.com')

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled())

    mockStream.push('retry: 5000\n\n')

    // @ts-ignore
    await es.connect()
  })
})
