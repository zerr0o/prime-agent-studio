<p align="center">
  <img src="assets/prime-agent.svg" width="64" alt="Prime Agent Studio logo">
</p>

<h1 align="center">Prime Agent Studio</h1>

<p align="center">
  <strong>Your projects. Your agents. One workspace.</strong><br>
  A Windows workspace for <a href="https://github.com/PrimeIntellect-ai/prime-agent">Prime Agent</a>, on desktop and in your browser.
</p>

<p align="center"><strong>English</strong> · <a href="README.fr.md" lang="fr">Français</a></p>

<p align="center">
  <a href="https://github.com/zerr0o/prime-agent-studio/releases/latest"><img src="https://img.shields.io/github/v/release/zerr0o/prime-agent-studio?logo=github&amp;label=release" alt="Latest release"></a>
  <a href="#quick-start"><img src="https://img.shields.io/badge/platform-Windows-0078D4" alt="Windows x64"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
</p>

<a id="contents"></a>

<p align="center">
  <a href="https://github.com/zerr0o/prime-agent-studio/releases/latest"><strong>Download for Windows</strong></a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#documentation">Documentation</a> ·
  <a href="docs/en/changelog.md">What's new</a>
</p>

https://github.com/user-attachments/assets/3ac0cccf-c95b-4add-a6fe-64eee66845dd

<p align="center"><em>The full presentation · 76 seconds · with sound · 9.4 MB.<br>Recorded with Studio 4.3.0, fictional projects and simulated agent runs.</em></p>

## Your workspace, your way

<a id="a-space-for-every-project"></a>

Arrange up to **8 conversations and 16 tool panels** with drag-and-drop tabs and splits. Lock a tool to its project or let it follow the active conversation. Save named layouts, or stay with the classic view.

Each conversation keeps its draft, attachments and reading position. Closing a tab does not stop its agent or delete the conversation; the server must stay running.

![Dockable conversations and a Roadmap, shown in an exploded view from the presentation film. Fictional demo projects.](docs/media/prime-agent-studio-workspace.jpg)

## From request to finished work

- <a id="your-models-within-reach"></a>**Choose your agents.** Connect supported provider accounts or API keys. Pick models and reasoning levels for conversations and subagents, with project-specific defaults.
- <a id="while-the-agent-is-working"></a><a id="images-questions-and-attachments"></a>**Keep the conversation moving.** Follow streaming responses, steer a running agent, queue a follow-up, answer its questions and attach images or files.
- <a id="project-roadmap"></a><a id="project-knowledge"></a>**Plan and remember.** Share a Roadmap with agents: plans, nested tasks and a backlog. Search past work, native memories and refinements, with links to their sources.
- <a id="session-agents-and-files"></a>**Inspect and deliver.** Follow subagent work and token usage. Preview project files, review Git diffs, manage branches, commit selected files and push without leaving Studio.
- <a id="commands-skills-and-mcp"></a>**Bring your tools.** Find commands, skills and project prompts with `/`. Connect MCP servers, including HTTP, stdio and OAuth integrations.
- **Keep work organized.** Color-code projects, pin and search conversations, archive old work, or transfer conversations and Roadmaps with `.pastudio` archives.

Dark, light and system themes. English and French. Your existing Prime Agent sessions and configuration.

## Computer Use

Let an agent observe and control the **real Windows desktop**, one conversation at a time. Enable **Allow Computer Use** explicitly; it is off by default. Choose the original Windows integration or **Cua Driver (beta)**.

This is not a sandbox or a per-click approval flow. Screenshots go to the selected model provider. Use **Stop Computer Use** or **Ctrl+Alt+Shift+F10** to stop desktop input without stopping unrelated agents. [Computer Use guide →](docs/en/computer-use.md)

## Continue across devices

<a id="also-from-your-phone"></a>
<a id="install-studio-as-an-app"></a>

**From your phone:** open Studio over a trusted local network or private Tailscale connection, or install its PWA. Choose consultation or full control. The host PC must stay on to run agents. [Mobile access](docs/en/lan.md) · [PWA and notifications](docs/en/pwa.md)

**Between PCs:** optionally sync conversations and Roadmaps through **your own Cloudflare R2 bucket**, with content encrypted before upload. Retrieve uploaded work even when the source PC is offline. This does not sync project folders or move running agents between machines. Configure it in **Preferences → Sync**.

## Connect external tools

The opt-in **public API** connects external applications and scripts to projects, conversations, runs, streaming events, Roadmaps and linked files. Use project-scoped, expiring tokens; Computer Use authorization requires a separate, explicit permission. Token administration stays local. [API guide](docs/en/api.md) · [OpenAPI contract](docs/api/openapi-v1.json)

## Quick start

1. <a id="windows-application"></a><a id="windows-application-and-updates"></a>**Install.** Download the [Windows x64 installer](https://github.com/zerr0o/prime-agent-studio/releases/latest), then open **Prime Agent Studio**. Node.js is included.
2. **Prepare.** Choose **Repair Studio** at first launch to download the engine and missing components, or reuse an existing installation. **Git Bash is required separately.** Initial setup needs Internet access.
3. **Start a project.** Connect a model provider, add a project folder with **+**, choose a model and send your first request.

Agent work runs on your PC. Model and tool calls can send data to the services you configure; provider fees may apply.

Studio checks for updates at startup and every 30 minutes; **Update available** then appears next to **Preferences**. Repair prepares components; an explicit restart activates them. Updates use Tauri signatures; the installer does not yet have a Windows Authenticode signature. [Installation, data and updates →](docs/en/desktop.md)

<details>
<summary><strong>Run from source</strong></summary>

Requires **Windows, Node.js 22.8+, uv, Git Bash and an installed Prime Agent**. Clone this repository or extract the source archive, then run:

```powershell
npm ci
npm run setup:runtime
npm run start:silent
```

`setup:runtime` prepares Python and skills; it does not install Prime Agent. Studio opens at [127.0.0.1:3088](http://127.0.0.1:3088). For later launches, use `Lancer Prime Agent.vbs`. `npm run stop` stops the server and its active runs; closing a browser tab does not.

To update a Git installation, wait for runs to finish:

```powershell
npm run stop
git pull --ff-only
npm ci
npm run setup:runtime
npm run start:silent
```

For an archive installation, replace Studio's files while keeping `.local`, then repeat setup. Native Prime Agent sessions remain in their own storage. [Development and checks →](docs/en/development.md)

</details>

## Documentation

| Start here | Guides |
| --- | --- |
| **Set up** | [Windows app](docs/en/desktop.md) · [Configuration](docs/en/configuration.md) · [Providers](docs/en/providers.md) |
| **Work** | [Projects and conversations](docs/en/navigation.md) · [Voice messages](docs/en/voice.md) · [Roadmap](docs/en/roadmap.md) · [Project knowledge](docs/en/knowledge.md) |
| **Use tools** | [Agents and files](docs/en/inspector.md) · [Commands and skills](docs/en/commands.md) · [MCP](docs/en/mcp.md) · [Computer Use](docs/en/computer-use.md) |
| **Connect** | [Mobile access](docs/en/lan.md) · [PWA](docs/en/pwa.md) · [Public API](docs/en/api.md) |
| **Contribute** | [Development](docs/en/development.md) · [Experimental Rust runtime](docs/en/rust-runtime.md) · [Translations](docs/en/translations.md) · [Changelog](docs/en/changelog.md) |

## License and attribution

Developed by **[zerr0o](https://github.com/zerr0o)**. Copyright © 2026 zerr0o. Distributed under the [MIT license](LICENSE): use, modify and redistribute, including commercially, while retaining the copyright notice and license text. Prime Agent and third-party dependencies keep their respective licenses.
