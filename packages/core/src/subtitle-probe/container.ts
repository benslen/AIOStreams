import type { MediaTrack } from '../db/schemas.js';
import { normaliseLanguage } from '../utils/languages.js';
import { ProbeError, type ByteReader } from './reader.js';

const MAX_ELEMENTS = 256;
type Element = { id: number; start: number; end: number | undefined };

function vint(
  data: Buffer,
  offset: number,
  id = false
): { value: number; length: number; unknown: boolean } {
  const first = data[offset];
  if (!first) throw new ProbeError('Invalid EBML integer');
  let length = 1;
  while (length <= 8 && !(first & (1 << (8 - length)))) length++;
  if (length > (id ? 4 : 8) || offset + length > data.length)
    throw new ProbeError('Truncated EBML integer');
  let value = BigInt(id ? first : first & ((1 << (8 - length)) - 1));
  for (let i = 1; i < length; i++)
    value = value * 256n + BigInt(data[offset + i]);
  const unknown = !id && value === (1n << BigInt(7 * length)) - 1n;
  if (!unknown && value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new ProbeError('EBML size is too large');
  return { value: unknown ? 0 : Number(value), length, unknown };
}

function ebmlHeader(data: Buffer, offset: number): Element {
  const id = vint(data, offset, true);
  const size = vint(data, offset + id.length);
  const start = offset + id.length + size.length;
  const end = size.unknown ? undefined : start + size.value;
  if (end !== undefined && !Number.isSafeInteger(end))
    throw new ProbeError('Invalid EBML offset');
  return { id: id.value, start, end };
}

function children(data: Buffer): Array<{ id: number; data: Buffer }> {
  const result: Array<{ id: number; data: Buffer }> = [];
  for (let offset = 0; offset < data.length; ) {
    if (result.length >= MAX_ELEMENTS)
      throw new ProbeError('Too many metadata elements');
    const e = ebmlHeader(data, offset);
    if (e.end === undefined || e.end > data.length)
      throw new ProbeError('Truncated EBML element');
    result.push({ id: e.id, data: data.subarray(e.start, e.end) });
    offset = e.end;
  }
  return result;
}

function uint(data: Buffer): number {
  if (data.length === 0 || data.length > 8)
    throw new ProbeError('Invalid EBML unsigned integer');
  let value = 0n;
  for (const byte of data) value = value * 256n + BigInt(byte);
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new ProbeError('EBML offset is too large');
  return Number(value);
}

function mkvTracks(data: Buffer): MediaTrack[] {
  const tracks: MediaTrack[] = [];
  for (const entry of children(data).filter((e) => e.id === 0xae)) {
    const fields = new Map(children(entry.data).map((e) => [e.id, e.data]));
    if (!fields.has(0x83)) throw new ProbeError('Missing Matroska track type');
    if (uint(fields.get(0x83)!) !== 17) continue;
    const text = (id: number) =>
      fields.get(id)?.toString('utf8').replace(/\0+$/, '');
    const flag = (id: number, fallback: boolean) =>
      fields.has(id) ? uint(fields.get(id)!) !== 0 : fallback;
    tracks.push({
      // Matroska specifies English when the Language element is absent.
      lang: normaliseLanguage(text(0x22b59d) || text(0x22b59c) || 'eng'),
      codec: text(0x86),
      title: text(0x536e),
      default: flag(0x88, true),
      forced: flag(0x55aa, false),
      hearingImpaired: flag(0x55ab, false),
    });
  }
  return tracks;
}

async function matroska(reader: ByteReader): Promise<MediaTrack[]> {
  let offset = 0;
  let segmentStart: number | undefined;
  let segmentEnd: number | undefined;
  const seen = new Set<number>();
  for (let i = 0; i < MAX_ELEMENTS; i++) {
    if (seen.has(offset)) throw new ProbeError('Looping Matroska seek entry');
    seen.add(offset);
    const header = await reader.read(
      offset,
      Math.min(12, (reader.size ?? Infinity) - offset)
    );
    const e = ebmlHeader(header, 0);
    const start = offset + e.start;
    const end = e.end === undefined ? undefined : offset + e.end;
    if (
      end !== undefined &&
      (end > (reader.size ?? Infinity) || end > (segmentEnd ?? Infinity))
    ) {
      throw new ProbeError('Matroska element exceeds container');
    }
    if (e.id === 0x18538067) {
      if (segmentStart !== undefined)
        throw new ProbeError('Multiple Matroska segments');
      segmentStart = start;
      segmentEnd = end;
      offset = start;
      continue;
    }
    if (
      e.id === 0x1654ae6b &&
      segmentStart !== undefined &&
      end !== undefined
    ) {
      return mkvTracks(await reader.read(start, end - start));
    }
    if (
      e.id === 0x114d9b74 &&
      segmentStart !== undefined &&
      end !== undefined
    ) {
      const seekHead = children(await reader.read(start, end - start));
      for (const seek of seekHead.filter((s) => s.id === 0x4dbb)) {
        const fields = new Map(children(seek.data).map((s) => [s.id, s.data]));
        if (
          fields.has(0x53ab) &&
          uint(fields.get(0x53ab)!) === 0x1654ae6b &&
          fields.has(0x53ac)
        ) {
          offset = segmentStart + uint(fields.get(0x53ac)!);
          if (
            !Number.isSafeInteger(offset) ||
            offset >= (segmentEnd ?? reader.size ?? Infinity)
          ) {
            throw new ProbeError('Matroska track seek is outside container');
          }
          // A malformed seek must not make unrelated data look like Tracks.
          const target = ebmlHeader(await reader.read(offset, 12), 0);
          if (target.id !== 0x1654ae6b)
            throw new ProbeError('Invalid Matroska track seek');
          break;
        }
      }
      if (offset !== start - e.start) continue;
    }
    // Do not scan media clusters, even when their length is known.
    if (e.id === 0x1f43b675 || end === undefined)
      throw new ProbeError('Tracks not found before media');
    offset = end;
    if (offset >= (segmentEnd ?? reader.size ?? Infinity)) break;
  }
  throw new ProbeError('Matroska tracks not found within probe limits');
}

type Box = { type: string; start: number; end: number };
async function boxes(
  reader: ByteReader,
  start: number,
  end?: number,
  stopAt?: string
): Promise<Box[]> {
  const result: Box[] = [];
  let offset = start;
  while (offset < (end ?? reader.size ?? Infinity)) {
    if (result.length >= MAX_ELEMENTS)
      throw new ProbeError('Too many MP4 metadata boxes');
    const header = await reader.read(offset, 8);
    let size = header.readUInt32BE(0);
    let headerSize = 8;
    if (size === 1) {
      const large = (await reader.read(offset + 8, 8)).readBigUInt64BE();
      if (large > BigInt(Number.MAX_SAFE_INTEGER))
        throw new ProbeError('MP4 box is too large');
      size = Number(large);
      headerSize = 16;
    } else if (size === 0) {
      size = (end ?? reader.size ?? offset) - offset;
    }
    if (
      size < headerSize ||
      !Number.isSafeInteger(offset + size) ||
      offset + size > (end ?? reader.size ?? Infinity)
    ) {
      throw new ProbeError('Invalid MP4 box size');
    }
    result.push({
      type: header.toString('ascii', 4, 8),
      start: offset + headerSize,
      end: offset + size,
    });
    if (result.at(-1)!.type === stopAt) break;
    offset += size;
  }
  return result;
}

async function mp4(reader: ByteReader): Promise<MediaTrack[]> {
  const top = await boxes(reader, 0, undefined, 'moov');
  const moov = top.find((box) => box.type === 'moov');
  if (!moov) throw new ProbeError('MP4 movie metadata not found');
  const tracks: MediaTrack[] = [];
  const movie = await boxes(reader, moov.start, moov.end);
  for (const trak of movie.filter((box) => box.type === 'trak')) {
    const mdia = (await boxes(reader, trak.start, trak.end)).find(
      (box) => box.type === 'mdia'
    );
    if (!mdia) continue;
    const media = await boxes(reader, mdia.start, mdia.end);
    const hdlr = media.find((box) => box.type === 'hdlr');
    if (!hdlr || hdlr.end - hdlr.start < 12)
      throw new ProbeError('Missing MP4 track handler');
    const handler = (await reader.read(hdlr.start, 12)).toString(
      'ascii',
      8,
      12
    );
    if (!['subt', 'sbtl', 'text', 'clcp'].includes(handler)) continue;
    const mdhd = media.find((box) => box.type === 'mdhd');
    if (!mdhd) throw new ProbeError('Missing MP4 language metadata');
    const version = (await reader.read(mdhd.start, 1))[0];
    if (version > 1) throw new ProbeError('Unsupported MP4 media header');
    const languageOffset = version === 1 ? 32 : 20;
    if (mdhd.end - mdhd.start < languageOffset + 2)
      throw new ProbeError('Truncated MP4 language');
    const packed = (
      await reader.read(mdhd.start + languageOffset, 2)
    ).readUInt16BE();
    let language = String.fromCharCode(
      ((packed >> 10) & 31) + 96,
      ((packed >> 5) & 31) + 96,
      (packed & 31) + 96
    );
    const elng = media.find((box) => box.type === 'elng');
    if (elng && elng.end - elng.start > 4) {
      language = (await reader.read(elng.start + 4, elng.end - elng.start - 4))
        .toString('utf8')
        .replace(/\0+$/, '');
    }
    const minf = media.find((box) => box.type === 'minf');
    let codec: string | undefined;
    if (minf) {
      const stbl = (await boxes(reader, minf.start, minf.end)).find(
        (box) => box.type === 'stbl'
      );
      const stsd =
        stbl &&
        (await boxes(reader, stbl.start, stbl.end)).find(
          (box) => box.type === 'stsd'
        );
      if (stsd && stsd.end - stsd.start >= 16) {
        const description = await reader.read(stsd.start, 16);
        if (description.readUInt32BE(4) > 0)
          codec = description.toString('ascii', 12, 16);
      }
    }
    // QuickTime text can be a chapter track rather than subtitles.
    if (
      handler === 'text' &&
      !['tx3g', 'wvtt', 'stpp', 'c608', 'c708'].includes(codec ?? '')
    )
      continue;
    tracks.push({ lang: normaliseLanguage(language), codec });
  }
  return tracks;
}

/** Identify by magic bytes, not extension. Seek past media; never read it all. */
export async function readSubtitleTracks(
  reader: ByteReader
): Promise<MediaTrack[]> {
  const magic = await reader.read(0, 8);
  if (magic.readUInt32BE(0) === 0x1a45dfa3) return matroska(reader);
  if (
    ['ftyp', 'moov', 'mdat', 'free', 'wide', 'skip'].includes(
      magic.toString('ascii', 4, 8)
    )
  )
    return mp4(reader);
  throw new ProbeError('Unsupported subtitle container');
}
