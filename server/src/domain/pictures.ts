// I0, pictures from a source: a photograph behind an `image ... | words` line.
//
// PROBE OF OPENVERSE'S KEYLESS API (observed 2026-11-14, five requests, client name
// "conduit-picture-probe/0.1", no key, no personal details):
//
// - Endpoint: GET https://api.openverse.org/v1/images/?q=<words>. No key, no sign-up. HTTP/2, JSON, served by Cloudflare.
// - Rate limits, from response headers on every answer:
//     x-ratelimit-limit-anon_burst: 20/min        x-ratelimit-available-anon_burst: 19
//     x-ratelimit-limit-anon_sustained: 200/day   x-ratelimit-available-anon_sustained: 199
//   The available counts read 19 and 199 on three different queries a few seconds apart, so
//   they are a hint and not a ledger (a repeat of the same URL was answered from the CDN, cf-cache-status MISS then HIT).
//   Anonymous page_size is capped at 20 ("page_size may not exceed 20 for anonymous requests", HTTP 400).
//   The thumbnail endpoint has its own bucket: x-ratelimit-limit-anon_thumbnail: 1000/day.
// - Throttled: NOT observed. Spending 20 requests in a minute to see it was more than "a handful"; the code takes the
//   documented behaviour (HTTP 429, with Retry-After) and treats any 429 as "stop asking until Retry-After, or one
//   minute", and treats a spent daily allowance (available = 0) as "stop until tomorrow".
// - Filters: license_type=commercial,modification is accepted (an unknown value is a 400 with a JSON detail);
//   also size=large, aspect_ratio=wide|tall|square, extension=jpg, mature=false. With the licence filter the
//   results seen were by-sa, by, cc0 from wikimedia, rawpixel, stocksnap and flickr.
// - Response: { result_count, page_count, page_size, page, results: [...] }. Each result has id, title,
//   url (the ORIGINAL file, on the source's own host: upload.wikimedia.org, live.staticflickr.com, ...),
//   foreign_landing_url (the page to link for credit), creator, creator_url, license (cc0|pdm|by|by-sa|...),
//   license_version, license_url, provider, source, attribution (a ready sentence), width, height (can be null),
//   filesize and filetype (usually null), mature (bool), thumbnail, detail_url, tags.
// - Image URLs: the originals are not resized for us. One result was 3304x1815 and 6.2 MB (content-type image/jpeg,
//   from a server with a large rate limit of its own). So the file is fetched with a byte cap and shrunk here.
//   Openverse's own thumbnail URL (api.openverse.org/v1/images/<id>/thumb/) answered HTTP 424 once (it fetches the
//   original itself and had failed); it is not relied on.
//
// WHAT THE SERVER DOES WITH THAT
// - Only the words of the `image` line leave the machine, to Openverse as `q`, plus a generic User-Agent. The image
//   hosts see the server's address and that same User-Agent. Nothing about the user, the conversation or the look.
// - Licence: asked for server-side (commercial,modification) and checked again on every result by `makeCredit` against
//   `PICTURE_LICENCES`: a result with a licence outside the list has no credit, and a candidate without a credit does not exist.
// - The picture is fetched by the server, size-limited as it streams, identified by its bytes (not its headers),
//   decoded and re-encoded (which drops EXIF, GPS, XMP, comments), cropped to the box, and kept on disk outside the repository.
// - The credit is part of the result and is always drawn; a picture with no credit is not a result.
// - Any failure, a throttle, no match, no licence, a bad file, is `null`: the placeholder stays and nothing waits.

/** The licences a picture may carry: free to use commercially and to modify. Anything else, and anything unknown, is refused. */
export const PICTURE_LICENCES: readonly string[] = ['cc0', 'pdm', 'by', 'by-sa'];

export const PICTURE_LIMITS = {
  /** words past this are dropped before they are sent */
  maxWords: 8,
  maxQueryChars: 80,
  /** bytes accepted from an image host, counted as they arrive */
  maxDownloadBytes: 12_000_000,
  /** a file declaring more pixels than this is not decoded */
  maxPixels: 60_000_000,
  /** longest side of the stored picture */
  maxSide: 1600,
  /** smallest picture worth drawing as a hero */
  minSide: 480,
  jpegQuality: 82,
  /** how many candidates are tried before giving up */
  maxTries: 3,
  /** at most this many characters of any credit field are kept */
  maxCreditChars: 160,
} as const;

/** What the painter's placeholder is: a box and the words. The server never sees more. */
export interface PictureQuery {
  /** the words after the `|` of an `image` line */
  readonly words: string;
  /** width over height of the box the picture will fill, when known */
  readonly aspect: number | null;
}

/** Who made it, under what licence, and where to find it: always drawn at the picture's foot and kept in every export. */
export interface PictureCredit {
  readonly title: string;
  readonly creator: string;
  readonly licence: string;
  readonly licenceUrl: string;
  readonly landingUrl: string;
  readonly source: string;
}

/** One result of a search, before anything is fetched. */
export interface PictureCandidate {
  readonly id: string;
  readonly url: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly credit: PictureCredit;
  readonly mature: boolean;
}

/**
 * A search behind a port. Contract: `search` resolves with candidates already filtered to `PICTURE_LICENCES` (and
 * filtered again by the caller), never throws for a throttle or a miss (it resolves empty and `ready()` says when to
 * ask again), honours `signal`, never logs the words above `debug`, and sends nothing but the words.
 */
export interface PictureSource {
  readonly id: string;
  /** false for the source that stands in when none is switched on */
  readonly available: boolean;
  search(query: PictureQuery, signal: AbortSignal): Promise<readonly PictureCandidate[]>;
}

/** A picture on disk, ready to be served: always a JPEG, metadata-free, with its credit. */
export interface Picture {
  readonly key: string;
  readonly mime: 'image/jpeg';
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly credit: PictureCredit;
}

/** Answers an `image` line. `find` resolves `null` for every failure; it is never on a turn's clock, the caller does not wait for it. */
export interface PictureService {
  readonly id: string;
  readonly available: boolean;
  /** the stored picture for these words, or fetched now; `null` leaves the placeholder */
  find(query: PictureQuery, signal: AbortSignal): Promise<Picture | null>;
  /** a stored picture by key (what a URL carries); `null` when it is not on disk */
  get(key: string): Promise<Picture | null>;
}

export interface PictureSettings {
  readonly kind: 'none' | 'openverse';
  /** where pictures are kept: outside the repository */
  readonly cacheDir: string;
  /** one request to Openverse at most this often; 20 a minute is its burst limit */
  readonly minIntervalMs: number;
  readonly timeoutMs: number;
}

/** Words fit to send: letters, digits and spaces, lower case, few. Empty when nothing is left. */
export function normaliseWords(raw: string): string {
  const words = raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .slice(0, PICTURE_LIMITS.maxWords)
    .join(' ');
  return words.slice(0, PICTURE_LIMITS.maxQueryChars).trim();
}

export function licenceAllowed(licence: string): boolean {
  return PICTURE_LICENCES.includes(licence.toLowerCase());
}

/** `wide`, `tall` or `square`, the three shapes a source understands. */
export function aspectWord(aspect: number | null): 'wide' | 'tall' | 'square' | null {
  if (aspect === null || !Number.isFinite(aspect) || aspect <= 0) return null;
  if (aspect > 1.15) return 'wide';
  if (aspect < 0.87) return 'tall';
  return 'square';
}

function clean(text: string, limit: number): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}...` : flat;
}

/** A credit from a source's own fields; null when the licence is not allowed or no one can be credited. */
export function makeCredit(fields: { title: string | null; creator: string | null; licence: string | null; licenceVersion: string | null; licenceUrl: string | null; landingUrl: string | null; source: string | null }): PictureCredit | null {
  const licence = (fields.licence ?? '').toLowerCase();
  if (!licenceAllowed(licence)) return null;
  const landingUrl = fields.landingUrl ?? '';
  if (!/^https:\/\//.test(landingUrl)) return null;
  const upper = licence === 'cc0' ? 'CC0 1.0' : licence === 'pdm' ? 'Public Domain Mark 1.0' : `CC ${licence.toUpperCase()}${fields.licenceVersion ? ` ${fields.licenceVersion}` : ''}`;
  const creator = clean(fields.creator ?? '', PICTURE_LIMITS.maxCreditChars);
  return {
    title: clean(fields.title ?? '', PICTURE_LIMITS.maxCreditChars) || 'Untitled',
    creator: creator || 'Unknown',
    licence: upper,
    licenceUrl: /^https:\/\//.test(fields.licenceUrl ?? '') ? (fields.licenceUrl as string) : '',
    landingUrl,
    source: clean(fields.source ?? '', 40) || 'Openverse',
  };
}

/** The line drawn at a picture's foot. */
export function creditLine(credit: PictureCredit): string {
  const by = credit.creator === 'Unknown' ? '' : ` by ${credit.creator}`;
  return `"${credit.title}"${by} / ${credit.licence} / ${credit.source}`;
}

/**
 * Candidates worth trying, best first: no mature ones, none too small, nearest the box's shape, larger before smaller
 * within reason. Pure, so it is tested without a network.
 */
export function rankCandidates(candidates: readonly PictureCandidate[], aspect: number | null): readonly PictureCandidate[] {
  const scored: { candidate: PictureCandidate; score: number }[] = [];
  for (const candidate of candidates) {
    if (candidate.mature) continue;
    const { width, height } = candidate;
    if (width !== null && height !== null) {
      if (Math.max(width, height) < PICTURE_LIMITS.minSide) continue;
      const shape = aspect === null ? 0 : Math.abs(Math.log(width / height / aspect));
      const size = Math.min(1, Math.max(width, height) / 1200);
      scored.push({ candidate, score: shape - 0.3 * size });
    } else {
      scored.push({ candidate, score: 1 });
    }
  }
  return scored.sort((a, b) => a.score - b.score).map((entry) => entry.candidate);
}
