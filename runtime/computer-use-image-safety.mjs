// Computer Use historical image safety: transient context-only normalization.
// Scope: drop ONLY oversized historical Computer Use screenshots (>2000px on
// any side) from provider-bound message copies. Never rewrites session logs,
// never touches user images or non-CU tool results, never rescales pixels
// (rescaling without coordinate metadata update would corrupt frame safety).
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
  if (slice.length < 32) return null;
  try {
    const buf = Buffer.from(slice, 'base64');
    if (!buf || buf.length < 24) return null;
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

// Returns { width, height, format } or null when unknown/unparseable.
// Fail-open: callers preserve images they cannot measure.
export function getImageDimensions(part) {
  if (!part || typeof part !== 'object') return null;
  const bytes = decodeHeaderBytes(part.data);
  if (!bytes) return null;
  return pngDimensions(bytes) || jpegDimensions(bytes);
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

// Report variant: { messages, dropped, droppedDetails }.
// messages is a NEW array; untouched messages keep their reference; changed
// tool results are shallow copies with image parts replaced in place by text
// markers. Input is never mutated.
export function filterComputerUseImagesWithReport(messages, options = {}) {
  const limit =
    Number.isSafeInteger(options.limit) && options.limit > 0 ? options.limit : MAX_IMAGE_DIMENSION;
  if (!Array.isArray(messages)) return { messages, dropped: 0, droppedDetails: [] };
  const droppedDetails = [];
  let changed = false;
  const out = messages.map((message, messageIndex) => {
    if (!isComputerUseToolResult(message)) return message;
    const content = message.content;
    if (!Array.isArray(content)) return message;
    let messageChanged = false;
    const nextContent = content.map((part, partIndex) => {
      if (!part || typeof part !== 'object' || part.type !== 'image') return part;
      const dims = getImageDimensions(part);
      if (!dims || !isOversizedDimensions(dims, limit)) return part;
      messageChanged = true;
      droppedDetails.push({
        messageIndex,
        partIndex,
        toolCallId: message.toolCallId ?? null,
        toolName: message.toolName ?? toolActionOf(message) ?? null,
        width: dims.width,
        height: dims.height,
        format: dims.format,
      });
      return { type: 'text', text: removalMarker(dims, part) };
    });
    if (!messageChanged) return message;
    changed = true;
    return { ...message, content: nextContent };
  });
  if (!changed) return { messages, dropped: 0, droppedDetails: [] };
  return { messages: out, dropped: droppedDetails.length, droppedDetails };
}

// Primary helper for the root hook: transient copy, same contract as above
// but returns the filtered array directly.
export function filterComputerUseImages(messages, options = {}) {
  return filterComputerUseImagesWithReport(messages, options).messages;
}
