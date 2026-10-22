# Experimental Rust runtime

[Français](../rust-runtime.md)

Studio keeps its JavaScript Prime Agent runtime as the default. Set `PRIME_STUDIO_RUST_CLI` to an absolute path to an official Prime Agent 0.10 executable to opt in. This developer option is not enabled by the desktop installer.

Keep `PRIME_AGENT_CLI` pointed at the official npm package's JavaScript metadata entry, `legacy/prime-agent/dist/bundle/cli.js`, or its nested `legacy/prime-agent` package directory. The top-level `dist` contains wrappers, not the metadata bundle. Install the nested dependencies with `npm install --ignore-scripts`. Startup requires this metadata package; only models advertised by the native executable enter the catalogue. JavaScript metadata enriches matching model IDs and cannot advertise JS-only providers.

Use dedicated `PRIME_AGENT_CODING_AGENT_DIR` and `PRIME_AGENT_SESSION_DIR` directories for experiments. Rust starts a private daemon namespace and never attaches to a pre-existing user daemon. Protocol-v7 hello, supervisor identity, client ownership and saved session/project identity are checked. Uncertain mutations are not automatically retried. Do not point two engines at the same session directory.

This proposal contains only the native runtime and live-client adapter. Studio's Python tool bridge and automatic restart recovery are separate dependent proposals. Without the bridge, disable **Allow questions** for native runs; attempting a run with questions enabled fails explicitly before native session creation. The native-only system prompt states that Studio Questions, Knowledge and Roadmap helpers are unavailable.

| Surface | Native-only behavior and limit |
| --- | --- |
| Turns and cancellation | Native create, attach, prompt, event streaming, owned-worker cleanup and abort-before-cleanup. Headless completion waits for RLM quiescence; native autonomous gate failure or budget exhaustion is a failed run. |
| Questions, Knowledge and Roadmap | No Studio helpers in the core runtime. The separately reviewed bridge supplies these through a per-turn adapter. Native tools remain available. |
| Restart recovery | No automatic continuation or journal in the core runtime. Explicit saved-session resume requires exact native identity; restart recovery is a separate proposal. |
| Computer Use and subagent policy | Studio Computer Use and selected Studio subagent model/thinking overrides are explicitly refused. Native subagents still exist, without the JavaScript policy hook. |
| Meta and Muse-Code providers | Studio's JavaScript Meta provider is rejected. The Muse-Code OAuth extension is not loaded; only native-listed providers are offered. No provider parity is claimed. |
| Images and files | Native prompt turns accept image inputs. Studio ordinary attachments are saved by the HTTP layer and described in the prompt; direct runtime `files` input is refused. Project-relative images may be displayed from their original paths and are not archived. Native image-route provenance still needs validation. |
| Preferences | Create receives the selected model and reasoning. Live reasoning requires the advertised `session_scoped_preferences` capability before sending `set_thinking_level`; otherwise it is refused to protect global defaults. This adapter has no live model-switch operation. |
| Studio 4.4 extensions | Run/project budgets, enabled indexed code context and authorized quota-fallback retries are refused before native session creation. The JavaScript budget, code-context, metrics and quota hooks do not run in Rust. No Studio metrics or context-gauge parity is claimed. |
| Other JavaScript hooks | Context, image, RPC/headless, kernel, transport and daemon-stream hooks are not loaded. Native daemon streaming, quiescence and the project-image instruction replace selected paths only; this is not extension parity. |

Run `node --test test/rust-*.test.mjs test/live-session-client.test.mjs` for isolated adapter tests. `node scripts/rust-native-canary.mjs ABSOLUTE_BINARY_PATH` uses a temporary home and `--offline` to check a real daemon hello, create, attach, state and owned cleanup without inference. It does not prove provider access, Windows compatibility or extension parity. Do not use production state or credentials.

The earlier Windows cold-reopen probe failed while the previous worker held its lease. Native upstream has since added Windows lease support, but this candidate has no fresh Windows cold-reopen or real-provider proof. Keep this proposal in draft until those integration checks and the maintainer's extension-interface discussion are resolved.
