import { makeRequest, type RequestOptions } from '../utils/http.js';
import { isRefusedUrl } from '../utils/private-addresses.js';

export const MAX_PROBE_BYTES = 256 * 1024;
export const MAX_PROBE_REQUESTS = 16;
export const PROBE_TIMEOUT_MS = 3000;
const BLOCK_SIZE = 4096;

export interface ByteReader {
  size: number | undefined;
  read(offset: number, length: number): Promise<Buffer>;
}

export class ProbeError extends Error {}

/** Bounded random access. Never consume a full-file (200) response. */
export class RangeReader implements ByteReader {
  size: number | undefined;
  bytes = 0;
  requests = 0;
  private blocks: Array<{ offset: number; data: Buffer }> = [];
  private url: string;
  private headers: Headers;
  private controller = new AbortController();
  private signal: AbortSignal;

  constructor(
    url: string,
    private options: {
      headers?: Record<string, string>;
      forwardIp?: string;
      signal?: AbortSignal;
      request?: (url: string, options: RequestOptions) => Promise<Response>;
      isRefused?: (url: string) => Promise<boolean>;
    } = {}
  ) {
    this.url = url;
    this.headers = new Headers(options.headers);
    this.headers.set('Accept-Encoding', 'identity');
    this.signal = AbortSignal.any([
      this.controller.signal,
      AbortSignal.timeout(PROBE_TIMEOUT_MS),
      ...(options.signal ? [options.signal] : []),
    ]);
  }

  close(): void {
    this.controller.abort();
  }

  async read(offset: number, length: number): Promise<Buffer> {
    this.signal.throwIfAborted();
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      !Number.isSafeInteger(offset + length) ||
      length > MAX_PROBE_BYTES
    )
      throw new ProbeError('Invalid metadata offset or size');
    if (length === 0) return Buffer.alloc(0);
    const cached = this.blocks.find(
      (b) => b.offset <= offset && b.offset + b.data.length >= offset + length
    );
    if (cached)
      return cached.data.subarray(
        offset - cached.offset,
        offset - cached.offset + length
      );
    if (this.size !== undefined && offset + length > this.size) {
      throw new ProbeError('Truncated container metadata');
    }
    const count = Math.min(
      Math.max(length, BLOCK_SIZE),
      this.size === undefined ? Infinity : this.size - offset,
      MAX_PROBE_BYTES - this.bytes
    );
    if (count < length)
      throw new ProbeError('Subtitle probe byte budget exhausted');
    const response = await this.request(offset, count);
    try {
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
        response.headers.get('content-range') ?? ''
      );
      if (response.status !== 206 || !range || !response.body) {
        throw new ProbeError('Server does not support bounded byte ranges');
      }
      const [start, end, size] = range.slice(1).map(Number);
      const encoding = response.headers.get('content-encoding');
      if (
        ![start, end, size].every(Number.isSafeInteger) ||
        start !== offset ||
        end < start ||
        end >= offset + count ||
        end >= size ||
        (this.size !== undefined && size !== this.size) ||
        (encoding && encoding !== 'identity')
      )
        throw new ProbeError('Invalid partial response');
      this.size = size;
      const expected = end - start + 1;
      const declared = response.headers.get('content-length');
      if (declared !== null && Number(declared) !== expected) {
        throw new ProbeError('Invalid partial response length');
      }
      const chunks: Buffer[] = [];
      let received = 0;
      const reader = response.body.getReader();
      try {
        while (true) {
          this.signal.throwIfAborted();
          const { done, value } = await this.withSignal(reader.read());
          if (done) break;
          received += value.byteLength;
          this.bytes += value.byteLength;
          if (received > expected || this.bytes > MAX_PROBE_BYTES) {
            throw new ProbeError('Partial response exceeded byte budget');
          }
          chunks.push(Buffer.from(value));
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      if (received !== expected || received < length) {
        throw new ProbeError('Truncated partial response');
      }
      const data = Buffer.concat(chunks, received);
      this.blocks.push({ offset, data });
      return data.subarray(0, length);
    } finally {
      await response.body?.cancel().catch(() => undefined);
    }
  }

  private async request(offset: number, count: number): Promise<Response> {
    this.headers.set('Range', `bytes=${offset}-${offset + count - 1}`);
    for (let redirects = 0; redirects <= 4; redirects++) {
      this.signal.throwIfAborted();
      const url = new URL(this.url);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        (await this.withSignal(
          (this.options.isRefused ?? isRefusedUrl)(this.url)
        ))
      ) {
        throw new ProbeError('Subtitle probe URL is not allowed');
      }
      if (this.requests >= MAX_PROBE_REQUESTS) {
        throw new ProbeError('Subtitle probe request budget exhausted');
      }
      this.requests++;
      const response = await this.withSignal(
        (this.options.request ?? makeRequest)(this.url, {
          timeout: PROBE_TIMEOUT_MS,
          signal: this.signal,
          headers: Object.fromEntries(this.headers.entries()),
          forwardIp: this.options.forwardIp,
          // Repeated ranges are intentional, not recursion.
          ignoreRecursion: true,
          rawOptions: { redirect: 'manual' },
        })
      );
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get('location');
      if (!location || redirects === 4)
        throw new ProbeError('Invalid metadata redirect');
      const next = new URL(location, this.url);
      if (next.origin !== url.origin) {
        for (const name of [
          'authorization',
          'cookie',
          'proxy-authorization',
          'x-api-key',
          'api-key',
          'apikey',
          'host',
        ]) {
          this.headers.delete(name);
        }
      }
      this.url = next.toString();
    }
    throw new ProbeError('Too many metadata redirects');
  }

  private async withSignal<T>(promise: Promise<T>): Promise<T> {
    this.signal.throwIfAborted();
    let abort: () => void;
    const interrupted = new Promise<never>((_, reject) => {
      abort = () => reject(this.signal.reason);
      this.signal.addEventListener('abort', abort, { once: true });
    });
    try {
      return await Promise.race([promise, interrupted]);
    } finally {
      this.signal.removeEventListener('abort', abort!);
    }
  }
}
