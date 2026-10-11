# Dockable workspace — Studio 4.3.0

Status: development preview, not a release. The first-slice sections below are
historical; the latest contract and acceptance appear at the end. No dependency,
frontend build step, native installation, or engine restart is needed.

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

## Approved prototype feedback — second development slice

The first slice is committed locally as `c120b6d`. This next slice is still under
integration; its browser acceptance results must be recorded before completion.

- Contiguous panels: no outer padding or pane gutters; a one-pixel divider retains
  a wider transparent pointer target and keyboard resizing.
- Right-click a tab or its bar for **Add Tab**. Shift+F10 and the ellipsis button
  offer the same menu. Singleton tools move to the chosen group; they are not cloned.
- Preferences uses the existing settings node, non-modal while docked. Child
  managers and confirmations remain native modals. The owner handles queued close
  events and classic/mobile restoration, not a patched browser dialog prototype.
- Several real conversation views share the existing runs map and one SSE source
  per run. One live editor follows explicit conversation focus. Background views
  render their own live messages and keep their own scroll position. They cannot
  send, answer questions or mutate a queue until focused. Shared Roadmap and
  Inspector follow that focused conversation only.
- Draft identity must distinguish two unsent conversations in the same project.
  History loads, uploads, POST results and new session events belong to their
  originating view/binding, even after focus changes. Closing a tab parks it;
  it does not stop the run or discard the draft.
- Geometry v2 accepts the first-slice v1 format. `conversation` is the legacy
  primary view; `conv:<id>` identifies another view. At most eight conversation
  panes are mounted, plus Roadmap, Inspector and Preferences. The conversation
  registry is separate from the geometry; its persisted records must be bounded.
- Named layouts store only panel kinds/counts, groups, active tabs and ratios.
  They contain neither conversation content nor session/run bindings. Loading
  reuses current views, parks any surplus, and creates empty slots if necessary;
  it never sends a prompt. Overwrite/delete require confirmation. Storage failure
  must be reported, not shown as a successful save.

The old third following-slice item above is now explicitly in scope. The native
floating-window and independent Inspector-view work remain separate.

Regression targets: two new drafts in one project; concurrent simulated runs;
late history/send/session events; attachments; close/reopen/reload; active-context
Roadmap attribution; actual queued dialog-close behavior; named layouts; keyboard
menus; read-only access; classic/mobile transitions. Fixtures must remain isolated
from the user's open Studio Lab and installed Studio.

## Revised follow-up — independent tools, composers and precise tab drops

The latest user feedback supersedes the second-slice presentation with one visible
composer and one Inspector panel:

- Session, Agents and Files are independent dock tabs. Their existing live roots
  return to the classic/mobile Inspector when docking is disabled.
- Add Tab stays short. New conversation opens a two-step project/conversation
  picker, including parked local drafts, instead of listing every view in a menu.
- Every conversation pane has a real full composer with its model and other
  controls. Clicking inside a pane focuses it before the original control action.
  Only the focused conversation tab carries the focus marker. Shared tools still
  follow a single focused context; background streams cannot steal it.
- A sidebar conversation can be dragged into the workspace without creating a run.
  Existing views are reused. Sidebar reordering keeps its existing pointer gesture.
- Tabs can be inserted directly between adjacent tabs, including empty trailing
  tab-bar space, with an insertion marker. Escape cancels the gesture.
- The main Preferences button always opens a modal popup. **Add Tab → Preferences**
  is the explicit dock-tab option. Both use the same live form; closing the popup
  restores an existing dock tab without discarding form state.
- **Close others** keeps the right-clicked tab, or the active tab when opened from
  the bar, and parks only its siblings in that group. Other groups, drafts,
  attachments and runs remain intact. The action is disabled for a one-tab group.
- Main **New conversation** and **Ctrl+N** rebind the focused conversation view,
  then reveal and focus its editor. They do not create another view. **Add Tab**
  remains the explicit route to another conversation slot.

Geometry is now canonical V3. V1/V2 `inspector` slots expand in place to
`session`, `agents`, `files`, with the former active Inspector becoming Session.
Named preset envelopes remain V1 and contain geometry only.

## Follow-up acceptance — 2026-10-11

The focused composer check and the complete workspace browser run pass on stable
production sources. The complete run records 102 checks, no deferred scenario,
10 simulated runs, no cancellation and no page error. It covers independent
composers/settings/drafts/attachments, concurrent and delayed events, tab gestures,
Close others, named layouts, both Preferences entrypoints and child dialogs,
Updates bootstrap, read-only access, viewport changes and classic/mobile restore.
Remote dialog coverage uses a real configured-but-disabled fixture; it opens no
network listener. An additional real-app check confirms that a Preferences popup
keeps its node and layout across desktop/narrow/desktop viewport changes.

- `npm test`: 1,242 passed, one skipped, no failure.
- `npm run check`: 2,206 translations, 17 documentation pairs and 286 links checked.
- Task-file Prettier checks and `git diff --check` pass.
- `npm run test:docking:workspace` enforces the full current contract by default.
- Five Close others handler checks and 15 isolated browser gesture/menu checks
  provide additional focused evidence.

Proofs and genuine screenshots are under `.local/docking-4.3/round2/`; final
command logs are under `round8/`. This validates the follow-up scope, not a release
or the separate native floating-window work. No new commit, push, publication,
installation, restart, real model call, or interaction with the user's open Lab
has been performed.
