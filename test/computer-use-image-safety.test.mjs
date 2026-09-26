import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_IMAGE_DIMENSION,
  attachmentMarker,
  getImageDimensions,
  isComputerUseToolResult,
  isOversizedDimensions,
  normalizeContextImagesWithReport,
} from '../runtime/computer-use-image-safety.mjs';

function pngBase64(width, height) {
  const buf = Buffer.alloc(33);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = 8; // bit depth
  buf[25] = 2; // color type
  buf[26] = 0;
  buf[27] = 0;
  buf[28] = 0;
  buf.writeUInt32BE(0, 29); // dummy CRC
  return buf.toString('base64');
}

function jpegBase64(width, height) {
  const bytes = [
    0xff,
    0xd8, // SOI
    0xff,
    0xe0,
    0x00,
    0x0a, // APP0, length 10
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00,
    0x01,
    0x02,
    0x00, // payload
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08, // SOF0, length 11, precision 8
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x01,
    0x01,
    0x11,
    0x00, // one component
    0xff,
    0xd9, // EOI
  ];
  return Buffer.from(bytes).toString('base64');
}

function cuResult({ toolName = 'computer_observe', toolCallId = 'call-1', parts }) {
  return {
    role: 'toolResult',
    toolCallId,
    toolName,
    content: parts,
    details: { action: toolName, frame: { frameId: 'f-1', width: 100, height: 100 } },
    isError: false,
    timestamp: 1,
  };
}

test('limit constant is 2000', () => {
  assert.equal(MAX_IMAGE_DIMENSION, 2000);
});

test('header inspection reads PNG landscape and portrait', () => {
  assert.deepEqual(getImageDimensions({ data: pngBase64(1280, 800) }), {
    width: 1280,
    height: 800,
    format: 'png',
  });
  assert.deepEqual(getImageDimensions({ data: jpegBase64(800, 1280) }), {
    width: 800,
    height: 1280,
    format: 'jpeg',
  });
});

test('boundary 2000x2000 is kept, 2001 on any side is oversized', () => {
  assert.equal(isOversizedDimensions({ width: 2000, height: 2000 }), false);
  assert.equal(isOversizedDimensions({ width: 2001, height: 100 }), true);
  assert.equal(isOversizedDimensions({ width: 100, height: 2001 }), true);
});

test('small CU images are preserved untouched', async () => {
  const msg = cuResult({
    parts: [
      { type: 'image', data: pngBase64(1280, 800), mimeType: 'image/png' },
      { type: 'text', text: JSON.stringify({ frame: { frameId: 'f-1' } }) },
    ],
  });
  const { messages: out } = await normalizeContextImagesWithReport([msg]);
  assert.equal(out[0], msg); // same reference, nothing copied
  assert.equal(out[0].content[0].data, pngBase64(1280, 800));
});

test('large PNG landscape CU screenshot is dropped with a take-new-observation marker', async () => {
  const data = pngBase64(3840, 2160);
  const msg = cuResult({
    toolName: 'computer_observe',
    parts: [
      { type: 'image', data, mimeType: 'image/png' },
      { type: 'text', text: JSON.stringify({ frame: { frameId: 'old' } }) },
    ],
  });
  const before = JSON.stringify(msg);
  const { messages, dropped, droppedDetails } = await normalizeContextImagesWithReport([msg]);
  assert.equal(dropped, 1);
  assert.equal(droppedDetails[0].width, 3840);
  assert.equal(droppedDetails[0].height, 2160);
  assert.equal(droppedDetails[0].toolName, 'computer_observe');
  const next = messages[0];
  assert.equal(next.toolCallId, 'call-1');
  assert.equal(next.toolName, 'computer_observe');
  assert.deepEqual(next.details, msg.details);
  assert.equal(next.content.length, 2);
  assert.equal(next.content[0].type, 'text');
  assert.match(next.content[0].text, /3840x2160/);
  assert.match(next.content[0].text, /Take a new observation/);
  assert.ok(!JSON.stringify(next).includes(data.slice(0, 32)), 'base64 must be gone');
  assert.equal(next.content[1].type, 'text'); // frame metadata text preserved
  assert.equal(JSON.stringify(msg), before); // input never mutated
});

test('large JPEG portrait CU screenshot via computer_act is dropped', async () => {
  const data = jpegBase64(2160, 3840);
  const msg = cuResult({
    toolName: 'computer_act',
    parts: [{ type: 'image', data, mimeType: 'image/jpeg' }],
  });
  const { messages: out } = await normalizeContextImagesWithReport([msg]);
  assert.equal(out[0].content.length, 1);
  assert.equal(out[0].content[0].type, 'text');
  assert.match(out[0].content[0].text, /2160x3840/);
  assert.match(out[0].content[0].text, /stale coordinates are invalid/);
  assert.equal(out[0].toolCallId, 'call-1');
});

test('bad base64 data in CU results is preserved fail-open', async () => {
  const msg = cuResult({
    parts: [{ type: 'image', data: '!!!not-base64!!!', mimeType: 'image/png' }],
  });
  const { messages: out } = await normalizeContextImagesWithReport([msg]);
  assert.equal(out[0], msg);
  const short = cuResult({ parts: [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }] });
  assert.equal((await normalizeContextImagesWithReport([short])).messages[0], short);
});

test('oversized non-CU images use attachment resizing, not CU removal', async () => {
  const big = pngBase64(3840, 2160);
  const userMsg = {
    role: 'user',
    content: [{ type: 'image', data: big, mimeType: 'image/png' }],
    timestamp: 1,
  };
  const otherTool = {
    role: 'toolResult',
    toolCallId: 'call-9',
    toolName: 'roadmap_read',
    content: [{ type: 'image', data: big, mimeType: 'image/png' }],
    isError: false,
    timestamp: 2,
  };
  const before = JSON.stringify([userMsg, otherTool]);
  const resized = pngBase64(1920, 1080);
  const report = await normalizeContextImagesWithReport([userMsg, otherTool], {
    resizeImage: async () => ({ data: resized, mimeType: 'image/png' }),
  });
  assert.equal(report.resized, 2);
  assert.equal(report.dropped, 0);
  for (const message of report.messages) assert.equal(message.content[0].data, resized);
  assert.equal(JSON.stringify([userMsg, otherTool]), before);
  assert.equal(isComputerUseToolResult(userMsg), false);
  assert.equal(isComputerUseToolResult(otherTool), false);
  assert.equal(isComputerUseToolResult(cuResult({ parts: [] })), true);
});

test('mixed and empty CU content keeps result semantics', async () => {
  const big = jpegBase64(3000, 100);
  const small = jpegBase64(100, 100);
  const msg = cuResult({
    parts: [
      { type: 'image', data: big, mimeType: 'image/jpeg' },
      { type: 'image', data: small, mimeType: 'image/jpeg' },
      { type: 'text', text: '{"executed":1}' },
    ],
  });
  const { messages: out } = await normalizeContextImagesWithReport([msg]);
  assert.equal(out[0].content[0].type, 'text');
  assert.equal(out[0].content[1].type, 'image');
  assert.equal(out[0].content[1].data, small);
  assert.equal(out[0].content[2].type, 'text');
  const empty = cuResult({ parts: [{ type: 'text', text: 'ok' }] });
  assert.equal((await normalizeContextImagesWithReport([empty])).messages[0], empty);
  assert.deepEqual((await normalizeContextImagesWithReport([])).messages, []);
  assert.deepEqual((await normalizeContextImagesWithReport(null)).messages, null);
});

test('multi-MB irrelevant tail is never scanned', async () => {
  const tail = 'A'.repeat(3 * 1024 * 1024); // 3M valid-alphabet chars, never decoded
  const big = pngBase64(3840, 2160) + tail;
  assert.deepEqual(getImageDimensions({ data: big }), {
    width: 3840,
    height: 2160,
    format: 'png',
  });
  const msg = cuResult({
    parts: [{ type: 'image', data: big, mimeType: 'image/png' }],
  });
  const { messages: out } = await normalizeContextImagesWithReport([msg]);
  assert.equal(out[0].content[0].type, 'text');
  assert.match(out[0].content[0].text, /3840x2160/);
  const small = cuResult({
    parts: [{ type: 'image', data: pngBase64(640, 480) + tail, mimeType: 'image/png' }],
  });
  assert.equal((await normalizeContextImagesWithReport([small])).messages[0], small);
});

test('JPEG with APP/COM/DQT headers before SOF parses within bounds', async () => {
  const bytes = [
    0xff,
    0xd8, // SOI
    0xff,
    0xe1,
    0x00,
    0x10,
    ...Array(14).fill(0x41), // APP1
    0xff,
    0xfe,
    0x00,
    0x06,
    0x48,
    0x65,
    0x6c,
    0x6c,
    0x6f, // COM "Hello"
    0xff,
    0xdb,
    0x00,
    0x05,
    0x01,
    0x02,
    0x03, // DQT
    0xff,
    0xc2,
    0x00,
    0x0b,
    0x08, // SOF2 progressive, length 11
    0x08,
    0x70,
    0x0a,
    0x00, // 2160 x 2560
    0x01,
    0x01,
    0x11,
    0x00,
    0xff,
    0xd9, // EOI
  ];
  const data = Buffer.from(bytes).toString('base64');
  assert.deepEqual(getImageDimensions({ data }), { width: 2560, height: 2160, format: 'jpeg' });
  const msg = cuResult({
    toolName: 'computer_act',
    parts: [{ type: 'image', data, mimeType: 'image/jpeg' }],
  });
  assert.equal((await normalizeContextImagesWithReport([msg])).messages[0].content[0].type, 'text');
});

test('whitespace-interspersed base64 prefix still parses', () => {
  const raw = pngBase64(1280, 800).replace(/(.{64})/g, '$1\n');
  assert.deepEqual(getImageDimensions({ data: raw }), {
    width: 1280,
    height: 800,
    format: 'png',
  });
});

function gifBase64(width, height) {
  const buf = Buffer.alloc(10);
  buf.write('GIF89a', 0, 'ascii');
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf.toString('base64');
}

function webpVp8xBase64(width, height) {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'ascii');
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8X', 12, 'ascii');
  buf.writeUIntLE(width - 1, 24, 3);
  buf.writeUIntLE(height - 1, 27, 3);
  return buf.toString('base64');
}

function webpVp8lBase64(width, height) {
  const buf = Buffer.alloc(25);
  buf.write('RIFF', 0, 'ascii');
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8L', 12, 'ascii');
  buf[20] = 0x2f;
  buf.writeUInt32LE(((height - 1) << 14) | (width - 1), 21);
  return buf.toString('base64');
}

function webpVp8Base64(width, height) {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'ascii');
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8 ', 12, 'ascii');
  buf[23] = 0x9d;
  buf[24] = 0x01;
  buf[25] = 0x2a;
  buf.writeUInt16LE(width, 26);
  buf.writeUInt16LE(height, 28);
  return buf.toString('base64');
}

function userMessage(parts) {
  return { role: 'user', content: parts, timestamp: 7 };
}

test('header inspection reads GIF and all WebP chunks', () => {
  assert.deepEqual(getImageDimensions({ data: gifBase64(1080, 4703) }), {
    width: 1080,
    height: 4703,
    format: 'gif',
  });
  assert.deepEqual(getImageDimensions({ data: webpVp8xBase64(1080, 4703) }), {
    width: 1080,
    height: 4703,
    format: 'webp',
  });
  assert.deepEqual(getImageDimensions({ data: webpVp8lBase64(500, 2500) }), {
    width: 500,
    height: 2500,
    format: 'webp',
  });
  assert.deepEqual(getImageDimensions({ data: webpVp8Base64(2500, 500) }), {
    width: 2500,
    height: 500,
    format: 'webp',
  });
  assert.equal(getImageDimensions({ data: Buffer.from('RIFF....WEBP????').toString('base64') }), null);
});

test('normalize downscales oversized user images and keeps small ones untouched', async () => {
  const big = pngBase64(1080, 4703);
  const small = pngBase64(640, 480);
  const resizedData = pngBase64(459, 2000);
  const seen = [];
  const stubResizer = async (img) => {
    seen.push(img);
    return { data: resizedData, mimeType: 'image/png' };
  };
  const user = userMessage([
    { type: 'image', data: big, mimeType: 'image/png' },
    { type: 'image', data: small, mimeType: 'image/png' },
    { type: 'text', text: 'look' },
  ]);
  const before = JSON.stringify(user);
  const report = await normalizeContextImagesWithReport([user], { resizeImage: stubResizer });
  assert.equal(report.dropped, 0);
  assert.equal(report.resized, 1);
  assert.equal(report.resizedDetails[0].width, 1080);
  assert.equal(report.resizedDetails[0].height, 4703);
  assert.equal(report.resizedDetails[0].outputWidth, 459);
  assert.equal(report.resizedDetails[0].outputHeight, 2000);
  assert.deepEqual(seen, [{ type: 'image', data: big, mimeType: 'image/png' }]);
  const next = report.messages[0];
  assert.equal(next.content[0].type, 'image');
  assert.equal(next.content[0].data, resizedData);
  assert.equal(next.content[0].mimeType, 'image/png');
  assert.equal(next.content[1].data, small); // small image bytes identical
  assert.equal(next.content[2].text, 'look');
  assert.ok(!JSON.stringify(next).includes(big.slice(0, 32)), 'oversized base64 must be gone');
  assert.equal(JSON.stringify(user), before); // input never mutated
});

test('normalize still drops Computer Use screenshots even with a resizer', async () => {
  let calls = 0;
  const stubResizer = async (img) => {
    calls += 1;
    return { data: pngBase64(100, 100), mimeType: 'image/png' };
  };
  const msg = cuResult({
    parts: [{ type: 'image', data: pngBase64(3840, 2160), mimeType: 'image/png' }],
  });
  const report = await normalizeContextImagesWithReport([msg], { resizeImage: stubResizer });
  assert.equal(calls, 0); // CU images never reach the resizer: frame safety wins
  assert.equal(report.dropped, 1);
  assert.equal(report.resized, 0);
  assert.equal(report.messages[0].content[0].type, 'text');
  assert.match(report.messages[0].content[0].text, /Take a new observation/);
});

test('normalize drops user images when no resizer, on resizer failure, or on oversized output', async () => {
  const big = jpegBase64(2160, 3840);
  const user = userMessage([{ type: 'image', data: big, mimeType: 'image/jpeg' }]);
  // No resizer at all.
  const fallback = await normalizeContextImagesWithReport([user]);
  assert.equal(fallback.dropped, 1);
  assert.equal(fallback.resized, 0);
  assert.equal(fallback.messages[0].content[0].type, 'text');
  assert.match(fallback.messages[0].content[0].text, /2160x3840/);
  assert.match(fallback.messages[0].content[0].text, /Reattach a smaller version/);
  assert.ok(!JSON.stringify(fallback.messages[0]).includes(big.slice(0, 32)));
  // Resizer throws.
  const throwing = await normalizeContextImagesWithReport([user], {
    resizeImage: async () => {
      throw new Error('photon missing');
    },
  });
  assert.equal(throwing.dropped, 1);
  assert.match(throwing.messages[0].content[0].text, /JPEG/);
  // Resizer returns null.
  const nullish = await normalizeContextImagesWithReport([user], {
    resizeImage: async () => null,
  });
  assert.equal(nullish.dropped, 1);
  // Resizer output still oversized: rejected, dropped instead.
  const stillBig = await normalizeContextImagesWithReport([user], {
    resizeImage: async () => ({ data: jpegBase64(3000, 3000), mimeType: 'image/jpeg' }),
  });
  assert.equal(stillBig.dropped, 1);
  assert.equal(stillBig.resized, 0);
  assert.match(stillBig.messages[0].content[0].text, /2160x3840/);
});

test('normalize accepts JPEG to PNG mime change and leaves unknown data fail-open', async () => {
  const big = jpegBase64(100, 2500);
  const out = pngBase64(80, 2000);
  const report = await normalizeContextImagesWithReport(
    [userMessage([{ type: 'image', data: big, mimeType: 'image/jpeg' }])],
    { resizeImage: async () => ({ data: out, mimeType: 'image/png' }) },
  );
  assert.equal(report.resized, 1);
  assert.equal(report.messages[0].content[0].mimeType, 'image/png');
  assert.equal(report.messages[0].content[0].data, out);
  const unknown = userMessage([{ type: 'image', data: '!!!not-base64!!!', mimeType: 'image/png' }]);
  const kept = await normalizeContextImagesWithReport([unknown], {
    resizeImage: async () => {
      throw new Error('must not be called');
    },
  });
  assert.equal(kept.messages[0], unknown);
  assert.equal(kept.dropped, 0);
  assert.equal(kept.resized, 0);
  assert.deepEqual(await normalizeContextImagesWithReport(null), {
    messages: null,
    dropped: 0,
    resized: 0,
    droppedDetails: [],
    resizedDetails: [],
  });
  assert.ok(attachmentMarker({ width: 1, height: 2, format: 'gif' }).includes('GIF'));
});
