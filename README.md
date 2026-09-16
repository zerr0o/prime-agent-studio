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
  <strong>Your projects. Your agents. One workspace.</strong><br>
  A local French and English interface for Prime Agent, designed for Windows.
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#while-the-agent-is-working">Live messages</a> ·
  <a href="#images-and-attachments">Attachments</a> ·
  <a href="#your-models-within-reach">Models</a> ·
  <a href="docs/en/navigation.md">Projects and conversations</a> ·
  <a href="docs/en/knowledge.md">Project knowledge</a> ·
  <a href="#project-roadmap">Roadmap</a> ·
  <a href="docs/en/mcp.md">MCP connections</a> ·
  <a href="docs/en/providers.md">Providers</a> ·
  <a href="docs/en/commands.md">Commands and skills</a> ·
  <a href="docs/en/inspector.md">Agents and files</a> ·
  <a href="docs/en/lan.md">Mobile access</a> ·
  <a href="docs/en/desktop.md">Windows application</a> ·
  <a href="docs/en/pwa.md">Mobile PWA</a> ·
  <a href="docs/en/translations.md">Languages</a> ·
  <a href="docs/en/development.md">Development</a>
</p>

![Prime Agent Studio on desktop: projects, conversation, agent activity and context panel.](docs/screenshots/en/desktop-conversation.png)

<p align="center"><em>The real interface with demonstration data. Sample conversations and documents retain their original language.</em></p>

Prime Agent Studio brings your **local Prime Agent sessions** together in a Windows application and a browser interface. Follow streaming responses, find your projects and continue a conversation without opening a terminal. On Windows, agents and their tools run in the background, without unexpected PowerShell windows.

**Version 3.6.0** · [Download the Windows x64 installer](https://github.com/zerr0o/prime-agent-studio/releases/download/v3.6.0/Prime-Agent-Studio_3.6.0_x64-setup.exe) · [Release history](docs/en/changelog.md).

## Images and questions in the conversation

See project images directly in the agent’s response and click to enlarge them. Studio reads the original file without making an extra copy. If it is moved or deleted, the conversation shows that the image is no longer available.

**Allow questions**, beside the thinking selector, lets the agent ask for your input. Choose an option, expand its description, write another answer or **Skip**. It is enabled by default; choose the default for new conversations in **Preferences → Models & agents**. Each conversation keeps its own saved choice. Questions use Prime Agent’s native interaction mechanism and stay synchronized between PC and phone. [Configuration guide](docs/en/configuration.md#interactive-questions-and-conversation-images).

In the Windows application, **Preferences → Notifications** independently controls alerts for questions and completed turns. Studio stays silent while any of its windows is focused.

![Project image and native agent question, with an expanded option description, a free-text answer field and a Skip button.](docs/screenshots/en/desktop-interactive-questions.png)

_Real interface with a fictional conversation. Lotus Elise photo: [Exotic Car Trader](https://www.exoticcartrader.com/listing/2005-lotus-elise-1)._

## Project Roadmap

Keep plans, nested tasks and a backlog alongside your conversations. Expand the Roadmap across the workspace, collapse task groups and track their checked/total counts. Descriptions stay tucked away until you need them.

![Expanded project Roadmap with nested tasks, completion counts and collapsible descriptions.](docs/screenshots/en/roadmap-expanded.png)

_The real interface with a fictional project and demonstration tasks._

Studio and its agents share the same Roadmap. Assign work from a plan, return to its linked conversation and consult project knowledge from the panel. [Explore the Roadmap guide →](docs/en/roadmap.md)

## What you can do

**Français or English**: open **Preferences → Appearance → Language** on desktop or mobile. **Automatic** follows the browser’s language. Changes apply immediately, preserve forms, drafts and attachments, and let agents keep working. The mobile sign-in page has its own selector; the PWA’s offline screen uses the selected language.

Translations live in **one table**, with French and English side by side for each message. Missing translations use French, and project checks detect absent entries and inconsistent parameters. [Add a language or translation](docs/en/translations.md).

| Feature                     | In Studio                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Organize projects**       | Open their folders on the PC, pin them or remove them from Studio with confirmation; organize and resume their sessions. |
| **Find previous work**      | Search project history, native memories and refinements, then read their sources or let an agent consult them.           |
| **Follow progress**         | Read streaming responses and expand an activity block containing tools and reasoning.                                    |
| **Inspect a session**       | Check its status and usage, follow subagents and open their conversations without switching sessions.                    |
| **Browse files**            | Explore the project, read Git changes, preview and open files from desktop or mobile.                                    |
| **Intervene live**          | Steer the agent or queue a follow-up message without stopping its work.                                                  |
| **Attach images and files** | Select a photo or document, drop it into the conversation or paste it from the clipboard.                                |
| **See project images**      | View images in agent responses, enlarge them and keep their original files as the source.                                |
| **Answer agent questions**  | Enable native questions per conversation, with described choices, free text or Skip.                                     |
| **Find your models**        | Search by name or provider, manage favorites and choose a reasoning level.                                               |
| **Configure subagents**     | Set the model and reasoning for future delegations, globally or per project, before the first message.                   |
| **Connect MCP tools**       | Manage HTTP and stdio servers, OAuth, variables, allowed tools and connection tests.                                     |
| **Manage providers**        | On the PC, connect an account, save an API key and remove credentials with confirmation.                                 |
| **Work in parallel**        | Run several sessions and switch between them.                                                                            |
| **Use Studio on mobile**    | Control the PC from a phone over Wi-Fi or Tailscale, protected by an access code.                                        |
| **Install Studio**          | Install the Windows application with shortcuts, or add the mobile PWA to your home screen over HTTPS.                    |

Runs continue when you switch sessions, reload the page or close the tab. The server must stay running.

Each project’s **⋯** menu also works on mobile; desktop supports right-click. Removing a project hides its Studio entry while preserving its folder and sessions. Add the folder again to find them. A project with an active run cannot be removed.

In the project list, a **green dot** indicates a working session and a **blue dot** indicates an unread completed response. Green takes priority. The corresponding session also has a blue dot: read its latest response to clear it. Read receipts are saved on the host PC and shared across browsers, phones and the Windows application, including read-only access. Open devices synchronize at the next refresh (within 10 seconds), or when brought back to the foreground. When shared tracking is first enabled, existing responses become the common starting point.

Drag a project to its new position in the sidebar. On touchscreens, use its handle; scrolling the rest of the list remains available. With the keyboard, focus the handle and use the up/down arrows. The **…** menu also retains those actions. The order is saved on the server and shared across devices; pinned projects stay at the top and can be reordered within their group.

In remote Studio, **Preferences → Sign out** closes this browser’s access and returns to the access-code screen. Agents and other connected devices keep running.

On the PC, **Preferences → Remote access → Change code** changes the eight-digit PIN for Wi-Fi, Tailscale and the PWA. Devices must sign in again with the new code; agents continue without restarting Studio.

## Commands and skills within reach

Type **`/`** or use the **/** button beside attachments to find a command, skill or project prompt. Shortcuts open Studio panels; `/compact`, `/refine`, `/goal` and `/autonomous` run through Prime Agent, including in an active session’s queue. `/skill:name` loads a skill with your instructions. See the [commands, skills and prompts guide](docs/en/commands.md) for syntax and terminal-only commands.

Python skills are prepared according to the project’s native settings, for both the parent and its subagents. [Python configuration and repair of older installations](docs/en/configuration.md#python-and-skills) covers automatic setup and user-supplied `PRIME_AGENT_KERNEL_PYTHON` environments.

## Session, agents and files

The right panel has three tabs: **Session** for status, token usage and access to **Project knowledge**, **Agents** for delegations and their conversations, and **Files** for browsing the project or reading Git changes. On phones, the panel button at the top right opens these views at full height.

Files open read-only, with Markdown rendering, indented JSON and a **Preview / Source** switch. Document links in conversations open the same viewer. **Open** launches the file in its application on the PC; on phones, the button says **Open on PC**. Git changes cover the entire project, including work from other sessions. The [panel guide](docs/en/inspector.md) explains live tracking and preview limits.

![Desktop Agents panel: main agent, delegations and the status of each task.](docs/screenshots/en/desktop-inspector-agents.png)

![Desktop Markdown preview opened from a conversation link, with source view and native application opening.](docs/screenshots/en/desktop-document-preview.png)

## Your MCP tools and services

**Preferences → Tools → Manage MCPs** lets you add, edit, test, enable or remove native Prime Agent connections. **HTTP** and **stdio** servers are supported, along with **OAuth**, variables and tool restrictions. Linear and Notion are offered as native integrations.

Connection tests discover tools without executing them. New settings apply to new sessions; existing sessions continue with their current configuration. See the [MCP guide](docs/en/mcp.md), including how to complete OAuth from a phone.

<p align="center">
  <img src="docs/screenshots/en/desktop-mcp.png" width="680" alt="Desktop MCP manager with native integrations and a demonstration HTTP server.">
</p>

## Quick start

### Windows application

Download the [Windows x64 installer](https://github.com/zerr0o/prime-agent-studio/releases/latest), install it, then open **Prime Agent Studio** from your desktop or Start menu. Node.js is included. Builds with guided setup offer **Install missing components** at first launch and in application settings: Prime Agent **0.9.4**, private npm, uv and Python download on demand after your click. Compatible external installations are reused; Git Bash is detected separately for shell commands. Configure your provider afterward. Previously published installers are unchanged. If you used the VBS launcher, select **Use an existing installation**. [Full guide](docs/en/desktop.md).

Updates are signed for Tauri; the installer does not yet carry a Windows Authenticode signature.

**After updating:** the application can keep using the previous server while agents finish. Once they have finished, use **Preferences → Updates → Restart server** in the Windows application to activate 3.6.0. [Update guide](docs/en/desktop.md).

### From source

**Requirements:** Windows, **Node.js 22.8 or later**, **uv**, and **Prime Agent** installed. Configure a provider before the first message, through the CLI or Studio’s desktop **Providers** panel. Subagent settings integration has been verified with **Prime Agent 0.9.4**.

Download **Source code (zip)** from the [latest release](https://github.com/zerr0o/prime-agent-studio/releases/latest) and extract it, or clone this repository. Open a terminal in the extracted folder:

```powershell
npm ci
npm run setup:runtime
npm run start:silent
```

The browser opens at **[127.0.0.1:3088](http://127.0.0.1:3088)**. Afterward, double-click **`Lancer Prime Agent.vbs`**: the launcher reuses the server if it is already running.

1. Add a project folder with **+** in the workspace.
2. Open an existing session or choose **New session**.
3. Select a model, then write your request.

Studio reuses Prime Agent’s configuration: you do not need to paste an API key into the browser. Initial Python engine setup may require an Internet connection.

| Command                | Purpose                                           |
| ---------------------- | ------------------------------------------------- |
| `npm run start:silent` | Start in the background and open the browser.     |
| `npm run shortcut`     | Create a desktop shortcut.                        |
| `npm start`            | Start with logs in the terminal, for development. |
| `npm run stop`         | Close the server and its active runs.             |

**Closing the tab lets agents keep working.** **Stop** ends the selected run; `Arreter Prime Agent.vbs` or `npm run stop` closes all of Studio.

### Update a Git installation

Wait for active runs to finish, then run these commands in the Studio folder:

```powershell
npm run stop
git pull --ff-only
npm ci
npm run setup:runtime
npm run start:silent
```

Local settings and native Prime Agent sessions are preserved. For an archive installation, replace Studio’s files with the new release while keeping the `.local` folder, then repeat the installation steps.

**Upgrading from version 2.3 or earlier:** run `npm ci`, then `npm run setup:runtime`, and restart Studio to load the Python skills fix. Already-open kernels keep their environment until restarted.

## While the agent is working

The input remains available during a run. Choose when your message should take effect:

| Mode          | When the message is delivered                                  |
| ------------- | -------------------------------------------------------------- |
| **Steer**     | After the current step’s tools, to adjust the ongoing request. |
| **Follow up** | After the current response, to continue with a new request.    |

You can edit your queued messages, reorder them, remove them or move them between modes. Automatic messages between agents show **Automatic · protected** and offer no editing or removal controls. Engine acceptance is separate from actual delivery, which appears later in the conversation.

Messages received from subagents have a dedicated card with their name and content. Technical identifiers remain available under **Delivery details**, collapsed by default. When the native queue does not provide the sender’s name, Studio simply displays **Agent message**.

![Desktop messages during a run: queue, steering, follow-up and a separate stop control.](docs/screenshots/en/desktop-live-messages.png)

## Images and attachments

Two separate buttons accompany the input: **Photo** opens the phone or PC image picker; **Attachment** accepts any file type. You can also **drag and drop** files into the conversation, or **paste** images and documents provided to the browser by the clipboard. Normal text pasting remains available.

Previews let you remove an attachment before sending. Draft attachments stay in this browser after a reload. Send them on their own, with instructions, as **Steer** or as **Follow up**. In a conversation, click an image to enlarge it or a file to download it.

![Desktop attachments: image and document in a conversation, draft previews, and separate Photo and Attachment buttons.](docs/screenshots/en/desktop-attachments.png)

**PNG, JPEG, GIF and WebP** images are sent to the engine with their pixels; choose an image-capable model. Other files are stored on the PC, and their paths are passed to Prime Agent for its tools. Other image formats can be attached as files.

| Per message | Maximum count | Size per attachment | Combined size |
| ----------- | ------------- | ------------------- | ------------- |
| Images      | 4             | 4 MB                | 8 MB          |
| Files       | 8             | 10 MB               | 20 MB         |

You can combine images and files, up to **8 attachments in total**. These features also work on phones over Wi-Fi or Tailscale. Sent files are stored on the PC; drafts belong to the browser in which you prepare them.

## Your models within reach

On the PC, **Preferences → Models & agents → Manage connections** lets you connect accounts supported by Prime Agent, add or replace an API key, and remove credentials with confirmation. Search shows configuration status and credential sources. This panel is restricted to the PC’s local address; its routes are blocked remotely. The [provider guide](docs/en/providers.md) explains sign-in flows and behavior during active sessions.

![Desktop provider management: search, connection status, accounts and API keys. Demonstration data.](docs/screenshots/en/desktop-providers.png)

Find a model by **name, provider or ID**. Favorites stay at the top of the selector and are stored in your browser. The catalog depends on models available in your Prime Agent installation. Model and thinking choices belong to each conversation and are restored across devices. Thinking can change while the agent works; the new level applies to subsequent model calls without interrupting the current tool.

<p align="center">
  <img src="docs/screenshots/en/desktop-models.png" width="560" alt="Desktop model selector with search, two favorites and Prime Agent automatic selection.">
</p>

On the PC, **Preferences → Models & agents → Configure** lets you choose and save the default main model using the same selector, search and favorites as conversations. This panel also manages custom model definitions. **New session** and **Ctrl+N** use this default model, independently of the last model selected in a conversation.

With Prime Agent **0.9.4**, the **Subagents** area in preferences sets global defaults. For a specific project, select **This project** at the top of a conversation’s **Agents** tab, even before the first message, to show its selectors: changes save immediately. **Global** hides the selectors and restores shared defaults. Model selection uses the same catalog, integrated search and favorites as conversations. Each value can inherit from the parent. Studio adds these choices to the instructions and fills omitted arguments in future delegations; explicit choices and already-created subagents are preserved.

In **Preferences → Agent reasoning**, choose **Hidden**, **Preview** or **Expanded**. Preview shows the **last two lines** of the latest reflection in the activity block, with Markdown formatting and automatic tracking during generation. The **Agents** tab also shows the reasoning level actually used.

![New desktop conversation: default main model and subagent settings available in the Agents tab before the first message.](docs/screenshots/en/desktop-new-conversation-agents.png)

[Read the models and configuration guide →](docs/en/configuration.md)

## A space for each project

Expand a project in the sidebar to find its conversations, filter archived sessions and keep important exchanges pinned. A conversation’s **⋯** menu, also available by right-click on desktop, lets you rename, pin, archive or export it. Studio offers **dark, light and system** themes, local drafts, Markdown export and keyboard shortcuts.

![Desktop project sessions in light theme, with search and a pinned session.](docs/screenshots/en/desktop-projects.png)

Studio titles, pins and archives are stored separately from native Prime Agent conversations.

## Also on your phone

On the PC, open **Preferences → Remote access** and enable **Local network**. Changes apply immediately without restarting or interrupting agents. On first activation, save the eight-digit PIN shown once.

Connect the phone to the same network as the PC, then use **Copy link** or **QR code**. The QR contains only the address; the PIN is requested at sign-in. Later activations preserve the PIN.

You can create or resume a session, send messages and follow progress live. The PC runs the agents and must stay on. The model configurator remains desktop-only.

Access uses HTTP on the local network with code authentication. Studio is a personal local application: it is not intended for exposure to the public Internet.

To use Studio **outside Wi-Fi, over 4G/5G**, connect the PC and phone to Tailscale, then enable **Tailscale** in the same category. Its link and QR are available immediately; LAN and the existing PIN are preserved. Network interfaces, the shared port and permissions are managed in the panel. The npm commands remain available for terminal configuration.

[Configure LAN, Tailscale, the code and read-only mode →](docs/en/lan.md)

## Install Studio as an application

Studio is an **installable PWA**. With Tailscale connected on the PC and phone, open **Preferences → Remote access** on the PC and enable **Tailscale HTTPS**. If account approval is needed, use **Open Tailscale**, then **Try again** in the panel.

Activation keeps your access code and displays an address such as `https://pc-name.network-name.ts.net`, without restarting or interrupting agents. Open this link or scan its QR in the phone’s browser and choose **Install Studio**. On iPhone, use **Safari → Share → Add to Home Screen**.

The PWA keeps the website’s commands and attachments. If connectivity is lost, a **Try again** screen helps you reconnect. The PC is still needed to run agents; closing the app lets them keep working.

[Android, iPhone and desktop installation, HTTPS and offline behavior →](docs/en/pwa.md)

## Documentation

| Guide                                                 | Contents                                                                    |
| ----------------------------------------------------- | --------------------------------------------------------------------------- |
| [Configuration and data](docs/en/configuration.md)    | Models, defaults, storage and environment variables.                        |
| [Projects and conversations](docs/en/navigation.md)   | Collapsible projects, search, archives, menus and reordering.               |
| [Project knowledge](docs/en/knowledge.md)             | Past work, native memories, refinements and history tools for agents.       |
| [Project Roadmap](docs/en/roadmap.md)                 | Shared plans, checklists, backlog, native tools and conversation links.     |
| [Providers](docs/en/providers.md)                     | Account sign-in, API keys, sign-out and desktop-only access.                |
| [Mobile access](docs/en/lan.md)                       | Setup, network address, authentication and permissions.                     |
| [Installable application](docs/en/pwa.md)             | PWA installation, private HTTPS and reconnection.                           |
| [Development](docs/en/development.md)                 | Architecture, silent Windows processes, tests and reproducible screenshots. |
| [Agents and files](docs/en/inspector.md)              | Subagents, usage, Git changes, previews and document opening.               |
| [Commands and skills](docs/en/commands.md)            | Native commands, shortcuts, project skills and prompts.                     |
| [MCP connections](docs/en/mcp.md)                     | Servers, OAuth, tools and connection diagnostics.                           |
| [Languages and translations](docs/en/translations.md) | Interface translations and maintenance of both documentation languages.     |

To check the project:

```powershell
npm run check
npm test
npm run test:ui
npm run test:mobile
npm run test:attachments
npm run test:pwa
npm run test:inspector
npm run test:providers
```

Automated tests use temporary data and a simulated engine. Browser tests require Microsoft Edge; optional live tests with Luna are documented separately.

## License and attribution

Prime Agent Studio is developed by **[zerr0o](https://github.com/zerr0o)** and distributed under the [MIT license](LICENSE). Copyright © 2026 zerr0o.

You may use, modify and redistribute this project, including commercially, provided you keep **zerr0o’s** copyright notice and the license text in all copies or substantial portions of the software. [LICENSE](LICENSE) contains the [standard MIT license text](https://opensource.org/license/mit).

Prime Agent and third-party dependencies retain their respective licenses.

---

<p align="center">
  <strong>Prime Agent Studio</strong><br>
  A local interface around Prime Agent, with your existing sessions and configuration.
</p>
