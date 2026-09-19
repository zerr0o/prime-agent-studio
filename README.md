<p align="center">
  <img src="assets/prime-agent.svg" width="80" alt="Prime Agent Studio logo">
</p>

<h1 align="center">Prime Agent Studio</h1>

<p align="center"><strong>English</strong> · <a href="README.fr.md" lang="fr">Français</a></p>

<p align="center">
  <a href="https://github.com/zerr0o/prime-agent-studio/releases/latest"><img src="https://img.shields.io/github/v/release/zerr0o/prime-agent-studio?logo=github&amp;label=release" alt="Latest GitHub release"></a>
  <a href="https://github.com/zerr0o/prime-agent-studio/stargazers"><img src="https://img.shields.io/github/stars/zerr0o/prime-agent-studio?logo=github&amp;label=stars" alt="GitHub stars"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
  <a href="#quick-start"><img src="https://img.shields.io/badge/Node.js-%3E%3D22.8-339933?logo=nodedotjs&amp;logoColor=white" alt="Node.js 22.8 or later"></a>
  <a href="#quick-start"><img src="https://img.shields.io/badge/platform-Windows-0078D4" alt="Windows platform"></a>
</p>

<p align="center">
  <strong>Guide your agents. Keep your projects moving.</strong><br>
  Your workspace for Prime Agent, on Windows and mobile.
</p>

<p align="center">
  <a href="https://github.com/zerr0o/prime-agent-studio/releases/latest"><strong>Download for Windows</strong></a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#documentation">Documentation</a> ·
  <a href="docs/en/changelog.md">What's new</a>
</p>

![Prime Agent Studio: projects, conversations and subagents together in a dark interface.](docs/screenshots/en/desktop-conversation.png)

_Real interface, demonstration data. The content and measurements shown are fictional._

**Prime Agent Studio** brings conversations, subagents, tools and project tracking into one local interface. Run several tasks, follow their progress and step in when needed, without juggling terminals. Access the same Studio from your phone.

## One workspace to get things done

|                             | What you gain                                                                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Organized conversations** | Stable ordering, pins, search and reordering by drag and drop or menu. Conversations no longer jump to the top with every message. |
| **Clear progress**          | A Roadmap shared with your agents: plans, nested tasks, backlog and links to conversations.                                        |
| **Live control**            | Steer a task, queue the next message and answer agent questions without stopping its work.                                         |
| **Your models and tools**   | Providers, favorites, reasoning, subagents, skills and MCP connections in the same interface.                                      |
| **Images and documents**    | Attach files by selecting, dropping or pasting them; view project images directly in responses.                                    |
| **Context within reach**    | History, native memories, refinements, files, current context and Codex quota when available.                                      |
| **Continuity across PCs**   | Export conversations and Roadmap as `.pastudio`, then import them into another project without erasing local conversations.        |

### The Roadmap, alongside the work

Turn an idea into a plan, assign it to an agent and return to the linked conversation. Expand the panel, collapse tasks and keep a clear view of what remains.

![Expanded Roadmap: plans, nested tasks and progress in a fictional project.](docs/screenshots/en/roadmap-expanded.png)

[Explore the Roadmap →](docs/en/roadmap.md)

### Pick up on another PC

The project menu offers **Export / Import `.pastudio`**. The archive preserves native histories, subagents and Roadmap — **not project files or provider settings**. Choose the destination folder: existing conversations stay intact and duplicate archives are detected.

Imported conversations start as read. Their model is retained when usable; otherwise, the destination PC's default model takes over. Export and import from Studio opened on each PC, not from a remote browser.

[Transfer, limits and privacy precautions →](docs/en/navigation.md)

## On desktop. On mobile. Keep the thread.

- **Windows**: a dedicated window, a connecting screen at startup and a discreet system-tray presence. Closing the window leaves agents working.
- **Mobile**: access Studio over Wi-Fi or Tailscale, protected by an access code. Install the PWA over HTTPS and enable question and turn-completion notifications per device.
- **Updates**: read release notes and install from the dedicated panel. Controlling updates from mobile requires the Windows application to be running, writable remote access and no active agents.

The PC must stay on. On iPhone, notifications require iOS 16.4 or later, the PWA installed on the home screen and your permission. Remote access is designed for private networks, **not direct exposure to the public Internet**.

[Remote access](docs/en/lan.md) · [PWA and notifications](docs/en/pwa.md) · [Windows application](docs/en/desktop.md)

## Quick start

### Windows application — recommended

1. [Download the latest Windows x64 installer](https://github.com/zerr0o/prime-agent-studio/releases/latest), then open **Prime Agent Studio**.
2. If needed, click **Install missing components**. Node.js is included; Prime Agent 0.9.4, uv and Python are prepared on demand. Git Bash is still required for shell commands.
3. Connect your provider, add a project folder and start your first conversation.

For daily use, Studio prioritizes opening the main window. Full diagnostics remain available in application settings, with the current phase displayed.

**Current version: 3.6.1.** Updates use a signature verified by Tauri; the installer does not yet have Windows Authenticode signing. After updating, restart the server from Preferences once agents have finished. [Full guide →](docs/en/desktop.md)

### From source

With Windows, Node.js ≥ 22.8, uv and Prime Agent installed, run from the cloned repository:

```powershell
npm ci
npm run setup:runtime
npm run start:silent
```

Open [127.0.0.1:3088](http://127.0.0.1:3088). Configure a provider before sending the first message. [Setup and development →](docs/en/development.md)

## Documentation

[Projects, conversations and archives](docs/en/navigation.md) · [Models and configuration](docs/en/configuration.md) · [Providers](docs/en/providers.md) · [MCP](docs/en/mcp.md) · [Commands and skills](docs/en/commands.md) · [Agents and files](docs/en/inspector.md) · [Knowledge](docs/en/knowledge.md) · [Languages](docs/en/translations.md)

## License

Developed by **[zerr0o](https://github.com/zerr0o)**, under the [MIT license](LICENSE). Copyright © 2026 zerr0o. Prime Agent and third-party dependencies retain their respective licenses.
