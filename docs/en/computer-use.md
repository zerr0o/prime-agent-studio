# Computer Use

[Français](../computer-use.md) · [Documentation](../../README.md#documentation)

Computer Use is an expert mode for the **real Windows desktop**. Once you enable it for a conversation, its agent can inspect the screen, switch applications, and use the mouse and keyboard. It uses the existing agent and model, not a separate remote desktop session or a virtual machine.

## Enable and stop

1. Open a project conversation and select an image-capable model.
2. Check **Allow Computer Use** in the composer, next to **Allow questions**. The checkbox is off by default. For a new conversation, the choice takes effect when you send the first message.
3. Give the agent a concrete task. No additional approval is requested for each application or click.
4. Use the separate **Stop desktop** control, or **Ctrl+Alt+Shift+F10**, to stop desktop control. This does not stop Studio or cancel unrelated agent runs.

The mode is off by default and is not restored after a server restart. A conversation may retain its choice between turns within the same server process. Stop clears the active desktop authorization. Only one controller can use the shared desktop at a time. Read-only remote access cannot enable or stop it.

## What the agent can do

- List visible windows, focus an application, and wait for a window to appear after a launch.
- Observe the desktop, a window's visible rectangle, or a screen region.
- Move, click, double-click, drag, scroll, press key combinations, and type Unicode text.
- Take another observation to verify the result before continuing.

The native tools are `computer_status`, `computer_windows`, `computer_observe`, `computer_act`, and `computer_release`. Tools cannot enable the mode themselves. Root agents and their native subagents share the same conversation authorization and desktop controller.

`computer_observe` returns an actual image to the model, plus its dimensions and a frame identifier. Actions use coordinates from that image. Studio maps them to physical screen pixels, including scaled captures and negative monitor origins. Each action batch requires a fresh observation. If an action times out, the agent must observe the current state rather than blindly replay it. Every screenshot is point-in-time and can show loading or unsettled UI, not settled UI.

After launching an app, wait for its window with `computer_windows` (`action: "wait"`), focus it if needed (`action: "focus"`), then observe that window before claiming an outcome. Waiting is read-only, bounded, and cancellable: it never focuses, launches, or captures. Filters `processName` (case-insensitive exact match, `.exe` suffix accepted), `title` (case-insensitive substring), and `windowId` combine with AND, and at least one nonempty filter is required. `timeoutMs` accepts an integer from 100 to 20000, default 10000. The response carries `found`, `timedOut`, `window` on success, the matching `windows` list, `elapsedMs`, and a note. `found` means the window exists, not that app UI or sound is ready. `timedOut` means it was not seen within budget, not that the app failed. If focus changes, observe again instead of repeating the launch or acting from a stale frame.

`computer_act` accepts `observeAfter` plus `observeOptions` (`windowId`, `region`, `maxWidth`) for the verification capture. By default verification reuses the original frame capture options; `observeOptions: {}` requests the whole desktop. A new window can appear on another monitor, so prefer `wait` plus `observe` of the new window before acting on it. Every result carries `applicationState: "unverified"` because sent input is not task success. If the verification capture fails after successful input, the result keeps `executed` plus `observationError: {code, message}` without an overall failure or replay; observe again instead of replaying the batch.

## Real desktop implications

This mode is not an isolation boundary. Actions affect your open applications, files, accounts and dialogs. Screen images can contain private information and are sent to the selected model provider as part of the agent conversation. Normal provider and native conversation retention apply. Routine status polling does not include screenshot pixels.

Do not use the mouse or keyboard at the same time as the agent. Keep sensitive windows out of the captured region. Stop is best effort for actions already dispatched: it cannot undo a click, a submission, or a file operation that has already happened.

## Windows requirements and limits

- Windows with an unlocked, interactive desktop is required. Other systems report the feature as unavailable.
- The native helper uses Windows PowerShell and .NET. No extra automation package or MCP server is required.
- Windows privilege boundaries still apply. UAC secure desktop and higher-privilege applications are not bypassed. Studio does not automatically elevate itself.
- Window observations capture visible screen pixels, not a hidden or minimized application's backing surface. An overlapping window can therefore appear in the image.
- Display or focus changes can invalidate an observation. The agent must observe again when asked.
- The hotkey depends on successful registration by the native helper. The separate Studio stop control is also available.

## Development and validation

The Node driver starts its hidden native helper lazily. A session-scoped manager owns authorization and frames. A private native bridge binds tool calls to the real run and native subagent ledger. The extension sends image content through the existing provider pipeline.

```sh
npm run test:computer-use
npm run test:computer-use:ui
npm run test:computer-use:native
npm run test:computer-use:worker
```

Automated checks use a fake desktop driver and synthetic images. The native-agent integration check uses the installed engine with a local deterministic provider, temporary state and isolated processes. These checks do not capture the personal desktop, move the real pointer, or make paid model calls. They do not replace a coordinated real-desktop acceptance test for input behavior, monitor scaling, Windows focus restrictions and the global hotkey.

See [development](development.md) for the project environment.
