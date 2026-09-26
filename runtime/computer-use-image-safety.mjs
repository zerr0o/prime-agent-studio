// Image safety: transient context-only normalization so no image above the
// provider dimension limit can break a request.
// Scope: drop oversized historical Computer Use screenshots (>2000px on any
// side) from provider-bound message copies, and downscale any OTHER oversized
// image (user attachments, assistant content, non-CU tool results) via the
// engine photon resizer when available, else drop it with a marker. Never
// rewrites session logs. CU pixels are never rescaled: resizing without
// updating the stored frame (frame.width/height/bounds, frameId coordinate
// space) would corrupt frame safety, so CU images are dropped with a
// take-a-new-observation marker. User images carry no coordinates, so
// downscaling them (aspect ratio kept, both axes <= 2000) is safe and
// preferred over dropping.
//
// Background: Anthropic rejects images with any dimension above 2000px
// (provider 400 on messages.N.content.M.image.source.base64.data). The native
// worker now caps NEW captures at both dims <= 2000, but oversized historical
// screenshots can persist in resumed context and still block the next call.
// This module filters message COPIES just before the provider call so resume
// works without destroying history on disk.
//
// Engine hook (for root): the installed engine exposes a `context` extension
// event ({ type: "context", messages }) whose handler may return
// { messages }. That is the recommended interception point because it runs on
// AgentMessage[] before provider conversion, provider-agnostic. See
// planning/computer-use-image-safety.md for the tiny hook snippet root can
// insert in runtime/studio-computer-use-extension.mjs. A `before_provider_request`
// payload hook also exists but payloads are provider-shaped and fragile, so
// prefer `context`.
//
// Design: pure, dependency-free, header-only inspection (PNG IHDR, JPEG SOF).
// Unknown formats, bad data, or dims <= 2000 are preserved fail-open.

export const MAX_IMAGE_DIMENSION = 2000;

// Conservative byte budget for header sniffing. PNG needs 24 bytes; JPEG SOF
// markers normally sit in the first kilobytes. 64 KiB coverstroublesome
// APP/COM-prefixed files while keeping base64 decode bounded.
const HEADER_BYTES = 64 * 1024;
const HEADER_B64_CHARS = 87384; // ceil(65536/3)*4, sliced on a 4-char boundary

const COMPUTER_USE_TOOL_NAMES = new Set(['computer_observe', 'computer_act']);

function toolActionOf(message) {
  const details = message?.details;
  if (details && typeof details === 'object' && !Array.isArray(details)) {
    const action = details.action;
    if (typeof action === 'string' && action) return action;
  }
  return null;
}

export function isComputerUseToolResult(message) {
  if (!message || typeof message !== 'object') return false;
  if (message.role !== 'toolResult') return false;
  const name = message.toolName;
  if (typeof name === 'string' && name) {
    if (COMPUTER_USE_TOOL_NAMES.has(name)) return true;
    // Future-proof: any computer_* tool result is Computer Use owned.
    if (name.startsWith('computer_')) return true;
  }
  const action = toolActionOf(message);
  if (typeof action === 'string' && action.startsWith('computer_')) return true;
  return false;
}

function decodeHeaderBytes(data) {
  if (typeof data !== 'string' || data.length === 0) return null;
  // Bound work FIRST: PNG IHDR and JPEG SOF markers always sit in the first
  // kilobytes, so only a fixed raw prefix is ever stripped, validated, or
  // decoded. A multi-MB tail is never touched (native images are plain
  // base64 with no whitespace, so 128 KiB raw chars always cover the 64 KiB
  // decoded header window with slack to spare).
  const RAW_PREFIX_CHARS = 131072; // 128 KiB
  const raw = data.length > RAW_PREFIX_CHARS ? data.slice(0, RAW_PREFIX_CHARS) : data;
  const clean = raw.replace(/\s+/g, '');
  // Base64 alphabet check on the prefix only. Fail-open on garbage. A cut
  // prefix may end mid-quantum, so align down to a 4-char boundary instead
  // of rejecting (padding only occurs at the true end of short inputs).
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) return null;
  let slice = clean.slice(0, HEADER_B64_CHARS);
  slice = slice.slice(0, Math.floor(slice.length / 4) * 4);
  // Floor of 16 chars (12 bytes): enough for the smallest sniffable header
  // (GIF needs 10 bytes). Each format parser still enforces its own length
  // and magic, so shorter garbage stays fail-open.
  if (slice.length < 16) return null;
  try {
    const buf = Buffer.from(slice, 'base64');
    // Floor of 10 bytes: the smallest sniffable header (GIF). Each format
    // parser still enforces its own length and magic below.
    if (!buf || buf.length < 10) return null;
    return buf;
  } catch {
    return null;
  }
}

function pngDimensions(bytes) {
  if (bytes.length < 24) return null;
  if (
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47 ||
    bytes[4] !== 0x0d ||
    bytes[5] !== 0x0a ||
    bytes[6] !== 0x1a ||
    bytes[7] !== 0x0a
  ) {
    return null;
  }
  // IHDR must be first: length (4) + "IHDR" (4) + width (4) + height (4).
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) {
    return null;
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return null;
  if (width < 1 || height < 1 || width > 100000 || height > 100000) return null;
  return { width, height, format: 'png' };
}

function jpegDimensions(bytes) {
  if (bytes.length < 4) return null;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null; // SOI
  let pos = 2;
  const end = bytes.length;
  while (pos + 4 <= end) {
    if (bytes[pos] !== 0xff) {
      pos += 1;
      continue;
    }
    // Skip padding 0xFF bytes.
    let marker = bytes[pos + 1];
    let markerPos = pos + 1;
    while (marker === 0xff && markerPos + 1 < end) {
      markerPos += 1;
      marker = bytes[markerPos];
    }
    pos = markerPos + 1;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      continue; // Standalone markers, no length field.
    }
    if (pos + 2 > end) return null;
    const length = bytes.readUInt16BE(pos);
    if (length < 2) return null;
    const isSOF = marker === 0xc0 || marker === 0xc1 || marker === 0xc2 || marker === 0xc3;
    if (isSOF) {
      if (pos + 7 >= end) return null;
      const height = bytes.readUInt16BE(pos + 3);
      const width = bytes.readUInt16BE(pos + 5);
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return null;
      if (width < 1 || height < 1 || width > 100000 || height > 100000) return null;
      return { width, height, format: 'jpeg' };
    }
    pos += length;
  }
  return null;
}

function gifDimensions(bytes) {
  if (bytes.length < 10) return null;
  const signature = bytes.toString('ascii', 0, 6);
  if (signature !== 'GIF87a' && signature !== 'GIF89a') return null;
  const width = bytes.readUInt16LE(6);
  const height = bytes.readUInt16LE(8);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return null;
  if (width < 1 || height < 1 || width > 100000 || height > 100000) return null;
  return { width, height, format: 'gif' };
}

function webpDimensions(bytes) {
  // RIFF size WEBP + chunk id: 16 bytes to identify the chunk, then each
  // chunk enforces its own dimension field length (VP8X/VP8: 30, VP8L: 25).
  if (bytes.length < 16) return null;
  if (bytes.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (bytes.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = bytes.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    if (bytes.length < 30) return null;
    // Extended: 24-bit little-endian canvas size minus one.
    const width = bytes.readUIntLE(24, 3) + 1;
    const height = bytes.readUIntLE(27, 3) + 1;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return null;
    if (width < 1 || height < 1 || width > 100000 || height > 100000) return null;
    return { width, height, format: 'webp' };
  }
  if (chunk === 'VP8L') {
    // Lossless: 0x2F signature then packed 14-bit (width - 1), 14-bit (height - 1).
    if (bytes.length < 25) return null;
    if (bytes[20] !== 0x2f) return null;
    const bits = bytes.readUInt32LE(21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    if (width < 1 || height < 1 || width > 100000 || height > 100000) return null;
    return { width, height, format: 'webp' };
  }
  if (chunk === 'VP8 ') {
    // Lossy: 3-byte frame tag, start code 9D 01 2A, then 14-bit LE width/height.
    if (bytes.length < 30) return null;
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    const width = bytes.readUInt16LE(26) & 0x3fff;
    const height = bytes.readUInt16LE(28) & 0x3fff;
    if (width < 1 || height < 1 || width > 100000 || height > 100000) return null;
    return { width, height, format: 'webp' };
  }
  return null;
}

// Returns { width, height, format } or null when unknown/unparseable.
// Fail-open: callers preserve images they cannot measure.
export function getImageDimensions(part) {
  if (!part || typeof part !== 'object') return null;
  const bytes = decodeHeaderBytes(part.data);
  if (!bytes) return null;
  return pngDimensions(bytes) || jpegDimensions(bytes) || gifDimensions(bytes) || webpDimensions(bytes);
}

export function isOversizedDimensions(dims, limit = MAX_IMAGE_DIMENSION) {
  if (!dims || typeof dims !== 'object') return false;
  const { width, height } = dims;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return false;
  return width > limit || height > limit;
}

export function removalMarker(dims, part) {
  const size = dims ? `${dims.width}x${dims.height}` : 'unknown size';
  const kind = dims?.format === 'png' ? 'PNG' : dims?.format === 'jpeg' ? 'JPEG' : 'screenshot';
  void part;
  return (
    `[Computer Use ${kind} screenshot removed: ${size} exceeds the ${MAX_IMAGE_DIMENSION}px ` +
    `provider limit. History was normalized for this request only; session logs are unchanged. ` +
    `Take a new observation before acting; stale coordinates are invalid.]`
  );
}

// Marker for a dropped NON-CU image: downscaling was unavailable or failed,
// so removal is the last resort that keeps the provider request alive.
export function attachmentMarker(dims, part) {
  const size = dims ? `${dims.width}x${dims.height}` : 'unknown size';
  const kind =
    dims?.format === 'png'
      ? 'PNG'
      : dims?.format === 'jpeg'
        ? 'JPEG'
        : dims?.format === 'gif'
          ? 'GIF'
          : dims?.format === 'webp'
            ? 'WebP'
            : 'image';
  void part;
  return (
    `[Attached ${kind} image removed: ${size} exceeds the ${MAX_IMAGE_DIMENSION}px ` +
    `provider limit and automatic downscaling was unavailable or failed. ` +
    `History was normalized for this request only; session logs are unchanged. ` +
    `Reattach a smaller version of the image if it is still needed.]`
  );
}

// Full provider-context normalization for ANY image above the limit.
// Computer Use tool results are dropped (frame safety, see removalMarker).
// Every other oversized image is downscaled in place when options.resizeImage
// (engine photon resizeImage) succeeds and its output measures within the
// limit, else dropped with attachmentMarker. Images at or below the limit,
// and images whose dimensions cannot be measured, are never touched.
// Input is never mutated. Resolves to
// { messages, dropped, resized, droppedDetails, resizedDetails }.
export async function normalizeContextImagesWithReport(messages, options = {}) {
  const limit =
    Number.isSafeInteger(options.limit) && options.limit > 0 ? options.limit : MAX_IMAGE_DIMENSION;
  const resizeImage = typeof options.resizeImage === 'function' ? options.resizeImage : null;
  const empty = { messages, dropped: 0, resized: 0, droppedDetails: [], resizedDetails: [] };
  if (!Array.isArray(messages)) return empty;
  const droppedDetails = [];
  const resizedDetails = [];
  let changed = false;
  const out = [];
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    const content = message?.content;
    if (!message || typeof message !== 'object' || !Array.isArray(content)) {
      out.push(message);
      continue;
    }
    const computerUse = isComputerUseToolResult(message);
    let nextContent = null;
    for (let partIndex = 0; partIndex < content.length; partIndex += 1) {
      const part = content[partIndex];
      if (!part || typeof part !== 'object' || part.type !== 'image') continue;
      const dims = getImageDimensions(part);
      if (!dims || !isOversizedDimensions(dims, limit)) continue;
      if (nextContent === null) nextContent = content.slice();
      if (computerUse) {
        droppedDetails.push({
          messageIndex,
          partIndex,
          toolCallId: message.toolCallId ?? null,
          toolName: message.toolName ?? toolActionOf(message) ?? null,
          width: dims.width,
          height: dims.height,
          format: dims.format,
        });
        nextContent[partIndex] = { type: 'text', text: removalMarker(dims, part) };
        continue;
      }
      let resized = null;
      if (resizeImage) {
        try {
          resized = await resizeImage({ type: 'image', data: part.data, mimeType: part.mimeType });
        } catch {
          resized = null;
        }
      }
      // Trust but verify: the replacement only ships when it measures
      // within the limit, otherwise the request would still fail.
      const outputDims =
        resized && typeof resized.data === 'string' && resized.data.length > 0
          ? getImageDimensions({ data: resized.data })
          : null;
      if (outputDims && !isOversizedDimensions(outputDims, limit)) {
        resizedDetails.push({
          messageIndex,
          partIndex,
          width: dims.width,
          height: dims.height,
          format: dims.format,
          outputWidth: outputDims.width,
          outputHeight: outputDims.height,
          outputMimeType:
            typeof resized.mimeType === 'string' && resized.mimeType ? resized.mimeType : part.mimeType,
        });
        nextContent[partIndex] = {
          ...part,
          data: resized.data,
          mimeType:
            typeof resized.mimeType === 'string' && resized.mimeType ? resized.mimeType : part.mimeType,
        };
      } else {
        droppedDetails.push({
          messageIndex,
          partIndex,
          toolCallId: message.toolCallId ?? null,
          toolName: message.toolName ?? null,
          width: dims.width,
          height: dims.height,
          format: dims.format,
        });
        nextContent[partIndex] = { type: 'text', text: attachmentMarker(dims, part) };
      }
    }
    if (nextContent === null) {
      out.push(message);
      continue;
    }
    changed = true;
    out.push({ ...message, content: nextContent });
  }
  if (!changed) return empty;
  return { messages: out, dropped: droppedDetails.length, resized: resizedDetails.length, droppedDetails, resizedDetails };
}
