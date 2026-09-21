# Model providers

**English** · [Français](../providers.md) · [← Back to README](../../README.md)

On the PC running Studio, open **http://127.0.0.1:3088 → Preferences → Models & agents → Manage connections**. This panel is restricted to local PC access: it is unavailable over LAN, Tailscale or the remote PWA, even with full control.

## Accounts and API keys

The list uses the installed Prime Agent catalog, with search by name or ID. It shows known models and the configuration source. **Configured** means an authentication method was found; opening this panel sends no generation request to verify a subscription, quota or key.

- **Connect an account** starts the provider’s native flow. Open the official page with the supplied button, authorize the connection and return to Studio. Depending on the provider, a code, domain or selection may be requested. Manual entry of the code or callback URL is offered when the engine supports it.
- **Add an API key** saves a key in Prime Agent’s native storage. An already-saved key is never prefilled or returned to the browser.
- **Environment variable** stores the name of an existing variable in the server’s environment. The variable must already be defined and nonempty. This panel does not change system variables.

With Prime Agent 0.9.5, account flows are those exposed by the native registry: OpenAI Codex, Anthropic, GitHub Copilot and xAI (Grok). Studio keeps no frozen list and follows the installed engine. For xAI, the same `xai` entry accepts an account connection (eligible subscription) or an existing API key (`XAI_API_KEY`); access and billing rules remain those of the provider, see the [native provider documentation](https://github.com/PrimeIntellect-ai/prime-agent/blob/v0.9.5/packages/coding-agent/docs/providers.md).

In ordinary use, Prime Inference uses `PRIME_API_KEY` then the `auth.json` entry; the Prime CLI configuration (`~/.prime/config.json`) is no longer read and is reused only during an explicit upstream login. If you only relied on the CLI, reconnect that provider (existing API key supported). Studio never silently imports CLI credentials and never really opens an external login.

Azure and Cloudflare require additional environment settings. Bedrock and Vertex use their existing cloud settings; guidance in each card explains where to configure them. Custom providers must first be defined in **Models and defaults**.

## Meta Model API (Muse Spark)

The **Meta** provider (`meta`) connects Prime Agent directly to [Meta Model API](https://dev.meta.ai/docs/overview), without installing or launching the Muse Code CLI. Tools and subagents remain managed by Prime Agent.

In **Manage connections**, search for **Meta**, choose **Add an API key**, and enter your Meta Model API key. You can also use `MODEL_API_KEY` in the server environment. Do not paste your key into a conversation.

After connecting, select **Muse Spark 1.3** (`meta/muse-spark-1.3`) or **Muse Spark 1.3 Contributor** (`meta/muse-spark-1.3-contributor`). The official API endpoint is `https://api.meta.ai/v1`. Meta manages access, quotas, and billing. **The Contributor variant allows Meta to use prompts and responses for training.** Choose the Standard variant if you do not want this use. A configured connection does not guarantee that generation is authorized.

Muse Spark always reasons: available levels range from `minimal` to `max` for Standard, and up to `xhigh` for Contributor. A saved `off` preference is clamped to `minimal`. The Responses protocol preserves encrypted reasoning between turns. Studio exposes text and image inputs.

## Muse Code (subscription, experimental)

The **Muse** provider (`muse-code`) is separate from the **Meta** provider (`meta`): it uses your Muse subscription through a browser device-code login, with no API key and without installing or embedding the Muse CLI. It only appears in **Manage connections** when the native authentication module is available; otherwise it stays invisible and nothing changes.

Choose **Connect an account**, read the experimental warning, check the confirmation box, then open the official page and enter the displayed code. Access requires an active subscription: without one, login fails closed with no fallback to paid usage. No existing `MODEL_API_KEY` key or `meta` credential is used or modified by this flow.

No silent fallback: while any engine **fallback model** is configured (any paid billing: `meta`, Prime, OpenRouter or other), a Muse session refuses to start instead of switching billing on quota or outage. Clear the engine fallback to run Muse. Guard scope: this refusal covers Studio session starts. It does not cover native subagents resolving Muse mid-session under a non-Muse parent, nor settings changed mid-run (the native engine re-reads `settings.json` in its retry path, outside Studio control).

## Catalog and availability

With Prime Agent **0.9.4**, the model picker uses the native registry of available models for configured providers. Refreshing includes public models and private Prime Inference models accessible to your account. If the engine is older or this registry is unavailable, Studio uses the catalog bundled with the installation and custom models. With Prime Agent **0.9.5**, ordinary resolution no longer reads the Prime CLI configuration and the catalog no longer watches it; a CLI team snapshot is reused only during an explicit upstream login, then kept by the Agent without tracking later CLI changes.

For **OpenRouter**, Studio also checks identifiers against the public catalog at `https://openrouter.ai/api/v1/models`, with a five-minute cache. This lookup generates no response and checks neither your credits, your quota nor a model’s capacity to respond at that moment. A network error does not mark the whole list unavailable. This public check is skipped when you configure a custom OpenRouter endpoint.

A model identified as retired stays visible as **Unavailable** and can no longer be selected. Old identifiers remain in history and saved defaults. Choose another model to continue: Studio never automatically replaces a retired free identifier with its paid version.

The **Refresh models** button beside favorites in the picker resynchronizes the catalog. Studio also requests a refresh when a run fails with a model-unavailable error. Refreshing preserves your selection and starts no generation.

## Disconnecting and active sessions

**Disconnect** asks for confirmation, then removes only that provider’s saved credentials from `auth.json`. Conversations, custom models, MCP connections and other providers remain in place. Environment variables and `models.json` settings are not removed, so they may continue to provide access. The Prime CLI configuration is neither removed nor read in ordinary use.

For Prime Inference, `PRIME_API_KEY` takes priority over the key saved in `auth.json`.

Adding a provider remains possible while agents are working. Replacing or removing existing credentials waits for Studio’s runs to finish. Agents launched in another terminal share these credentials: wait for their work to finish too before replacing or removing them. The panel stops no sessions and reloads no active workers.

After a successful save, Studio refreshes its model catalog. Prime Agent remains responsible for using and renewing credentials. Closing the sign-in window preserves the ongoing OAuth flow; reopen **Providers** to return to it. **Cancel sign-in** closes only the sign-in process. An unfinished flow expires after five minutes.

## Storage and access

Keys and tokens stay on the PC in the native `~/.prime/agent/auth.json` file. Writes use Prime Agent’s native lock and verify that the provider’s credentials have not changed in the meantime. Concurrent changes to another provider or an MCP are preserved.

Operations run in a hidden Windows process, independently of agents. Entered keys and codes are not put in launch arguments, logs or browser storage. The remote gateway rejects management routes; hiding the button is not the only restriction.

Automated tests use temporary files and fake keys. Native storage and access restrictions are tested directly; OAuth authorizations are simulated so no personal accounts are connected or disconnected.
