# Computer Use historical image safety

> **Beta.8 update:** the context hook now protects every provider-bound image. Computer Use screenshots over 2000 px are still dropped, because resizing would invalidate frame coordinates. Other oversized images, including user attachments, are downscaled with the engine image resizer; they are dropped with a marker only when resizing is unavailable or fails. Evidence: `test-results/beta8-image-400/`. The sections below are historical.

## Problem
Anthropic rejects images with any dimension above 2000px (`provider 400` on
`messages.N.content.M.image.source.base64.data`). Codex tolerates them, so
sessions with many large screenshots keep working there but fail on Opus.
The native worker now caps NEW captures at both dims <= 2000
(`runtime/computer-use-worker.ps1`: `MaxImageDimension = 2000`,
`Get-CaptureSize`), but oversized HISTORICAL screenshots persist in resumed
provider context and still block resume.

## Decision: transient drop, never resize, never rewrite logs
- Resizing historical pixels without updating the stored frame
  (`frame.width/height/bounds`, `frameId` coordinate space) would silently
  invalidate every coordinate replayed from that frame. Frame safety wins:
  drop the oversized image part and force a fresh observation.
- Session logs on disk are user history: never edited. Normalization applies
  only to in-memory provider-bound copies.
- Scope is Computer Use only (`toolResult` with `toolName`/`details.action`
  `computer_observe` / `computer_act`, plus any future `computer_*` tool).
  User images and non-CU tool results pass through untouched, even if large.

## What was built (this worktree, owned files only)
- `runtime/computer-use-image-safety.mjs` (new, dependency-free, no imports):
  header-only PNG IHDR / JPEG SOF0-SOF3 inspection: raw input is sliced to a 128 KiB prefix BEFORE whitespace strip/validate/decode, so multi-MB tails cost nothing; decoded window is the first 64 KiB,
  `isComputerUseToolResult`, `getImageDimensions`, `isOversizedDimensions`,
  `filterComputerUseImages(messages)` returning a new array (untouched
  messages keep reference, changed results are shallow copies with each
  oversized image replaced in place by an explicit text marker),
  `filterComputerUseImagesWithReport(messages)` returning
  `{ messages, dropped, droppedDetails }`, `removalMarker`,
  `MAX_IMAGE_DIMENSION = 2000`.
- `test/computer-use-image-safety.test.mjs` (new, 9 tests, `node --test`):
  JPEG/PNG landscape/portrait, small kept, large dropped with marker and no
  base64 remnant, boundary 2000 kept / 2001 dropped, bad data fail-open,
  non-CU (user + other tool) unaffected, mixed content, input never mutated.
- This doc. Main extension, PS worker, deps, and engine were NOT edited.

## Engine evidence (installed 0.9.5 engine, read-only inspection)
- Extension events include `context` (`{ type, messages: AgentMessage[] }`,
  handler may return `{ messages }`, applied via `structuredClone` before
  each LLM call) and `before_provider_request` (`{ type, payload }`,
  provider-shaped body, replacement returned directly).
- `ImageContent` is `{ type: "image", data: base64, mimeType }` on
  `UserMessage.content` and `ToolResultMessage.content`; the Anthropic
  provider maps it to `{ type: "image", source: { type: "base64",
  media_type, data } }`, matching the reported error path.
- The engine has NO native safe image-resize helper (only a `blockImages`
  text-substitution path), so a local header-sniff + drop filter is the
  correct layer. No foreign runtime imports were used; the module uses only
  the `Buffer` global the existing extension already relies on.

## Recommended hook for root (tiny, in `runtime/studio-computer-use-extension.mjs`)
Root owns that file. Suggested insertion inside `studioComputerUse(pi)`,
next to the existing `pi.on('agent_start', ...)` registrations:

```js
pi.on('context', async (event) => {
  try {
    const { filterComputerUseImagesWithReport } = await import('./computer-use-image-safety.mjs');
    const report = filterComputerUseImagesWithReport(event.messages);
    if (report.dropped > 0) return { messages: report.messages };
  } catch { /* fail-open: never block the provider call */ }
  return undefined;
});
```

Notes: dynamic `import` keeps startup cost zero when unused; fail-open
`catch` guarantees the hook can never break non-CU flows; returning
`undefined` leaves context unchanged. Prefer `context` over
`before_provider_request` (provider-agnostic `AgentMessage[]`, runs before
`convertToLlm`, covers resume/compact/fork paths that all funnel through
`emitContext`). Root verifies against the real engine later.

## Marker contract
`[Computer Use JPEG screenshot removed: 3840x2160 exceeds the 2000px
provider limit. History was normalized for this request only; session logs
are unchanged. Take a new observation before acting; stale coordinates are
invalid.]` Tool IDs (`toolCallId`, `toolName`), `details`, sibling text
(frame metadata), and result `isError` semantics are preserved.

## Validation
- `node --test test/computer-use-image-safety.test.mjs`: 9 pass.
- Extra REPL check: APP1+COM+DQT-prefixed progressive JPEG (SOF2) parses;
  GIF/unknown returns null (preserved); boundary semantics hold.
- Known limit: SOF beyond the 64 KiB sniff window parses as unknown and is
  preserved fail-open (rare; real screenshots place SOF in the first KBs).
  If it ever matters, raise `HEADER_BYTES`, never rescale.

## Non-goals
No desktop capture/input, no session-file migration, no provider-payload
rewriting, no new dependencies, no engine or worker edits.
