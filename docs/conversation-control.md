# Ordinary conversation control

The session menu offers **Copy conversation ID** for saved conversations. It copies
the saved ID of the selected menu target, not the active run ID or message history.
Draft conversations have no saved ID yet.

Studio's existing native JavaScript extension integration also provides:

- `conversations_projects`: list registered projects and their public IDs.
- `conversations_list`: list saved conversations in one registered project.
- `conversations_inspect`: passive metadata and the current Studio run ID, if any.
- `conversations_history`: bounded message excerpts, without full tool payloads or thinking.
- `conversations_create`: start an independent ordinary conversation in a registered project.
- `conversations_send`: send to an existing conversation; default mode is `follow_up`, with explicit `steer` available.
- `conversations_continue`: resume the exact saved conversation ID.
- `conversations_interrupt`: stop only the exact current run identified by `expectedRunId`.

These are ordinary chats at the same level, not child agents. Tools are available
only to active ordinary Studio root callers. Child agents cannot use this owner-wide
capability. Project and conversation IDs identify registered resources; an ID alone
is not authorization. No filesystem paths, public API credentials or arbitrary API
routes are accepted as tool arguments.

The tools reuse the existing authenticated local native-extension socket and public
API service consumers. The public HTTP API does not need to be enabled. Its token
and scope checks are unchanged. Computer Use permissions are not granted by these
tools. Caller authority is checked again immediately before transcript reads and
effects, including after asynchronous project lookups.

Inspecting a saved conversation does not resume it or read its transcript. `saved`
means no active Studio run was observed; it does not prove the native agent is idle.
Create/send/continue acceptance does not prove completion. Inspect the target and
read its results separately. Interrupt can discard queued input; it does not delete
or archive the conversation.

Provide a stable `requestId` for create/send/continue. Existing in-memory request
deduplication is not crash-safe exactly-once delivery. A lost response is reported
as `delivery_uncertain` / delivery `UNKNOWN`. Reconcile the request and target; do
not automatically replay the effect.

History defaults to 20 messages, with a maximum page size of 50. Text excerpts are
limited to 1,500 characters per message and 16,000 per page. At most three compact
tool metadata entries are included per message. Pagination and truncation are
explicit in the response.

This integration targets Studio's existing JavaScript native extension runtime.
It does not install a Rust daemon bridge or provide the Python `prime_studio`
helper namespace used by other runtime integrations.
