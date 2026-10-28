# Computer Use

[Français](../computer-use.md) · [Documentation](../../README.md#documentation)

Computer Use is an expert mode for the **real Windows desktop**. Enable it for a conversation to let the main agent delegate desktop tasks to ordinary native subagents. The main agent keeps its own model and reasoning level. There is no separate remote desktop session or virtual machine.

## Enable and stop

1. Open a project conversation. Choose an image-capable **Computer Use decision model** in Preferences if the main model cannot read images.
2. Check **Allow Computer Use** in the composer, next to **Allow questions**. The checkbox is off by default. For a new conversation, the choice takes effect when you send the first message.
3. Give the agent a concrete task. A subagent is created or reused only when desktop interaction is needed. Enabling the checkbox alone creates no subagent or desktop worker. No additional approval is requested for each application or click.
4. Use the separate **Stop Computer Use** control, or **Ctrl+Alt+Shift+F10**, to stop desktop control. This does not stop Studio or cancel unrelated agent runs.

The mode is off by default and is not restored after a server restart. A conversation may retain its permission between turns within the same server process. Several conversations may hold permission, but only one exact agent can control the shared desktop at a time. **Stop Computer Use** clears all permissions and stops the current controller. Unchecking a conversation revokes only its permission; it does not interrupt an unrelated controller. Read-only remote access cannot enable or stop it.

## Native Windows engine

Computer Use uses only our Windows PowerShell/.NET helper. It supports the multi-monitor desktop, regions and native focus. No external engine or additional driver download is needed.

Permission alone does not acquire the desktop or start a worker. If controller cleanup cannot be verified, new control remains blocked. Use Stop to retry; an off authorization state alone is not proof that cleanup finished.

## Computer Use decision model

**Preferences > Tools > Computer Use decision model** selects the model for the **subagent that performs the desktop task**, never for the main conversation. **Same as conversation** uses the same model in a separate subagent. A named model overrides general subagent defaults for desktop tasks only.

The list comes from the same catalog as the main picker. The desktop model must read images. Before desktop access, Studio verifies the child’s model from its native session and checks image support in the catalog. A wrong or unsupported model cannot acquire the desktop; Studio never silently switches it. A text-only main agent can therefore delegate to an image-capable Computer Use model.

The **Reasoning** selector applies only to the desktop subagent. **Same as conversation** takes the main conversation’s level for that child, without changing the main agent’s own settings.

The main agent uses the existing `rlm.spawn` and `agent_message` mechanisms. It can reuse an idle child with its context, or create a fresh child for another task. There is no automatic specialist per conversation, mandatory role, or reserved name. The child reports a result or blocker; desktop screenshots remain in its own conversation unless explicitly shared. Reuse may preserve provider caching, but cache hits and speed gains are not guaranteed.

## Image and focus reliability

New screenshots fit within **2000 × 2000 pixels**, preserving aspect ratio and coordinate metadata, even when a larger `maxWidth` is requested. This also limits tall portrait captures. It avoids the image-size limit reported by Opus for many-image requests without relying on another provider's tolerance.

Oversized historical Computer Use screenshots are omitted only from the transient context sent to the model, with a note to take a new observation. Their pixels are not rescaled under old coordinate metadata. Stored conversations and unrelated user images are unchanged.

The native engine waits briefly for minimized windows to restore and makes bounded native focus attempts. It verifies the actual foreground window. Windows can still refuse activation or access to a higher-privilege window; the error identifies the target and foreground window instead of claiming success. There is no elevation or Win+R workaround.

## What the agent can do

- List visible windows, focus an application, and wait for a window to appear after a launch.
- Observe the desktop, a window's visible rectangle, or a screen region.
- Move, click, double-click, drag, scroll, press key combinations, and type Unicode text.
- Take another observation to verify the result before continuing.

The native tools are `computer_status`, `computer_windows`, `computer_observe`, `computer_act`, and `computer_release`. Tools cannot enable the mode themselves. The main agent delegates desktop work rather than driving it. Native children inherit the conversation permission, **not the desktop lock**. The first desktop operation acquires that lock for the exact child; siblings and agents from other conversations receive a busy refusal. `computer_status` does not acquire the lock or start a worker. The lock is released when the child finishes, stops, is removed, or calls `computer_release`; old frames are invalidated. A recoverable tool refusal does not hand control to another agent. Reusing a child requires a new acquisition and a fresh observation.

`computer_observe` returns an actual image to the model, plus its dimensions and a frame identifier. Actions use coordinates from that image. Studio maps them to physical screen pixels, including scaled captures and negative monitor origins. Each action batch requires a fresh observation. If an action times out, the agent must observe the current state rather than blindly replay it. Every screenshot is point-in-time and can show loading or unsettled UI, not settled UI.

After launching an app, wait for its window with `computer_windows` (`action: "wait"`), focus it if needed (`action: "focus"`), then observe that window before claiming an outcome. Waiting is read-only, bounded, and cancellable: it never focuses, launches, or captures. Filters `processName` (case-insensitive exact match, `.exe` suffix accepted), `title` (case-insensitive substring), and `windowId` combine with AND, and at least one nonempty filter is required. `timeoutMs` accepts an integer from 100 to 20000, default 10000. The response carries `found`, `timedOut`, `window` on success, the matching `windows` list, `elapsedMs`, and a note. `found` means the window exists, not that app UI or sound is ready. `timedOut` means it was not seen within budget, not that the app failed. If focus changes, observe again instead of repeating the launch or acting from a stale frame.

`computer_act` accepts `observeAfter` plus `observeOptions` (`windowId`, `region`, `maxWidth`) for the verification capture. By default verification reuses the original frame capture options; `observeOptions: {}` requests the whole desktop. A new window can appear on another monitor, so prefer `wait` plus `observe` of the new window before acting on it. Every result carries `applicationState: "unverified"` because sent input is not task success. If the verification capture fails after successful input, the result keeps `executed` plus `observationError: {code, message}` without an overall failure or replay; observe again instead of replaying the batch.

## Activity border

An orange border with an inward fade appears on each display while the native worker holds the desktop. It never takes focus and lets clicks pass through. It closes on stop or worker exit; permission alone never shows it.

Windows must confirm capture exclusion (`WDA_EXCLUDEFROMCAPTURE`) before any display. If protection is unavailable, the border stays hidden and `computer_status` exposes the diagnostic in `driver.overlay`. Native control stays available. The border is not a security boundary against third-party capture software.

## Real desktop implications

This mode is not an isolation boundary. Actions affect your open applications, files, accounts and dialogs. Screen images can contain private information and are sent to the selected model provider as part of the agent conversation. Normal provider and native conversation retention apply. Routine status polling does not include screenshot pixels.

Do not use the mouse or keyboard at the same time as the agent. Keep sensitive windows out of the captured region. Stop is best effort for actions already dispatched: it cannot undo a click, a submission, or a file operation that has already happened.

## Windows requirements and limits

- Windows with an unlocked, interactive desktop is required. Other systems report the feature as unavailable.
- The helper uses Windows PowerShell and .NET. No separately configured MCP server is needed.
- Windows privilege boundaries still apply. UAC secure desktop and higher-privilege applications are not bypassed. Studio does not automatically elevate itself.
- Window observations capture visible screen pixels, not a hidden or minimized application's backing surface. An overlapping window can therefore appear in the image.
- Display or focus changes can invalidate an observation. The agent must observe again when asked.
- The hotkey depends on successful registration by the native helper. The separate Studio stop control is also available.

## Development and validation

The Node driver starts its hidden native helper lazily. The manager keeps conversation permissions separate from a global holder identified by run, agent and native session. A private native bridge verifies lineage against the native subagent ledger and the model against the selected session branch and catalog; model hints in tool requests cannot grant access. The extension sends image content through the existing provider pipeline.

The delegation proof covers an ordinary turn with Computer Use enabled but no child or driver, a real native child, exclusive ownership, automatic release, and reuse of that same child with a fresh frame. It uses only a loopback model provider and fake desktop. The delegation change does not resolve every temporary-window, partial native-action or historical-image retention issue; existing focus, cancellation and no-replay safeguards remain in force.

```sh
npm run test:computer-use
npm run test:computer-use:ui
npm run test:computer-use:native
npm run test:computer-use:worker
powershell.exe -NoProfile -NonInteractive -File runtime/computer-use-overlay.selftest.ps1
```

Automated checks use a fake desktop driver and synthetic images. The native-agent integration check uses the installed engine with a local deterministic provider, temporary state and isolated processes. These checks do not capture the personal desktop, move the real pointer, or make paid model calls. They do not replace a coordinated real-desktop acceptance test for input behavior, monitor scaling, Windows focus restrictions and the global hotkey.

See [development](development.md) for the project environment.
