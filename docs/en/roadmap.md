# Project Roadmap

**English** · [Français](../roadmap.md) · [← Back to README](../../README.md)

Roadmap brings together planned work, checklists and the conversations handling them. It belongs to the selected project. Desktop, phone and Studio agents read the same document; opening the panel starts no agent or model call.

## Organize work

Inside a plan with subtasks, **Collapse all / Expand all** controls every task level in that plan. The plan stays open; collapsing leaves its top-level tasks and completion counts visible. Other plans and descriptions keep their current state.

Open **Roadmap** from the project or the **Session** tab in the right panel. **Project** shows the optional vision, milestones and their plans. **Session** finds plans linked to the current conversation. **Backlog** keeps ideas, uncommitted tasks and notes.

On desktop, **Expand roadmap** at the top of the panel opens a view across the workspace. **Reduce roadmap** or Escape returns to the side panel. Click milestone, plan or parent task titles to collapse their children; the counter at the end of the row stays visible and tracks checked tasks. Descriptions are hidden by default: **Show description** opens them, and **Hide description** collapses them. These reading choices survive refreshes and panel size changes without modifying project data.

A missing Roadmap stays empty until explicitly initialized. Add a plan, then its tasks and notes. Checklists support three levels. Menus let you edit, group, move or explicitly delete items. Drag handles reorder milestones, tasks and backlog entries; menus keep actions available by keyboard and on phones.

Progress counts checked leaf tasks once each. A group reflects its children, and its checkbox applies the same state to all of them. Changing a plan’s status does not check its tasks. Abandoned plans remain readable and leave the project counter; paused plans remain included. Backlog is counted separately.

The plan menu offers **Archive**. Archived plans leave the **Project** and **Session** views, milestone lists and progress totals. They remain visible in the **Archived** tab with its count, as a read only preview, with **Restore** (or **Unarchive**) and **Delete**. Archiving uses the current revision like other edits and deletes no data (an existing plan without the flag stays visible). Agents do not see archived plans and any agent edit targeting an archived plan is refused.

On phones, the panel uses the screen height. Read-only remote access allows browsing and following links, without editing Roadmap or launching work.

Each plan with tasks also shows its percentage. Completed checkboxes are green; partially completed groups keep their existing color. **Remaining only** hides checked tasks without changing actual progress. Parents and notes remain accessible; disable the filter to see all tasks again.

## Assign a task and find its result

**Work on this** prepares a message from the selected items. Sending remains explicit and uses Studio conversations and their queue. The saved link returns to the conversation; it does not resume it. Native subagent references can open their history through the parent conversation, including after they have stopped.

In the confirmation dialog, **Additional instructions (optional)** accepts up to 4,000 characters of last-minute details. These accompany the sent message without changing roadmap tasks.

An agent can declare the items it is handling. Its activity link shows the exact agent identity and opens its conversation. It disappears when its agent loop ends, its run stops or its owner is lost. A continuation does not automatically inherit the old indicator. This signal is a declaration of work; it does not prove that a task is complete.

A plan’s notes and short journal provide result context without copying the conversation. **Project knowledge** keeps its existing search across past work, native memories and refinements. [Knowledge guide](knowledge.md).

## Tools available to agents

New Studio runs and their subagents receive six tools through Prime Agent 0.9.5’s native extension mechanism. No engine fork is required.

| Tool                | Purpose                                                                                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `roadmap_read`      | Read a compact overview, a plan or the backlog, with stable references and the current revision. Large lists are paginated and truncated excerpts are labelled. |
| `roadmap_plan`      | Explicitly initialize Roadmap, create or edit a plan, manage its tasks and journal, or link its conversation.                                                   |
| `roadmap_check`     | Check or reopen one or more tasks in the same plan in a single write.                                                                                           |
| `roadmap_backlog`   | Add, edit, move, check, delete or convert numbered entries and notes.                                                                                           |
| `roadmap_milestone` | Edit the vision and the milestones grouping plans.                                                                                                              |
| `roadmap_work`      | Declare temporary activity on existing items, or clear it with an empty list.                                                                                   |

The project and agent identity come from native context, never model arguments. The server verifies the active conversation and child lineage against native records. Tools reach the same writer service as the interface through a private local channel. A plan created by an agent defaults to linking its root conversation; other links it adds are restricted to its own conversation or root.

Edits require the revision that was read. After a conflict, the agent must read again and reconcile its change; mutations are not automatically replayed. Tools do not start goals, launch other agents or check tasks based on a status or completion event. Internal engine plans and todos are not imported automatically.

## Storage, conflicts and limits

The source document is `.prime/studio/roadmap.json` inside the project. Writes are atomic and serialized with an expected revision; concurrent edits do not silently overwrite one another. A conflict keeps the editor input so it can be recovered after refreshing. Drafts are not published until the edit succeeds.

Markdown export is a readable, shareable copy. Editing the export does not change Roadmap. Simultaneous external editing of the JSON is not supported. An invalid document remains untouched and produces an error distinct from an empty Roadmap. Native memories, refinements and histories are not rewritten.

The file is limited to 4 MiB. Activity stays in memory and disappears when the server restarts; it is never stored in the document as proof of presence. Read-only permissions are also enforced by the server.

## Verification

`node --test test/roadmap*.test.mjs` covers storage, conflicts, HTTP access, agent identity and conversation links. `node scripts/test-roadmap-native.mjs` verifies all six tools in real Prime Agent parent and child processes using a deterministic local provider, with no external model request.

`node scripts/test-roadmap-native-packaged.mjs` repeats that proof from an isolated copy of desktop resources, using a copied Node launched outside the checkout. It does not alter the installed application or the user’s active sessions.
