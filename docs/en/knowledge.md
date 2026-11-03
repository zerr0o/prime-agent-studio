# Project knowledge

**English** · [Français](../knowledge.md) · [← Back to README](../../README.md)

Available since version 3.0.0, this view lets you find past work from a project, its session memories and the refinements recorded by Prime Agent. Global memories and refinements are labelled **Global** and remain shared across projects.

## Read a source

Open **Project knowledge** from the **Session** tab in the workspace panel on the right, below **Copy path**. The button is also available in the project overview and its **⋯** menu. Search for words from a decision, problem or solution, then filter by **Past work**, **Memories**, **Prompts**, **Skills**, **Subagents** or **Refinements**. The last four show the native harness entries recorded by Prime Agent. **Global** shows only cross-project entries. Search ignores case and accents; every word entered must match. This is text search with no model call.

Select a result to read its content and **Exact source**. Displayed dates come from native files. Missing dates are not invented. Refinements show before/after changes when these were recorded; changes that were not applied remain explicitly identified.

**Open conversation** opens the source session and its message when that message can be displayed. Sources from completed subagents remain readable even when their session is absent from the main navigation. In that case, Studio shows the native file and reference without offering an unavailable conversation link.

On phones, a result opens in the same panel. **Results** returns to the list. Browsing is also available through authenticated read-only remote access.

## Correct the harness

**Roll back this refinement** fills the composer with `/refine rollback <id>` in the session that owns the refinement. **Correct** fills `/refine Correct <kind>:<id>:` for a memory, prompt, skill or subagent; describe the fix, then send. Global entries use `--global` in the current conversation. Nothing runs until you send the command. Prime Agent applies it and records a new refinement; Studio never writes `harness_state.json` itself.

## Reuse work with an agent

New runs started by Studio receive two tools, `studio_knowledge_search` and `studio_knowledge_read`. Their subagents inherit them. For example: “Find how we fixed this calibration problem in previous sessions, then check whether that solution still applies.”

The agent searches within its execution project and reads useful sources. The tool cannot choose a different project. Content from an old conversation remains reference material to verify; it does not replace your current request. Searches do not automatically add the full history to context. A run started before this feature was enabled must finish; the tools become available when the session resumes.

### Choose shared memories

The conversation option **Inject shared memories** is off by default, including for an older conversation with no saved choice. Turn it on before sending to reuse global memories. The choice is saved for that conversation and inherited by its subagents; it does not become the default for new conversations. Wait for the run to finish before changing it.

When the option is off, the engine does not inject global memories or global refinement summaries. The `studio_knowledge_search` and `studio_knowledge_read` tools exclude them too, even when given a previously returned source ID. Local memories and project work remain available. The **Project knowledge** view, which you browse yourself, still displays global sources.

This setting deletes no files or information already exchanged in the conversation history. Global instructions, skills, subagent definitions and MCP connections remain independent. It does not restrict access to files, the network or other agents: it is not a sandbox. To start without information already received, create a new conversation with the option off.

## Sources and limits

Native JSONL files remain the source of truth. Studio reads the current branch of each conversation, subagents preserved in native artifact directories, harness entries in `harness_state.json` and native `prime-agent.refinement` events. Refinement history remains readable after switching branches. Global memories and refinements are shared across projects by Prime Agent.

Browsing changes no memories, refinements or conversations; only a command you send changes the harness. There is no second memory engine or permanent indexing process. A derived local cache, in `knowledge-index` under the Studio data directory, avoids rereading unchanged conversations. Appends are read incrementally. You can delete this cache while Studio is closed; the next search rebuilds it.

Large excerpts and changes are bounded and labelled. Some unreadable or oversized sources may be skipped with a warning. Tool arguments and results, images and private reasoning are not indexed. Responses and memories may contain sensitive information: authenticated remote access has the same reading rights as conversation history.

## Verification

`npm run test:knowledge` checks the UI against synthetic files in French and English, on desktop and mobile. `npm run test:navigation` checks nested projects and conversations. `npm test` covers sources, bounds, project isolation, concurrent cache writes and HTTP access.

`npm run test:shared-memories:native` checks the context sent to a local fixture provider: simultaneous conversations, subagent inheritance, preference changes, resuming and keeping local memories. Unit tests also cover compaction and branch-summary filters. No external model is called.

`npm run test:knowledge:native` verifies actual tool calls by Prime Agent and a subagent using a local fixture provider, with no external model request. After `npm run desktop:resources`, `npm run test:knowledge:packaged` checks the copied resources outside the checkout with multiple concurrent readers.
