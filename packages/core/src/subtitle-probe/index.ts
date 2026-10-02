import { createHash } from 'node:crypto';
import pLimit from 'p-limit';
import type { MediaTrack, ParsedStream, UserData } from '../db/schemas.js';
import type { StreamContext } from '../streams/context.js';
import { shouldPassthroughStage } from '../streams/utils.js';
import { Cache } from '../utils/cache.js';
import { createLogger } from '../logging/logger.js';
import { RangeReader, PROBE_TIMEOUT_MS } from './reader.js';
import { readSubtitleTracks } from './container.js';

const logger = createLogger('subtitle-probe');
const MAX_FILES_PER_REQUEST = 32;
const cache = Cache.getInstance<string, { tracks: MediaTrack[] | null }>(
  'subtitle-probe',
  10000
);
type Probe = (
  stream: ParsedStream,
  signal: AbortSignal
) => Promise<MediaTrack[] | null>;

async function probeStream(
  stream: ParsedStream,
  signal: AbortSignal
): Promise<MediaTrack[] | null> {
  const reader = new RangeReader(stream.url!, {
    headers: stream.requestHeaders,
    forwardIp: stream.addon.ip,
    signal,
  });
  try {
    return await readSubtitleTracks(reader);
  } catch {
    // Unsupported containers, unavailable links and bounded-out probes stay unknown.
    return null;
  } finally {
    reader.close();
    logger.debug(
      { bytes: reader.bytes, requests: reader.requests },
      'subtitle metadata probe completed'
    );
  }
}

/** Shared across filter passes and addon groups, including service-wrapped URLs. */
export class SubtitleProbe {
  private limit = pLimit(4);
  private inFlight = new Map<string, Promise<MediaTrack[] | null>>();
  private budgets = new WeakMap<StreamContext, { remaining: number }>();

  constructor(
    private probe: Probe = probeStream,
    private results = cache
  ) {}

  async resolve(
    streams: ParsedStream[],
    userData: UserData,
    context: StreamContext
  ): Promise<void> {
    if (
      userData.probeSubtitles === false ||
      ![
        userData.requiredSubtitles,
        userData.excludedSubtitles,
        userData.includedSubtitles,
        userData.preferredSubtitles,
      ].some((languages) => languages?.length)
    )
      return;

    let budget = this.budgets.get(context);
    if (!budget) {
      budget = { remaining: MAX_FILES_PER_REQUEST };
      this.budgets.set(context, budget);
    }
    // Queued probes share a short deadline, so many slow links cannot add minutes.
    const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
    await Promise.all(
      streams.map(async (stream) => {
        if (
          !stream.url ||
          !['http', 'debrid', 'usenet', 'stremio-usenet'].includes(
            stream.type
          ) ||
          (stream.service && !stream.service.cached) ||
          shouldPassthroughStage(stream, 'subtitle') ||
          stream.parsedFile?.subtitleInfoQuality === 'probe' ||
          stream.parsedFile?.mediaInfoQuality === 'probe'
        )
          return;
        const key = createHash('sha256')
          .update(
            JSON.stringify([
              stream.url,
              Object.entries(stream.requestHeaders ?? {}).sort(([a], [b]) =>
                a.localeCompare(b)
              ),
              stream.addon.ip,
            ])
          )
          .digest('hex');
        try {
          const hit = await this.results.get(key);
          let tracks = hit?.tracks;
          if (hit === undefined) {
            let pending = this.inFlight.get(key);
            if (!pending) {
              pending = this.limit(async () => {
                if (signal.aborted || budget!.remaining === 0) return null;
                budget!.remaining--;
                const result = await this.probe(stream, signal);
                await this.results.set(
                  key,
                  { tracks: result },
                  result === null ? 5 * 60 : 24 * 60 * 60
                );
                return result;
              });
              this.inFlight.set(key, pending);
              // Own the cleanup's rejection as well as the awaited promise's.
              void pending
                .finally(() => this.inFlight.delete(key))
                .catch(() => undefined);
            }
            tracks = await pending;
          }
          if (tracks == null) return;
          stream.parsedFile = {
            audioChannels: [],
            visualTags: [],
            audioTags: [],
            languages: [],
            ...stream.parsedFile,
            subtitleInfoQuality: 'probe',
            subtitleTracks: tracks.map((track) => ({ ...track })),
            subtitles: [
              ...new Set(tracks.map((track) => track.lang ?? 'Unknown')),
            ],
          };
        } catch {
          // Probing is optional; preserve the original metadata on failure.
        }
      })
    );
  }
}

export const subtitleProbe = new SubtitleProbe();
