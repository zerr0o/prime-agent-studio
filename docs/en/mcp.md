# MCP connections

**English** · [Français](../mcp.md) · [← Back to README](../../README.md)

Open **Preferences → Tools → Manage MCPs** on the PC or in remote Studio with full control. The manager uses **Prime Agent 0.9.1** native configuration: connections are shared across projects on the PC.

## Add a connection

Choose **Add an MCP**, give it a unique name, then select its transport.

| Transport | Configuration                                                                                                                                             |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **HTTP**  | The MCP endpoint address, such as `https://service.example/mcp`. Authentication can be anonymous, use a direct token (secret stored as a private header), use a variable containing a Bearer token, or use OAuth. |
| **stdio** | The executable installed on the PC, its arguments—one per line, without shell quotes—and its absolute working directory if needed.                        |

A stdio server runs on the **PC hosting Prime Agent**, even when configured from a phone. Saving does not execute it. **Test** launches it in a separate process, hidden on Windows, then closes it after tool discovery. Install the required executable on the PC first; Studio does not download servers for you.

For an environment variable, enter its **name**, not its value: `MY_SERVICE_TOKEN` for HTTP, or `TOKEN=MY_SERVICE_TOKEN` in the stdio area. The variable must be available in the Studio process environment and in new Prime Agent sessions. A variable defined after startup may require a restart, once agents finish. Missing variable names appear in the list. If you paste a token into this field by mistake, the manager offers to switch to **Direct token** mode.

**Direct token** mode stores the secret as a private `Authorization: Bearer` HTTP header: it is never shown again or returned to the browser. Leave the field empty when editing to keep the secret. Optional address parameters (for example `?read_only=true&project_ref=…` on Supabase) stay private and are kept while the displayed address is unchanged.

Advanced options set startup and call timeouts, an allowlist of tools, a denylist of tools, and HTTP headers. An empty allowlist permits **no tools**. Without an allowlist, all tools except denied ones remain available.

## Test and manage

**Test** uses the real MCP client from Prime Agent’s Python engine. It initializes the connection and retrieves the catalog, including allowed tools’ names, descriptions and schemas. It invokes no business tools. A successful test confirms connection and discovery at that moment; permissions for a later call may differ.

In the Windows application, the test finds Python in the persistent data folder retained across updates. If it has not been prepared yet, Studio sets it up automatically using Prime Agent and uv, so the first test may take longer. No manual setup command is needed. An explicitly configured Python path retains priority.

You can search, edit, enable, disable or remove added servers. Removal requires confirmation and also deletes OAuth credentials for that server alone. Linear and Notion are Prime Agent’s native integrations: connect or disconnect them from their cards. Their names are reserved.

New settings apply to **new sessions**. Already-loaded sessions retain their configuration until a native reload; Studio does not interrupt them to apply changes. To try a newly added connection immediately, open a new session and ask Prime Agent to use that MCP.

## Connect with OAuth

For an OAuth-compatible HTTP server, choose **Connect**, then **Authorize in the browser**. Prime Agent handles authorization-server discovery, dynamic client registration and secure exchange with PKCE.

- **On the PC**: returning to Prime Agent’s local server is automatic.
- **On a phone**: after authorization, the browser may reach an inaccessible `http://localhost:5370…/callback?…` address. Copy this **complete URL**, return to the MCP manager, paste it into **Full return address** and confirm. Studio verifies that it belongs to the ongoing connection.

You can cancel the connection; it expires after three minutes. Servers requiring a preregistered OAuth client ID are not supported by the form, matching the persistent options exposed by Prime Agent 0.9.1. Use token authentication if the service offers it.

Some servers (Supabase, for example) issue a **confidential** client with a secret at dynamic registration: code exchange and later refresh both require that secret, which the current OAuth engine does not retain. Sign-in then fails after the browser returns, and the manager now shows the real reason instead of a generic message. In that case, use **Direct token** mode with a personal access token from the service.

## Configuration and privacy

The manager edits only `mcpServers` in `~/.prime/agent/settings.json`, under Prime Agent’s native file lock. It preserves model defaults and other settings. If another window changes the same server, the write is rejected and the list must be reloaded.

Prime Agent stores OAuth credentials in `~/.prime/agent/auth.json`, under `mcp:server-name`. Model accounts remain separate. OAuth tokens, saved header values and private URL parameters are not returned to the interface. When editing, a `null` header value means **keep the existing value**. Changing the address requires replacing or removing retained private headers; old OAuth credentials for that server are removed.

MCP management is available through authenticated gateways with **full control**. It is unavailable in read-only mode. Tests and OAuth authorization use their own processes; they do not close running agents.
