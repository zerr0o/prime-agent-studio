# Dockable workspace — Studio 4.3.0

Status: first development slice, not a release. No dependency, frontend build step,
native installation, or engine restart is needed for these source changes.

## First slice

Desktop, above 1080 CSS pixels, opt-in through **Layout / Agencement** in the
header. Classic mode remains the default. A narrow viewport temporarily restores
classic/mobile behavior without overwriting the saved desktop layout.

Three real singleton panels:

- Conversation, including its composer and message renderer.
- Roadmap, including its existing document, editors and revision handling.
- Inspector, with its existing Session / Agents / Files tabs.

The project sidebar remains application navigation. Drag a panel tab onto the
center of a group to combine tabs, or onto an edge to split the group. Tabs can
be reordered. The Layout dialog provides a keyboard-operable movement form.
Splitters support pointer dragging and arrow keys, Home/End and Escape to cancel.
Closed panels can be reopened from the dialog. Reset restores the initial split.

## State and integration

`public/docking-layout.js` is a bounded immutable split/tab model. The registered
three panel IDs appear at most once. Empty nested groups collapse. Invalid stored
layouts fall back to classic mode; finite ratios are clamped to 15–85%.

`public/docking.js` owns only layout chrome. It moves the existing panel nodes;
it never clones the conversation, composer, listeners, stream or inspector.
Comment markers restore the classic DOM positions. Scroll positions are retained
for hidden panels; app auto-follow and unread handling use conversation visibility.
Panel size observation resizes the composer when a split changes without a window
resize. Scoped CSS supplies minimum pane sizes and narrow-container styling.

Roadmap's `setDocked({ visible, onOpen, onClose })` disables its page-level overlay
and modal behavior while embedded. `setDocked(null)` returns to classic behavior.
The shared editor remains a native dialog; a layout change does not discard its
draft. Inspector retains its original owner, polling and modal/mobile behavior.

`prime-studio.docking.layout` in localStorage contains only version 1, an `enabled`
flag, and the split/tab tree. It contains no session, message, credential or draft.
This is local per browser profile, not synced between machines or projects.
If browser storage is unavailable, the current layout still works in memory.

## Validation

- `node --test test/docking-layout.test.mjs`: model operations, malformed/bounded
  input, immutable results, close/reopen and deterministic operation sequences.
- `npm run test:docking`: the model checks and real Studio with isolated fixture services;
  interactions, stable DOM references, drafts/streams, classic/mobile transitions,
  keyboard operation and actual screenshots. No real model calls.
- `npm run check` and existing inspector/Roadmap/mobile/browser regression scripts.

Development evidence is under `.local/docking-4.3/`, not shipped as fixtures.
A separate Studio Lab may use fictional projects and a simulated engine for live
manual tests, without closing the installed Studio. Its data and port are separate.

## Following slices, not implemented here

1. Independent Session / Agents / Files views. First replace Inspector's single
   active-tab visibility contract; do not create three Inspector instances.
2. Native floating windows and multi-monitor layouts, with explicit ownership,
   focus, routing, safe screen bounds and lifecycle management.
3. Multiple simultaneous conversations, only after separating view state from
   the current single-conversation composer/run lifecycle.

A local prototype is not publication approval for 4.3.0.
