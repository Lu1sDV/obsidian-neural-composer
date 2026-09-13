# Providers Guide

This page covers provider-specific setup, recommended models, and known quirks for each AI provider supported by Neural Composer.

Each provider needs two things: a configuration entry in **Settings → Providers**, and a model selection in **Settings → Models** (for the chat model) and/or **Settings → Graph & Vault** (for the graph logic model and embedding model).

> **Last verified:** May 2026. Model availability changes frequently — check the provider's official documentation if a model ID returns a 404 or 401.

---

## Codex CLI (desktop)

Use your existing [Codex CLI](https://developers.openai.com/codex/cli/) login for text chat and apply without adding an API key to Obsidian. The CLI runs locally but sends prompts to OpenAI; this is not an offline model.

1. Install Codex CLI and run `codex login` in a terminal under the same operating-system account as Obsidian.
2. Open **Settings → Neural Composer → Providers → Add custom provider**, choose **Codex CLI (desktop)**, and give it an ID.
3. Leave **Codex executable** blank if Obsidian can find `codex` on its PATH; otherwise enter the full executable path. This field is a path, not a shell command. Windows requires the native `codex.exe`, not a `.cmd` launcher.
4. Under **Models → Add custom model**, select that provider and enter a model available to your Codex login. Select the new model for **Chat** and/or **Apply**.

Responses arrive as completed CLI message chunks, not token-by-token. Conversation roles and history are supplied as an ordered text transcript. Images, MCP/tool calls and tool-result history, embeddings, and the LightRAG backend are not supported. Start a new text-only chat when switching from a tool-using conversation, and choose a separate graph logic model and embedding provider instead of inheriting the Codex chat model.

Each request runs in a temporary empty directory with a read-only sandbox and a tool-free model catalogue. User/project configuration, instructions, hooks, and integrations are excluded while the existing CLI authentication is retained. Stopping a response terminates its CLI process and removes the temporary directory.

**Compatibility:** verified with `codex-cli 0.154.0`. Older versions must support `exec --json`, `--ignore-user-config`, `--ignore-rules`, `--strict-config`, and the tool-isolation configuration; upgrade if the CLI rejects an option. If authentication fails, run `codex login` again using the configured executable.

---

## OpenAI

**Get an API key:** [platform.openai.com/api-keys](https://platform.openai.com/api-keys)

### Recommended models

| Use | Model ID | Notes |
| :--- | :--- | :--- |
| Chat (quality) | `gpt-5.5-2026-04-23` | Current flagship as of April 2026 |
| Chat (quality, reasoning) | `o3` | Best for complex multi-hop questions |
| Chat (fast/cheap) | `gpt-4.1-mini` | Alias for `gpt-4.1-mini-2025-04-14`; great quality/cost ratio |
| Graph logic | `gpt-4.1-nano` | Cheapest option; sufficient for entity extraction |
| Embedding | `text-embedding-3-small` | $0.02/M tokens — good balance of quality and cost |
| Embedding (best) | `text-embedding-3-large` | $0.13/M tokens — better recall on large, diverse vaults |

### Notes

- `gpt-4o` is still available in the API but **retiring October 1, 2026**. Prefer `gpt-4.1-mini` for equivalent cost-efficient tasks.
- The `chatgpt-4o-latest` alias was removed from the API on February 17, 2026.
- `text-embedding-ada-002` is legacy; `text-embedding-3-small` is the drop-in replacement.
- No free API tier — pay-as-you-go with rate limit tiers.

[screenshot: Providers tab with an OpenAI row showing a masked API key]

---

## Anthropic

**Get an API key:** [console.anthropic.com](https://console.anthropic.com)

### Recommended models

| Use | Model ID | Notes |
| :--- | :--- | :--- |
| Chat (quality) | `claude-opus-4-7` | Current flagship; strong reasoning, 1M token context |
| Chat (fast/cheap) | `claude-haiku-4-5-20251001` | Fastest Claude model; ideal for quick queries |
| Graph logic | `claude-haiku-4-5-20251001` | Fast and cheap for extraction tasks |

### Notes

- **Use full versioned IDs in production.** Starting with the 4.6 generation, dateless aliases like `claude-sonnet-4-6` are pinned snapshots, not rolling aliases. Both forms work; versioned IDs are safer.
- `claude-sonnet-4-20250514` and `claude-opus-4-20250514` are **deprecated and retire June 15, 2026**. Do not use these.
- Anthropic does **not** offer an embedding model. For embeddings, pair Anthropic with OpenAI's `text-embedding-3-small` or Ollama's `nomic-embed-text` configured as a separate embedding provider.
- No free API tier.

---

## Gemini (Google)

**Get an API key:** [aistudio.google.com](https://aistudio.google.com)

> ⚠️ **Shut-down alerts:**
> - Gemini 1.5 models (`gemini-1.5-pro`, `gemini-1.5-flash`) are **completely shut down** and return 404.
> - `text-embedding-004` was shut down **January 14, 2026**.
> - `gemini-embedding-001` shuts down **July 14, 2026** (~7 weeks from the date of this writing).
> - `gemini-2.0-flash` was retired March 3, 2026.

### Recommended models — chat

| Use | Model ID | Notes |
| :--- | :--- | :--- |
| Chat (quality) | `gemini-2.5-pro` | State-of-the-art; best for complex reasoning |
| Chat (fast/cheap) | `gemini-2.5-flash` | Best balance of speed and quality |
| Graph logic | `gemini-2.5-flash-lite` | Most cost-efficient option; high throughput |

### Embedding models — read this before choosing

The embedding situation for Gemini users requires a deliberate choice. **Do not switch embedding models mid-project without planning a full re-ingestion.**

| Model | Dimensions | Status | Notes |
| :--- | :--- | :--- | :--- |
| `gemini-embedding-001` | 3072 (default) | ⚠️ Active until **Jul 14, 2026** | GA since July 2025; supports `task_type` parameter |
| `gemini-embedding-2` | 3072 (default) | ✅ GA since Apr 23, 2026 | Multimodal; does NOT support `task_type` |

**If you are starting a new vault from scratch:** use `gemini-embedding-2`.

**If you already have an indexed vault using `gemini-embedding-001`:** you must migrate before July 14, 2026, but do not rush — a full re-ingestion of all your notes is required. See the migration notes below.

#### Why switching requires a full rebuild

Even though both models output 3072-dimensional vectors, they live in **completely different vector spaces**. Cosine similarity scores computed between a vector from `gemini-embedding-001` and one from `gemini-embedding-2` are mathematically meaningless. You cannot partially migrate — every document in the graph must be re-embedded with the new model before the index is useful.

This is the same reason the `text-embedding-004` → `gemini-embedding-001` migration required a full rebuild (in that case there was also a dimension change: 768 → 3072 dims).

There is an additional API-level difference: `gemini-embedding-001` accepts a `task_type` parameter (e.g., `RETRIEVAL_DOCUMENT`, `RETRIEVAL_QUERY`). `gemini-embedding-2` does **not** support `task_type` — LightRAG handles this internally, but be aware if you use the API directly.

#### Migration strategy (gemini-embedding-001 → gemini-embedding-2)

Choose an approach based on the size of your vault:

---

**Option A — Simple migration (small vaults, < ~500 notes)**

If re-ingesting takes less than an hour and you can afford a short downtime, this is the quickest path:

1. In Settings → Graph & Vault, change the **Embedding model (server-side)** to `gemini-embedding-2`.
2. Click **Restart Server**.
3. Right-click your watched folder → **Add to graph** to re-ingest everything.
4. Wait for all status dots to turn 🟢.

The graph is unavailable for queries while re-ingestion is in progress. For a small vault this is a minor inconvenience.

---

**Option B — Shadow index (large vaults, or if you need zero downtime)**

Build the new index in a separate directory while your existing vault keeps working normally. Only switch over once the new index is fully built and validated.

1. Create a new, empty folder anywhere on your disk (e.g., `lightrag-data-v2`).
2. In Settings → Graph & Vault, change **Data Directory** to the new folder and set **Embedding model** to `gemini-embedding-2`.
3. Click **Restart Server** — LightRAG now points at the empty new directory.
4. Re-ingest all your notes (right-click watched folder → **Add to graph**). Run overnight for large vaults.
5. Test the new index with a few representative queries to confirm quality.
6. Once satisfied, the migration is complete — the new directory is now your active index.
7. Delete the old data directory when you no longer need it as a fallback.

The key benefit: if anything goes wrong during steps 2–5 (API error, power cut, poor result quality), you can simply point **Data Directory** back at the original folder and continue using the old index until you're ready to try again.

> **Cost tip:** Google prices batch embeddings at 50% of the standard per-call rate. If LightRAG's `.env` exposes a batch embedding option, enabling it before re-ingestion can meaningfully reduce the API cost of a large rebuild.

### Notes

- The free tier (no credit card required): `gemini-2.5-flash` at 10 RPM / 250 RPD / 250k TPM; `gemini-2.5-pro` at 5 RPM / 100 RPD. Quotas were reduced ~50–80% in December 2025 — use a paid key for ingestion workloads.
- `gemini-2.5-flash-lite` is the best choice for the **graph logic model** — it's called for every chunk during ingestion, so cost adds up quickly on large vaults.

---

## Groq

**Get an API key:** [console.groq.com](https://console.groq.com)

### Recommended models

| Use | Model ID | Notes |
| :--- | :--- | :--- |
| Chat (quality) | `openai/gpt-oss-120b` | 120B MoE open-weight; replaced llama-4-maverick |
| Chat (quality, alt) | `llama-3.3-70b-versatile` | Still available; strong text-only option |
| Chat (fast/cheap) | `llama-3.1-8b-instant` | Extremely fast; good for simple queries |
| Graph logic | `llama-3.1-8b-instant` | Very cheap; adequate for extraction |

### Notes

- `meta-llama/llama-4-maverick-17b-128e-instruct` was **deprecated February 20, 2026**; use `openai/gpt-oss-120b` instead.
- Groq does **not** offer an embedding endpoint. Pair with OpenAI or Ollama for embeddings.
- Free tier (no credit card): `llama-3.1-8b-instant` up to ~14,400 RPD; `llama-3.3-70b-versatile` at ~30 RPM / ~1k RPD. Sufficient for personal vault use.
- For a current model list: `GET https://api.groq.com/openai/v1/models`

---

## OpenRouter

**Get an API key:** [openrouter.ai/keys](https://openrouter.ai/keys)

OpenRouter is a unified API gateway to dozens of providers. Useful when you want to mix models or access models not directly supported.

### Setup

- Provider: `OpenRouter`
- API key: your OpenRouter key
- Model ID: the full OpenRouter identifier, e.g., `anthropic/claude-opus-4`, `google/gemini-2.5-pro`, `meta-llama/llama-3.3-70b-instruct`

### Notes

- Model IDs use the format `provider/model-name`. Check [openrouter.ai/models](https://openrouter.ai/models) for the exact string.
- Billing goes through your OpenRouter account at the underlying provider's rate.
- Useful for accessing Gemini 2.5 Pro or Claude Opus without separate accounts.

---

## DeepSeek

**Get an API key:** [platform.deepseek.com](https://platform.deepseek.com)

> ⚠️ **Migration required:** `deepseek-chat` and `deepseek-reasoner` are **deprecated and retire July 24, 2026**. Migrate to the IDs below.

### Recommended models

| Use | Model ID | Notes |
| :--- | :--- | :--- |
| Chat (quality) | `deepseek-v4-pro` | Complex reasoning, coding, agents; 1M context |
| Chat (fast/cheap) | `deepseek-v4-flash` | Fast, cost-efficient; non-thinking mode |
| Graph logic | `deepseek-v4-flash` | ~$0.28/M output tokens |

### Notes

- The legacy aliases `deepseek-chat` → `deepseek-v4-flash` (non-thinking) and `deepseek-reasoner` → `deepseek-v4-flash` (thinking) still route correctly today, but **will stop working July 24, 2026**.
- DeepSeek does **not** offer an embedding model. Use OpenAI or Ollama embeddings.
- New accounts receive 5M free tokens.
- DeepSeek's API uses the OpenAI-compatible format.

---

## Ollama (fully local)

**Install Ollama:** [ollama.com](https://ollama.com)

Ollama runs open-weight models entirely on your local machine. No API key, no data leaving your machine.

### Setup

1. Install Ollama and start the service (`ollama serve`).
2. Pull the models you want:
   ```bash
   ollama pull llama3.3          # chat model (70B, recommended)
   ollama pull llama3.1          # chat model (8B, lightweight alternative)
   ollama pull nomic-embed-text  # embedding model
   ```
3. In Providers, set host to `http://localhost:11434`. No API key needed.
4. In Models, select your pulled models.

[screenshot: Providers tab showing Ollama row with host URL and no API key]

### Recommended models

| Use | Pull name | Notes |
| :--- | :--- | :--- |
| Chat (quality) | `llama3.3` | 70B; rivals Llama 3.1 405B; needs ~40 GB RAM |
| Chat (fast/cheap) | `llama3.1` | 8B version; solid default; runs on 8 GB VRAM |
| Chat (edge/mobile) | `llama3.2` | 1B and 3B sizes |
| Embedding | `nomic-embed-text` | 274 MB; 8192-token context; 768 dims; outperforms `text-embedding-3-small` on most benchmarks |
| Embedding (alt) | `mxbai-embed-large` | 1024 dims; SOTA for BERT-large class |

### Notes

- The first request after Ollama starts takes 10–60 seconds while the model loads into memory. Subsequent requests are fast.
- If Ollama is on a different machine, set the host to that machine's IP (e.g., `http://192.168.1.50:11434`) and ensure port 11434 is accessible.
- Ingestion is significantly slower with local models vs. cloud APIs on CPU-only machines.

---

## LM Studio

**Install LM Studio:** [lmstudio.ai](https://lmstudio.ai)

LM Studio provides a GUI for downloading and running quantized (GGUF) models locally, with an OpenAI-compatible API.

### Setup

1. Download and load a model in LM Studio.
2. Start the local server (default port: `1234`).
3. In Providers, set host to `http://localhost:1234`. No API key needed.
4. In Models, type the model name exactly as shown in LM Studio's server log.

### Notes

- **Critical limitation:** LM Studio cannot serve chat completions and embeddings simultaneously from the same instance. To use LM Studio for both, run two separate LM Studio instances on different ports.
- LM Studio supports `nomic-embed-text-v1.5` (GGUF) as an embedding model — load it from the Discover tab.
- Any GGUF-format chat model from HuggingFace works for graph logic. Use structured output mode for better entity extraction.

---

## Morph

Morph is a code-editing subagent specialized for the **Apply** step — when Neural Composer merges a suggested edit back into a note. It uses a custom 7B model optimized for fast, accurate file diffing.

**Get an API key:** [morphllm.com](https://morphllm.com)

### Models

| Model ID | Speed | Accuracy | Context | Notes |
| :--- | :--- | :--- | :--- | :--- |
| `morph-v3-fast` | ~10,500 tok/s | 96% | 82k | Best for most apply operations |
| `morph-v3-large` | ~5,000 tok/s | 98% | 262k | Use for long files or complex edits |
| `auto` | — | — | — | Routes between fast and large automatically |

### Notes

- Set Morph as the **Apply model** in Settings → Models. Keep your primary chat model unchanged.
- Base URL: `https://api.morphllm.com/v1`
- Morph does **not** offer chat, embeddings, or entity extraction — it is specialized for code/text apply operations only.

---

## Perplexity

**Get an API key:** [perplexity.ai/settings/api](https://perplexity.ai/settings/api)

Perplexity's models augment responses with real-time web search. Useful when you want answers that combine your vault with current information.

### Recommended models

| Use | Model ID | Notes |
| :--- | :--- | :--- |
| Chat (quality) | `sonar-pro` | Deeper retrieval; 2× more search results |
| Chat (reasoning) | `sonar-reasoning-pro` | Chain-of-thought + live web search |
| Chat (fast/cheap) | `sonar` | Lightweight; grounded; fast |
| Research | `sonar-deep-research` | Exhaustive multi-step research; hundreds of sources |

### Notes

- The old `sonar-reasoning` ID was **deprecated December 15, 2025**. Migrate to `sonar-reasoning-pro`.
- All `llama-3.1-sonar-*` and `pplx-*` model IDs are deprecated — use only the `sonar*` family.
- Perplexity does **not** offer an embedding model.
- **No permanent free tier** for the API. New accounts receive $25–$50 in trial credits. Pro subscribers get $5/month in API credits.
- Perplexity models are not well-suited as the **graph logic model** — the web search context adds noise and cost during entity extraction. Use a standard LLM (OpenAI, Gemini) for that role.

---

## Mistral

**Get an API key:** [console.mistral.ai](https://console.mistral.ai)

### Recommended models

| Use | Model ID | Notes |
| :--- | :--- | :--- |
| Chat (quality) | `mistral-large-latest` | 675B total / 41B active MoE; strong reasoning |
| Chat (fast/cheap) | `mistral-small-latest` | Mistral Small 4 (March 2026); merged reasoning + vision + coding |
| Embedding | `mistral-embed` | 1024-dim text embeddings |
| Embedding (code) | `codestral-embed-2505` | Code-specific embeddings; May 2025 |
| Graph logic | `mistral-small-latest` | Cost-efficient for extraction tasks |

### Notes

- `mistral-large-latest` always points to the most recent large model. Use the versioned ID (`mistral-large-2512`) for production stability.
- Free "Experiment" plan: 1B tokens/month, all models, no credit card (phone verification required).
- Prompt caching available at 10% of standard input price — useful when re-running queries against the same vault context.
