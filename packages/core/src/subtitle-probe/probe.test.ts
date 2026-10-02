import { describe, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { MediaTrack, ParsedStream, UserData } from '../db/schemas.js';
import type { StreamContext } from '../streams/context.js';
import StreamFilterer from '../streams/filterer.js';
import { Cache } from '../utils/cache.js';
import { readSubtitleTracks } from './container.js';
import { RangeReader, MAX_PROBE_BYTES, MAX_PROBE_REQUESTS } from './reader.js';
import { SubtitleProbe, subtitleProbe } from './index.js';
import { mergeParsedFiles } from '../parser/merge.js';
import { subtitleLanguages } from '../utils/media-info.js';

function ebml(id: string, body: Buffer): Buffer {
  let length = 1;
  while (body.length >= 2 ** (7 * length) - 1) length++;
  const size = Buffer.alloc(length);
  let value = body.length;
  for (let i = length - 1; i >= 0; i--) {
    size[i] = value & 255;
    value = Math.floor(value / 256);
  }
  size[0] |= 1 << (8 - length);
  return Buffer.concat([Buffer.from(id, 'hex'), size, body]);
}
const field = (id: string, value: string | number) =>
  ebml(
    id,
    typeof value === 'string' ? Buffer.from(value) : Buffer.from([value])
  );
function track(type: number, lang?: string, extra: Buffer[] = []): Buffer {
  return ebml(
    'ae',
    Buffer.concat([
      field('83', type),
      ...(lang ? [field('22b59c', lang)] : []),
      field('86', type === 17 ? 'S_TEXT/UTF8' : 'V_MPEG4/ISO/AVC'),
      ...extra,
    ])
  );
}
const mkvPrefix = Buffer.concat([
  ebml('1a45dfa3', field('4282', 'matroska')),
  Buffer.from('18538067ff', 'hex'),
]);
function mkv(...tracks: Buffer[]): Buffer {
  return Buffer.concat([mkvPrefix, ebml('1654ae6b', Buffer.concat(tracks))]);
}
function box(type: string, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8);
  header.write(type, 4, 'ascii');
  return Buffer.concat([header, body]);
}
function mp4Track(
  handler: string,
  language: string,
  codec = 'tx3g',
  version = 0,
  extended?: string
): Buffer {
  const mdhd = Buffer.alloc(version === 1 ? 36 : 24);
  mdhd[0] = version;
  mdhd.writeUInt16BE(
    ((language.charCodeAt(0) - 96) << 10) |
      ((language.charCodeAt(1) - 96) << 5) |
      (language.charCodeAt(2) - 96),
    version === 1 ? 32 : 20
  );
  const hdlr = Buffer.alloc(12);
  hdlr.write(handler, 8);
  const stsd = box('stsd', Buffer.from('0000000000000001', 'hex'), box(codec));
  return box(
    'trak',
    box(
      'mdia',
      box('mdhd', mdhd),
      box('hdlr', hdlr),
      ...(extended
        ? [box('elng', Buffer.alloc(4), Buffer.from(`${extended}\0`))]
        : []),
      box('minf', box('stbl', stsd))
    )
  );
}
const ftyp = box('ftyp', Buffer.from('isom0000isom'));

/** Sparse multi-GB files without allocating/downloading their media payload. */
function remote(
  size: number,
  fragments: Array<{ offset: number; data: Buffer }>
) {
  const ranges: Array<{ start: number; end: number; headers: Headers }> = [];
  const reader = new RangeReader('https://cdn.example/video', {
    isRefused: async () => false,
    request: async (_url, options) => {
      const headers = new Headers(options.headers as Record<string, string>);
      assert.equal(headers.get('accept-encoding'), 'identity');
      const match = /^bytes=(\d+)-(\d+)$/.exec(headers.get('range')!);
      assert.ok(match);
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]), size - 1);
      assert.ok(end - start + 1 <= MAX_PROBE_BYTES);
      ranges.push({ start, end, headers });
      const body = Buffer.alloc(end - start + 1);
      for (const fragment of fragments) {
        const from = Math.max(start, fragment.offset);
        const to = Math.min(end + 1, fragment.offset + fragment.data.length);
        if (to > from)
          fragment.data.copy(
            body,
            from - start,
            from - fragment.offset,
            to - fragment.offset
          );
      }
      return new Response(body, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Content-Length': String(body.length),
        },
      });
    },
  });
  return { reader, ranges };
}
const fromBuffer = (data: Buffer) => remote(data.length, [{ offset: 0, data }]);

describe('container metadata', () => {
  test('reads Matroska languages, BCP47 overrides and subtitle flags without filename hints', async () => {
    const { reader } = fromBuffer(
      mkv(
        track(1, 'eng'),
        track(17, 'eng'),
        track(17, 'eng', [
          field('22b59d', 'fr'),
          field('536e', 'French SDH'),
          field('55aa', 1),
          field('55ab', 1),
        ])
      )
    );
    try {
      const tracks = await readSubtitleTracks(reader);
      assert.equal(tracks.length, 2);
      assert.equal(tracks[0].lang, 'English');
      assert.equal(tracks[1].lang, 'French');
      assert.equal(tracks[1].title, 'French SDH');
      assert.equal(tracks[1].forced, true);
      assert.equal(tracks[1].hearingImpaired, true);
      assert.equal(reader.requests, 1);
    } finally {
      reader.close();
    }
  });

  test('uses the Matroska default language, while preserving explicitly unknown tracks', async () => {
    const { reader } = fromBuffer(mkv(track(17), track(17, 'und')));
    try {
      const tracks = await readSubtitleTracks(reader);
      assert.equal(tracks[0].lang, 'English');
      assert.equal(tracks[1].lang, undefined);
    } finally {
      reader.close();
    }
  });

  test('distinguishes a complete track list with no subtitles from probe failure', async () => {
    const { reader } = fromBuffer(mkv(track(1, 'eng')));
    try {
      assert.deepEqual(await readSubtitleTracks(reader), []);
    } finally {
      reader.close();
    }
  });

  test('seeks directly to Matroska Tracks beyond a large media cluster', async () => {
    const position = Buffer.alloc(8);
    position.writeBigUInt64BE(8n * 1024n * 1024n);
    const seek = ebml(
      '114d9b74',
      ebml(
        '4dbb',
        Buffer.concat([
          ebml('53ab', Buffer.from('1654ae6b', 'hex')),
          ebml('53ac', position),
        ])
      )
    );
    const tracks = ebml('1654ae6b', track(17, 'spa'));
    const target = mkvPrefix.length + Number(position.readBigUInt64BE());
    const { reader, ranges } = remote(target + tracks.length, [
      {
        offset: 0,
        data: Buffer.concat([
          mkvPrefix,
          seek,
          Buffer.from('1f43b675ff', 'hex'),
        ]),
      },
      { offset: target, data: tracks },
    ]);
    try {
      assert.equal((await readSubtitleTracks(reader))[0].lang, 'Spanish');
      assert.equal(ranges.length, 2);
      assert.equal(ranges[1].start, target);
      assert.ok(reader.bytes < 8192);
    } finally {
      reader.close();
    }
  });

  test('does not scan media to search for missing Matroska tracks', async () => {
    const { reader, ranges } = remote(1024 * 1024 * 1024, [
      {
        offset: 0,
        data: Buffer.concat([mkvPrefix, Buffer.from('1f43b675ff', 'hex')]),
      },
    ]);
    try {
      await assert.rejects(
        readSubtitleTracks(reader),
        /Tracks not found before media/
      );
      assert.equal(ranges.length, 1);
    } finally {
      reader.close();
    }
  });

  test('reads MP4 metadata after a 5 GB mdat using two small ranges', async () => {
    const mdatSize = 5 * 1024 ** 3;
    const mdat = Buffer.alloc(16);
    mdat.writeUInt32BE(1);
    mdat.write('mdat', 4);
    mdat.writeBigUInt64BE(BigInt(mdatSize), 8);
    const movie = box(
      'moov',
      mp4Track('vide', 'eng', 'avc1'),
      mp4Track('sbtl', 'fre'),
      mp4Track('subt', 'eng', 'wvtt', 1, 'fr')
    );
    const target = ftyp.length + mdatSize;
    const { reader, ranges } = remote(target + movie.length, [
      { offset: 0, data: Buffer.concat([ftyp, mdat]) },
      { offset: target, data: movie },
    ]);
    try {
      const tracks = await readSubtitleTracks(reader);
      assert.deepEqual(
        tracks.map((t) => t.lang),
        ['French', 'French']
      );
      assert.deepEqual(
        tracks.map((t) => t.codec),
        ['tx3g', 'wvtt']
      );
      assert.equal(ranges.length, 2);
      assert.equal(ranges[1].start, target);
      assert.ok(reader.bytes < 8192);
    } finally {
      reader.close();
    }
  });

  test('does not mistake a QuickTime chapter text track for subtitles', async () => {
    const { reader } = fromBuffer(
      Buffer.concat([ftyp, box('moov', mp4Track('text', 'eng', 'text'))])
    );
    try {
      assert.deepEqual(await readSubtitleTracks(reader), []);
    } finally {
      reader.close();
    }
  });

  test('rejects unsupported, truncated and malformed containers', async () => {
    for (const data of [
      Buffer.from('notvideo'),
      Buffer.from('0000000266747970', 'hex'),
      Buffer.concat([mkvPrefix, Buffer.from('1654ae6bff', 'hex')]),
    ]) {
      const { reader } = fromBuffer(data);
      try {
        await assert.rejects(readSubtitleTracks(reader));
      } finally {
        reader.close();
      }
    }
  });
});

describe('bounded HTTP reads', () => {
  test('cancels a server that ignores Range without consuming its full-file body', async () => {
    let cancelled = false;
    const reader = new RangeReader('https://cdn.example/video', {
      isRefused: async () => false,
      request: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200, headers: { 'Content-Length': '5000000000' } }
        ),
    });
    try {
      await assert.rejects(
        reader.read(0, 8),
        /does not support bounded byte ranges/
      );
      assert.equal(cancelled, true);
      assert.equal(reader.bytes, 0);
    } finally {
      reader.close();
    }
  });

  test('rejects invalid ranges, oversized bodies and compressed metadata', async () => {
    for (const variant of ['wrong-offset', 'oversized', 'compressed']) {
      const reader = new RangeReader('https://cdn.example/video', {
        isRefused: async () => false,
        request: async () =>
          new Response(Buffer.alloc(variant === 'oversized' ? 5000 : 4096), {
            status: 206,
            headers: {
              'Content-Range':
                variant === 'wrong-offset'
                  ? 'bytes 1-4096/10000'
                  : 'bytes 0-4095/10000',
              ...(variant === 'compressed'
                ? { 'Content-Encoding': 'gzip' }
                : {}),
            },
          }),
      });
      try {
        await assert.rejects(reader.read(0, 8));
      } finally {
        reader.close();
      }
    }
  });

  test('enforces byte and request caps even for sparse files', async () => {
    const byteLimited = remote(MAX_PROBE_BYTES * 2, []);
    try {
      await byteLimited.reader.read(0, MAX_PROBE_BYTES);
      await assert.rejects(
        byteLimited.reader.read(MAX_PROBE_BYTES, 1),
        /byte budget/
      );
      assert.equal(byteLimited.reader.bytes, MAX_PROBE_BYTES);
    } finally {
      byteLimited.reader.close();
    }
    const requestLimited = remote(1024 * 1024, []);
    try {
      for (let i = 0; i < MAX_PROBE_REQUESTS; i++)
        await requestLimited.reader.read(i * 4096, 1);
      await assert.rejects(
        requestLimited.reader.read(MAX_PROBE_REQUESTS * 4096, 1),
        /request budget/
      );
      assert.equal(requestLimited.ranges.length, MAX_PROBE_REQUESTS);
    } finally {
      requestLimited.reader.close();
    }
  });

  test('deadline interrupts a stalled response body', async () => {
    const reader = new RangeReader('https://cdn.example/video', {
      isRefused: async () => false,
      signal: AbortSignal.timeout(20),
      request: async () =>
        new Response(new ReadableStream(), {
          status: 206,
          headers: { 'Content-Range': 'bytes 0-4095/10000' },
        }),
    });
    const started = Date.now();
    try {
      await assert.rejects(reader.read(0, 8), /timeout/i);
      assert.ok(Date.now() - started < 1000);
    } finally {
      reader.close();
    }
  });

  test('forwards playback headers and strips credentials before an off-host redirect', async () => {
    const seen: Headers[] = [];
    const reader = new RangeReader('https://addon.example/video', {
      headers: {
        Authorization: 'test-only-token',
        Cookie: 'test-only-cookie',
        'User-Agent': 'player',
      },
      isRefused: async () => false,
      request: async (_url, options) => {
        seen.push(new Headers(options.headers as Record<string, string>));
        return seen.length === 1
          ? new Response(null, {
              status: 302,
              headers: { Location: 'https://cdn.example/video' },
            })
          : new Response(Buffer.alloc(8), {
              status: 206,
              headers: { 'Content-Range': 'bytes 0-7/8' },
            });
      },
    });
    try {
      await reader.read(0, 8);
      assert.equal(seen[0].get('authorization'), 'test-only-token');
      assert.equal(seen[1].get('authorization'), null);
      assert.equal(seen[1].get('cookie'), null);
      assert.equal(seen[1].get('user-agent'), 'player');
      assert.equal(seen[1].get('range'), 'bytes=0-4095');
    } finally {
      reader.close();
    }
  });

  test('rejects a redirect to a disallowed private destination before requesting it', async () => {
    let requests = 0;
    const reader = new RangeReader('https://addon.example/video', {
      isRefused: async (url) => new URL(url).hostname === '127.0.0.1',
      request: async () => {
        requests++;
        return new Response(null, {
          status: 302,
          headers: { Location: 'http://127.0.0.1/private' },
        });
      },
    });
    try {
      await assert.rejects(reader.read(0, 8), /not allowed/);
      assert.equal(requests, 1);
    } finally {
      reader.close();
    }
  });
});

let sequence = 0;
function stream(url = `https://cdn.example/video-${sequence++}`): ParsedStream {
  return {
    id: url,
    url,
    type: 'http',
    filename: 'Movie.mkv',
    addon: {
      instanceId: 'test',
      resultPassthrough: false,
      preset: { id: 'test' },
    },
    parsedFile: {
      audioChannels: [],
      audioTags: [],
      visualTags: [],
      languages: ['German'],
      subtitles: [],
    },
  } as unknown as ParsedStream;
}
function resolver(
  probe: (
    stream: ParsedStream,
    signal: AbortSignal
  ) => Promise<MediaTrack[] | null>
) {
  return new SubtitleProbe(
    probe,
    Cache.getInstance(`subtitle-test-${sequence++}`, 1000, 'memory')
  );
}
const required = {
  requiredSubtitles: ['French'],
  presets: [],
  services: [],
} as unknown as UserData;
const context = () => ({}) as StreamContext;

function filterContext(): StreamContext {
  return {
    type: 'movie',
    id: 'tt1234567',
    parsedId: null,
    isAnime: false,
    getPermittedPatterns: async () => ({
      unrestricted: true,
      permitted: new Set(),
    }),
    getMetadata: async () => undefined,
    getReleaseDates: async () => undefined,
    getEpisodeAirDate: async () => undefined,
    getEpisodeRuntime: async () => undefined,
    toExpressionContext: () => ({}),
  } as unknown as StreamContext;
}

describe('subtitle enrichment and filtering', () => {
  test('shares in-flight duplicate queries and caches both success and unknown results', async () => {
    let calls = 0;
    const resolve = resolver(async (s) => {
      calls++;
      await new Promise<void>((r) => setImmediate(r));
      return s.url!.endsWith('/missing') ? null : [{ lang: 'French' }];
    });
    const url = `https://cdn.example/shared-${sequence++}`;
    const streams = [stream(url), stream(url), stream(`${url}/missing`)];
    await resolve.resolve(streams, required, context());
    await resolve.resolve(
      [stream(url), stream(`${url}/missing`)],
      required,
      context()
    );
    assert.equal(calls, 2);
    assert.deepEqual(streams[0].parsedFile?.subtitles, ['French']);
    assert.deepEqual(streams[0].parsedFile?.languages, ['German']);
    assert.equal(streams[0].parsedFile?.mediaInfoQuality, undefined);
    assert.equal(streams[0].parsedFile?.subtitleInfoQuality, 'probe');
    assert.equal(streams[2].parsedFile?.subtitleInfoQuality, undefined);
  });

  test('keeps an authoritative empty track list and represents unknown track languages', async () => {
    const noSubtitles = stream();
    noSubtitles.parsedFile!.subtitles = ['French'];
    await resolver(async () => []).resolve([noSubtitles], required, context());
    assert.deepEqual(noSubtitles.parsedFile?.subtitles, []);
    assert.deepEqual(noSubtitles.parsedFile?.subtitleTracks, []);
    const unknown = stream();
    await resolver(async () => [{}]).resolve([unknown], required, context());
    assert.deepEqual(unknown.parsedFile?.subtitles, ['Unknown']);
    assert.deepEqual(subtitleLanguages(noSubtitles.parsedFile), []);
    assert.deepEqual(subtitleLanguages(unknown.parsedFile), ['Unknown']);
    assert.deepEqual(subtitleLanguages(stream().parsedFile), ['Unknown']);
  });

  test('preserves complete subtitle metadata during filename/folder merges', async () => {
    const probed = stream();
    await resolver(async () => []).resolve([probed], required, context());
    const guessed = stream();
    guessed.parsedFile!.subtitles = ['French'];
    guessed.parsedFile!.subtitleTracks = [{ lang: 'French' }];
    const merged = mergeParsedFiles(guessed.parsedFile, probed.parsedFile);
    assert.deepEqual(merged?.subtitles, []);
    assert.deepEqual(merged?.subtitleTracks, []);
    assert.equal(merged?.subtitleInfoQuality, 'probe');
  });

  test('a verified subtitle-free file does not match Unknown or get excluded for nonexistent languages', async () => {
    const noSubtitles = stream();
    await resolver(async () => []).resolve([noSubtitles], required, context());
    const unknownRequired = {
      ...required,
      requiredSubtitles: ['Unknown'],
      probeSubtitles: false,
    } as UserData;
    assert.deepEqual(
      await new StreamFilterer(unknownRequired).filter(
        [noSubtitles],
        filterContext()
      ),
      []
    );
    const excludeFrench = {
      presets: [],
      services: [],
      excludedSubtitles: ['French'],
      probeSubtitles: false,
    } as unknown as UserData;
    const kept = await new StreamFilterer(excludeFrench).filter(
      [noSubtitles],
      filterContext()
    );
    assert.deepEqual(
      kept.map((s) => s.id),
      [noSubtitles.id]
    );
  });

  test('does no network work without subtitle preferences or when disabled, uncached or passthrough', async () => {
    let calls = 0;
    const resolve = resolver(async () => {
      calls++;
      return [];
    });
    await resolve.resolve([stream()], {} as UserData, context());
    await resolve.resolve(
      [stream()],
      { ...required, probeSubtitles: false },
      context()
    );
    const uncached = stream();
    uncached.service = {
      id: 'realdebrid',
      cached: false,
    } as ParsedStream['service'];
    const passthrough = stream();
    passthrough.passthrough = ['subtitle'];
    const accurate = stream();
    accurate.parsedFile!.mediaInfoQuality = 'probe';
    const torrent = stream();
    torrent.type = 'p2p';
    torrent.url = undefined;
    await resolve.resolve(
      [uncached, passthrough, accurate, torrent],
      required,
      context()
    );
    assert.equal(calls, 0);
  });

  test('uses playback credentials and client IP in cache identity', async () => {
    let calls = 0;
    const resolve = resolver(async () => {
      calls++;
      return [];
    });
    const url = `https://cdn.example/private-${sequence++}`;
    const a = stream(url);
    const b = stream(url);
    a.requestHeaders = { Authorization: 'first-test-account' };
    b.requestHeaders = { Authorization: 'second-test-account' };
    const c = stream(url);
    c.addon.ip = '203.0.113.5';
    await resolve.resolve([a, b, c], required, context());
    assert.equal(calls, 3);
  });

  test('bounds file count across repeated filter groups for the same request', async () => {
    let calls = 0;
    const resolve = resolver(async () => {
      calls++;
      return [];
    });
    const request = context();
    await resolve.resolve(
      Array.from({ length: 20 }, () => stream()),
      required,
      request
    );
    await resolve.resolve(
      Array.from({ length: 20 }, () => stream()),
      required,
      request
    );
    assert.equal(calls, 32);
  });

  test('applies actual embedded languages before the required subtitle filter', async (t) => {
    const localProbe = resolver(async (s) => {
      const { reader } = fromBuffer(
        mkv(track(17, s.filename === 'French.Sub.mkv' ? 'eng' : 'fre'))
      );
      try {
        return await readSubtitleTracks(reader);
      } finally {
        reader.close();
      }
    });
    mock.method(subtitleProbe, 'resolve', localProbe.resolve.bind(localProbe));
    t.after(() => mock.restoreAll());
    const hinted = stream();
    hinted.filename = 'French.Sub.mkv';
    hinted.parsedFile!.subtitles = ['French'];
    const unhinted = stream();
    const filtered = await new StreamFilterer(required).filter(
      [hinted, unhinted],
      filterContext()
    );
    assert.deepEqual(
      filtered.map((s) => s.id),
      [unhinted.id]
    );
    assert.deepEqual(unhinted.parsedFile?.subtitles, ['French']);
    assert.deepEqual(hinted.parsedFile?.subtitles, ['English']);
  });
});
