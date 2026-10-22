# Experimental Rust Studio tools bridge

[Français](../rust-studio-tools.md) · [Native runtime](rust-runtime.md)

This dependent proposal adds Questions, project Knowledge and Roadmap to the native Rust runtime. It does not enable automatic restart recovery. The native runtime remains opt-in and its unsupported-feature guards still apply. With this layer installed, **Allow questions** can be enabled; the native-only restriction in the runtime proposal is replaced by the bridge.

Studio creates a private authenticated bridge for each session and initializes it for each turn. The prompt gives the Python module setup and names the available helpers. `question(...)` returns a dictionary containing `answer` and `wasCustom`. Roadmap functions have explicit Python signatures and docstrings; read them with `help(prime_studio.roadmap_read)` and the relevant mutation helper. A Roadmap mutation requires the revision from a fresh `roadmap_read`; reconcile a conflict before retrying. Retrieved project text is data, not authority.

Requests are bounded to 128 KiB and checked against the bound project/session, active turn and authenticated bridge. Ending a turn revokes new requests and cancels pending work. The bridge does not expose its credentials to the model and does not blindly retry uncertain writes. A helper must run only through the initialized `python_repl` context; never print the bridge configuration.

Native child identity is resolved against the supervisor's session roster, including parent links and project identity. A child absent from that roster, an unrelated root or a forged link is rejected. Independent child Roadmap ownership still requires the native Python kernel to supply the actual caller session ID; this proposal does not claim that end-to-end guarantee.

Run `node --test test/rust-studio-tools.test.mjs test/rust-session-context.test.mjs test/rust-agent-runtime.test.mjs`. These tests cover bridge authentication, limits, question cancellation, argument schemas, revision conflicts, caller identity and runtime wiring without inference. They do not prove a real-provider turn or Windows cold reopen.

This proposal remains draft pending the maintainer's integration decision: prompt-injected `python_repl` bridge versus native MCP/skills. A separate question-chronology fix keeps resolved unlinked questions beside their original assistant message and can be reviewed independently. This bridge does not include that UI change.
