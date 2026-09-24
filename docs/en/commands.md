# Slash commands, skills and prompts

**English** · [Français](../commands.md) · [← Back to README](../../README.md)

Type **`/` at the start of a message**, or press the **/** button beside attachments. The project catalog offers search, installed skills and prompts. On desktop, use the arrow keys followed by **Enter** or **Tab** to complete; confirming again sends the message. On mobile, tap a suggestion. **Escape** closes suggestions.

Selecting an item prepares the message and leaves room for arguments. Selection alone does not run a command.

A confirmed command becomes a **colored chip** in the input: purple for a skill, blue for a command and green for a prompt. Write arguments beside it, or below it on mobile. **×** removes the chip and keeps the arguments; **Backspace** at the start of the text does the same. On desktop, **Ctrl/Cmd+A**, then copy or cut, includes the command. The draft is stored as plain text, and its chip is restored after reload if the command is still available. Images, documents and messages during a turn remain supported.

The `/` menu opens immediately with Studio shortcuts. Skills and prompts load in the background, with a loading indicator and retry option. The catalog is prefetched when the project is ready, then kept in memory for 30 seconds per session context. Long lists show 30 items at a time, load more on scroll and remain fully searchable. **Refresh** reads the catalog again from the server.

## Studio shortcuts

| Command                | Effect                                                              |
| ---------------------- | ------------------------------------------------------------------- |
| `/help`, `/skills`     | Open the catalog, or go directly to skills.                         |
| `/settings`, `/mcp`    | Open preferences or the MCP manager.                                |
| `/model [search]`      | Open the model selector and filter its results.                     |
| `/effort [level]`      | Choose `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. |
| `/new`                 | Prepare a new session in this project. Other runs continue.         |
| `/name [name]`         | Rename the session in Studio, or open the rename dialog.            |
| `/session`, `/context` | Show Studio’s context panel.                                        |
| `/copy`                | Copy the agent’s latest response.                                   |
| `/export`              | Download Studio’s conversation export.                              |
| `/resume`              | Search for a session in the sidebar.                                |

Aliases `/clear`, `/rename`, `/thinking` and `/usage` are recognized. Models and effort can be changed between turns. Studio shortcuts take no attachments; only the arguments listed above are accepted. Export and context use Studio’s own presentation.

## Native session commands

`/compact [instructions]`, `/refine`, `/goal [objective or action]` and `/autonomous [status|on|off]` are passed to the installed native engine. They follow its syntax and rules. For example:

```text
/goal status
/compact Preserve architecture decisions and next steps
/autonomous status
```

These commands must be on one line, without attachments. During a turn, **Steer** and **Follow up** select their native queue; a command waits for Prime Agent’s designated execution boundary and does not interrupt the current tool. Its results appear in the conversation and history. `/compact` and `/refine` may use the model; setting an objective or enabling autonomy may extend the work according to native settings.

Terminal-specific commands and interactive extension commands are visible in the **Terminal** tab with their limitations. They are never silently sent to the model. Studio does not open a terminal to run them. In particular, `/logout` is a Prime Agent provider authentication command; to close remote Studio access, use **Preferences → Sign out**.

## Skills

In the **Skills** and **Prompts** tabs, choose **Global · All projects** or **Selected project**, then **Open folder**. Studio opens the corresponding native folder: `~/.prime/agent/skills` or `prompts` globally, or `.prime/agent/skills` or `prompts` inside the project. A missing folder is created on demand. From a remote connection with full control, the folder opens on the PC hosting Studio.

A skill contains instructions and, optionally, scripts or a Python module. To invoke one explicitly:

```text
/skill:skill-name Your request and constraints
```

Select several skills through the **/** button: each selection adds a chip. **×** removes only that skill. You can also start a message with `/skill:first /skill:second Your request`.

For one skill, Prime Agent expands `SKILL.md`. For multiple skills, Studio uses the native catalog files and the same block format, including each resource reference folder. Skills also work in messages sent during a run, with images or documents.

In your messages, each expanded skill appears in a **Skill · name** block, collapsed by default. Click to read it; your request stays visible. **Copy** copies your text without the expanded instructions, or the full message if no text remains. Native history is unchanged.

The catalog uses native discovery: global skills (`~/.prime/agent/skills`, `~/.agents/skills`), project and ancestor skills (`.prime/agent/skills`, `.agents/skills`), configured paths, installed packages and skills bundled with Prime Agent. Resource priority, exclusions and explicit-invocation-only skills are respected. The source path and description identify each skill.

To add a Markdown skill to a project, create `.prime/agent/skills/my-skill/SKILL.md`:

```markdown
---
name: my-skill
description: Check this project’s conventions.
---

Read the project conventions, then analyze the user’s request.
```

Python skills need their dependencies in the engine’s Python environment. The catalog installs neither packages nor dependencies. Configuration and installation remain native; the menu executes no extension scripts to discover resources.

A running session displays the resources actually loaded by its worker. New files are picked up by new sessions; the catalog does not reload or stop active sessions.

## Reusable prompts

Markdown files in `~/.prime/agent/prompts`, `.prime/agent/prompts` and configured native sources become `/name` commands. Prime Agent expands arguments, including quoted arguments, `$1`, `$2` and `$ARGUMENTS`:

```text
/review "src/file with spaces.js"
```

The catalog and message submission are available on desktop, mobile and in the PWA after sign-in. Reading the catalog creates no session and contacts no model.
