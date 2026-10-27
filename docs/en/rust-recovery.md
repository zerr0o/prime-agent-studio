# Experimental Rust restart recovery

[Français](../rust-recovery.md) · [Native runtime](rust-runtime.md) · [Studio tools bridge](rust-studio-tools.md)

This dependent proposal restores interrupted Rust runs after a Studio restart. It builds on the native runtime and its tools bridge. It does not resume unrelated historical goals or replay the original user prompt. The core runtime's no-recovery restriction is replaced by this layer; the other unsupported-feature guards remain.

Before admitting a prompt, Studio records the run in a private `goal-recovery.json` journal inside its data directory. On restart it attempts each eligible recorded run once, using a visible service continuation. It rechecks the saved session, project, goal identity, original budget, idle queue and current model/reasoning settings. Stopped/completed runs, removed projects, archived or child sessions, cleared goals and inactive/exhausted goals are excluded. A corrupt journal fails closed. Shutdown drains metadata writes and session storage before returning.

Native creation can acknowledge a large saved session before adoption restores its goal. Recovery first makes a worker-routed read, then waits at most 30 seconds for the canonical empty placeholder to settle. A changed/paused goal or busy session is rejected immediately, rather than waited away. Eligibility is checked again just before the continuation prompt. Goal counters are not reset, and restart recovery grants no new authorization. The continuation instructs the agent to reconcile in-flight work and avoid repeating completed or ambiguous side effects.

Runs without a goal use an explicit native null-goal check. A cleared-goal tombstone cannot be treated as an ordinary interrupted run. Stop suppresses the journal entry before cancellation; a simultaneous user admission cannot create a duplicate recovered session. Unconfirmed effects are not blindly retried.

Run `node --test test/goal-recovery.test.mjs test/server-goal-recovery.test.mjs test/rust-goal-recovery.test.mjs` for journal, HTTP lifecycle and native-adapter coverage. `node scripts/rust-recovery-canary.mjs ABSOLUTE_BINARY_PATH` checks adoption of 4,000 synthetic history rows in a real isolated daemon, intercepting the prompt before inference and checking unchanged counters. The latter requires a compatible native executable and is not a model-turn test.

This proposal remains draft. There is no fresh Windows lease-drain/cold-reopen or real-provider proof for this candidate. Passing isolated adapter tests does not establish that the current public binary safely recovers a Windows saved session, that child ownership is end-to-end verified, or that all Studio extensions work in Rust.
