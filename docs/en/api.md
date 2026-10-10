# Public API v1

**English** · [Français](../api.md) · [← Back to README](../../README.md)

Public API v1 is a generic, documented contract for driving a Studio from an external application: read projects and conversations, start runs, edit roadmaps, and download linked files. Each Studio answers directly with its own address and token; there is no coordinator, no shared queue, and no machine-to-machine relay.

The exact contract reference is [openapi-v1.json](../api/openapi-v1.json), generated from `lib/public-api-contract.mjs`. This guide describes it; when in doubt, the generated JSON file wins.

## Interactive documentation and tests

Open **Preferences → API → Interactive documentation**, or `/api-docs` on the selected Studio (default [http://127.0.0.1:3088/api-docs](http://127.0.0.1:3088/api-docs)). The contract served at `/openapi-v1.json` is generated from the same source as this reference, even while the API is disabled.

Each operation has a form: parameters, JSON body, required scopes, a cURL command, and a manual test with status, headers and response. A `POST` request requires explicit confirmation: effects are real, including roadmap changes and agent execution. No test runs automatically.

The token is entered on the page, kept in memory only, and never inserted into the cURL command. Tests target only the page’s origin; open another Studio’s page to test that instance. Remote documentation keeps the existing PIN/cookie protection; v1 calls still require their own token. No additional CORS access is enabled.

Previews are limited to 64 KiB and 30 seconds. SSE streams appear progressively; stopping reception does not stop the run. Download tests suggest a small HTTP range and do not load the whole file into memory. Use a download client to retrieve the complete file.

## Principles

- The API is **off by default**. It is enabled in the Studio Preferences, without automatically enabling LAN or any public listener.
- The v1 API is a generic facade over the existing services, separate from the internal routes. A v1 token never opens the old internal routes, and old Studios without v1 report incompatibility with no automatic fallback.
- The client explicitly picks the machine and the local project for each call. A project ID stays local to its machine; only the `syncId` recognizes the same project across machines.
- No read ever triggers an action: viewing a run, a roadmap, or messages starts no agent or task, and checks off no step.
- No cross-origin browser support in v1: clients are direct applications or scripts, on the existing local or encrypted network.

## Authentication and scopes

- Every request sends `Authorization: Bearer <token>`. No secret goes in the URL, a cookie, an SSE query string, or the logs.
- Tokens are created and revoked locally in the Studio, with authorized projects and an expiry. Token management and the switch stay local to the PC: never synced, never exported, and no public route creates a token or raises its rights.
- Turning the API off closes its streams and downloads and blocks new requests; revoking a token only cuts that token. Runs keep going and stop only on explicit action.

| Scope            | Access                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `read`           | Machine, authorized projects, models, conversations, runs, events, and roadmaps for reading |
| `runs:write`     | Start and stop a run, send a message, answer an interaction                                 |
| `roadmaps:write` | Edit plans, steps, backlog, and links, with revision control                                |
| `files:download` | Download the bytes of files linked to authorized conversations                              |

Every operation requires `read`, plus the write scope shown in the OpenAPI reference. Starting roadmap work that edits its links requires both write scopes.

## Machines, projects, and models

- `GET /api/v1/machine` returns `{ apiVersion: "v1", studioVersion, machineId, name, capabilities, idempotency }`, with `idempotency: { retentionSeconds: 3600, persistent: false }`.
- `GET /api/v1/projects` returns the authorized projects as a page `{ items, nextOffset }`, each project carrying `{ id, name, syncId, exists, machineId }`.
- `GET /api/v1/models` returns the engine catalog as a page `{ items, nextOffset }`, each model carrying `{ id, name?, provider?, input?, reasoning?, thinkingLevels?, contextWindow?, availability? }` (`thinkingLevels` mirrors the native levels; no `thinking` field on the catalog, unlike run requests).
- Paginated lists accept `limit` (1 to 200, default 50) and `offset` (default 0).

## Conversations and runs

- `GET /api/v1/projects/{projectId}/sessions` lists conversations `{ id, title, createdAt?, updatedAt?, model?, thinking?, machineId, projectId }`.
- `GET /api/v1/sessions/{sessionId}/messages` returns `{ sessionId, projectId, machineId, items, nextOffset }`, each message keeping its persisted projection (`role`, `text`, tools, and metadata-only attachments: `type`, `id`, `name`, `size`, `mimeType`).
- `POST /api/v1/projects/{projectId}/runs` starts a run with `{ requestId, message, sessionId?, model?, thinking?, allowQuestions? }` and answers `201`. `requestId` (16 to 100 `[A-Za-z0-9_-]` characters) and `message` (at most 200,000 characters) are required. V1 accepts no initial attachment uploads, no inline images, and no administration options: images produced during the run and linked as local Markdown references stay downloadable through linked files.
- `GET /api/v1/runs` and `GET /api/v1/runs/{runId}` expose `{ id, sessionId, projectId, machineId, status, startedAt, endedAt, error, model, thinking, allowQuestions, interactions, requestId? }`. A run expired from memory is consulted through the kept conversation.
- `GET /api/v1/runs/{runId}/events` streams events as `text/event-stream` (`id: <seq>` + `data: <event>`, `: heartbeat` comments). Resume with the `Last-Event-ID` header or the `?after=` cursor: newer buffered events replay, preceded by a `replay_truncated` marker when the buffer moved on, and the stream ends when the run finishes.
- `POST /api/v1/runs/{runId}/stop` requests a stop with a mandatory empty JSON `{}` body and answers `{ stopped: true, ...run }`.
- `POST /api/v1/runs/{runId}/interactions` answers with `{ id, response }`, where `response` is exactly `{ cancelled: true }`, `{ confirmed: boolean }`, or `{ value: string }`.
- `POST /api/v1/sessions/{sessionId}/messages` sends `{ requestId, mode: steer | follow_up, message }` to the live run of the conversation.

## Roadmaps

- `GET /api/v1/projects/{projectId}/roadmap` returns `{ machineId, projectId, roadmap }`, a local copy matching the current document minus its internal path. Read it before any mutation or launch: `expectedRevision` applies to that local copy, not a global lock.
- `POST /api/v1/projects/{projectId}/roadmap/mutations` applies one closed action with `{ action, expectedRevision, ...native fields }`, without `cwd` or actor (the server adds the path internally). The exact action and field list lives in the contract; any revision conflict returns `409` with `currentRevision`.
- `POST /api/v1/projects/{projectId}/roadmap/work` starts work **on this machine** from a selection, with exactly `{ requestId, expectedRevision, targets, instructions?, sessionId?, model?, thinking? }`, and answers `201`. The `{ accepted, queued, requestId, run, sessionId, roadmap?, linkWarning?, machineId, projectId }` reply reuses the existing native launch; `roadmap` there is the bare document and `run` its full projection.
- A finished run never automatically checks off a roadmap step.

## Linked files

- `GET /api/v1/sessions/{sessionId}/files` lists references proven in the authorized persisted history, as a page of `{ id, name, size, available, machineId, originMachineId, kind }` entries, with `kind: link | attachment`. Proof is tracked **per reference**: only links recorded from real native events on this machine carry a populated `originMachineId`. An old or synced reference without a local receipt stays `available: false`, `size: null`, `originMachineId: null`, and needs a newly emitted local reference; never a session-wide origin grant, and no substitution from a same-named file on another machine. Inline images stay metadata-only; stored attachment blobs and generated images linked as local Markdown are downloadable.
- `GET /api/v1/sessions/{sessionId}/files/{fileId}` downloads the bytes served by the machine holding the file, streamed with no application cap. `HEAD` on the same path returns metadata without the bytes (`Range` ignored). Responses: `200` bytes, `206` for one valid range (`Content-Range`), `416` for an unsatisfiable, malformed, or multiple range (`Content-Range: bytes */size`), `304` when `If-None-Match`/`If-Modified-Since` matches, `412` when `If-Match`/`If-Unmodified-Since` fails, `404` for an unknown or missing file, `409` without local provenance (`origin_unknown`). Headers: `Accept-Ranges: bytes`, `Content-Length`, `ETag`, `Last-Modified`, `Content-Disposition`. `304`/`412`/`416` carry no JSON body, unlike the `400`/`404`/`409` error objects. Preconditions check the file version at the start of each request. They do not freeze bytes during a transfer: wait for the producer to finish writing before downloading. A stale `If-Range` re-downloads as `200` instead of mixing two versions.
- Resume uses a single HTTP range at a time (`206`, otherwise `416`), with `Content-Length`, `Accept-Ranges: bytes`, and version validation: a stale `If-Range` precondition re-downloads with `200` instead of mixing two versions, and `If-Match` fails instead of resuming a changed file.

## Idempotency and retries

- Starts (`createRun`, `roadmapWork`, `sendMessage`) require a `requestId`: the same key with the same content on the same machine returns the same result inside the documented one-hour window; different content under the same key returns a conflict.
- Keys are shared across tokens for the same operation and local project (the same session for messages). Use random UUIDs, not short counters. Admitted failures are cached too because a failed reply can hide accepted work. Inspect the run/conversation before deciding on a new request; do not rotate keys blindly.
- The idempotency cache lives in memory for one hour and does not survive restarts: **never retry automatically on another machine after a timeout**, because the first machine may already be working. Offline means unknown state, not confirmed stop.
- A roadmap conflict (`409`, `currentRevision`) resolves by rereading the roadmap and reapplying the change on the new revision.

## Two Studios: select, run, follow, download

1. Call `/machine` and `/projects` on A and B with their own tokens. Match a non-null explicit `syncId`, never the folder or display name; keep each local `id` with its machine.
2. Choose B. Read B's `/projects/{projectId}/roadmap`, select an existing `planId`, and keep B's `roadmap.revision`.
3. Send `POST /projects/{projectId}/roadmap/work` to B with a new random `requestId`, `expectedRevision`, and `targets: [{"kind":"plan","planId":"…"}]`. This starts an agent and can incur provider costs. Use both write scopes. It does not reserve or start anything on A.
4. Follow B's `/runs/{runId}/events`. Answer interactions only after an explicit decision; never auto-confirm them. After the stream ends, read `/runs/{runId}` for its final status and `sessionId`.
5. List B's `/sessions/{sessionId}/files`. Choose an available file and use its opaque ID for `HEAD` then `GET`. For a resumed download send `Range` with the saved `If-Match` ETag; append only a matching `206`, never a `200`. A disconnected B stays unknown: do not restart its work on A automatically.

The paths above use the `/api/v1` prefix. This minimal standard-library example discovers both instances without starting work or printing tokens. Set `STUDIO_A_URL`, `STUDIO_A_TOKEN`, `STUDIO_B_URL`, and `STUDIO_B_TOKEN` locally; do not commit their values.

```python
import json, os
from urllib.request import Request, urlopen

for name in ("A", "B"):
    base = os.environ[f"STUDIO_{name}_URL"].rstrip("/")
    headers = {"Authorization": "Bearer " + os.environ[f"STUDIO_{name}_TOKEN"]}
    def get(path):
        with urlopen(Request(base + "/api/v1" + path, headers=headers), timeout=20) as response:
            return json.load(response)
    machine = get("/machine")  # HTTP errors stop here: no fallback, no automatic retry.
    assert machine["apiVersion"] == "v1"
    offset = 0
    while offset is not None:
        page = get(f"/projects?limit=200&offset={offset}")
        for project in page["items"]:
            print(name, machine["machineId"], project["id"], project["syncId"])
        offset = page["nextOffset"]
```

## Errors

Errors follow `{ error, code, currentRevision? }`, with the matching HTTP status: `400` for an invalid request, `401` without a valid token, `403` without the required scope, `404` for an unknown, unauthorized, or expired resource, `409` for a revision or idempotency conflict, `405` for a wrong method, and `429` under load. Files add `origin_unknown`, `file_missing`, and `file_changed`.

## OpenAPI reference

The [openapi-v1.json](../api/openapi-v1.json) file is generated from `lib/public-api-contract.mjs` with `node scripts/public-api-openapi.mjs`, with the `http://127.0.0.1:{port}` base server (`port`: `3088` by default) and required scopes as `x-required-scopes` on each operation. The `test/public-api-contract.test.mjs` test checks file-to-generator equality, method and scope coverage, native-list closure of mutation actions, fully typed mutation schemas, and `x-required-scopes` derivation.
