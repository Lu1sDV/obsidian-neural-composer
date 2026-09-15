# Troubleshooting

Solutions to the most common problems. If your issue isn't listed here, [open an issue](https://github.com/oscampo/obsidian-neural-composer/issues) and include the server log (copy it from the **Advanced** tab's log panel).

---

## Status bar dot is red — server offline

The red dot means the plugin cannot reach the LightRAG server.

**Check these things in order:**

1. **Command path is set.** Go to Settings → Graph & Vault and confirm **Command Path** contains the full absolute path to `lightrag-server`. If blank, see [Installation](Installation) Step 2.
2. **The binary exists at that path.** Open a terminal and run the path directly (e.g., `/Users/you/.venvs/lightrag/bin/lightrag-server --version`). "No such file or directory" means the path is wrong or the venv was deleted.
3. **Auto-start is on.** If it's off, click **Restart Server** manually.
4. **Port conflict.** LightRAG defaults to port `9621`. Check with:
   - macOS/Linux: `lsof -i :9621`
   - Windows: `netstat -ano | findstr 9621`
   If another process owns the port, stop it or change LightRAG's port via the `.env` editor (`HOST=0.0.0.0` `PORT=9622`).
5. **Check the server log.** Advanced tab → log panel. Look for Python tracebacks.

---

## "lightrag-server: command not found"

The **Command Path** field is empty or contains just `lightrag-server` without a full path. The plugin does not inherit your shell's `PATH`.

Run `which lightrag-server` (macOS/Linux) or `where.exe lightrag-server` (Windows PowerShell) in the terminal where LightRAG is installed. Paste the full path into settings.

---

## Windows-specific issues

### PowerShell execution policy blocks the venv

If activating the venv gives *"running scripts is disabled on this system"*, run:

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

Then activate again: `~\.venvs\lightrag\Scripts\activate`

### Path with spaces causes the server to fail to start

If your venv or user folder contains spaces (e.g., `C:\Users\Oscar Campo\...`), wrap the path in the **Command Path** field with double quotes:

```
"C:\Users\Oscar Campo\.venvs\lightrag\Scripts\lightrag-server.exe"
```

Neural Composer passes this string verbatim to `child_process.spawn`, so the quotes are needed.

### `lightrag-server` not found after installing in a venv (Windows)

On Windows, the binary may be at `Scripts\lightrag-server.exe` instead of `Scripts\lightrag-server`. Use `where.exe lightrag-server` to confirm the exact filename with the `.exe` extension, and paste the full path including the extension.

---

## Ollama-specific issues

### Server starts but queries return empty responses

LightRAG needs Ollama's embedding model to match the one used during ingestion. Confirm:

1. Settings → Graph & Vault → **Embedding model (server-side)** matches the Ollama model you have pulled (e.g., `nomic-embed-text`).
2. Run `ollama list` in a terminal to see pulled models. If the model isn't listed, pull it: `ollama pull nomic-embed-text`.
3. Restart the server after changing the embedding model.

### 401 errors with Ollama

Ollama does not require an API key. If you see 401 in the server log, check that:
- The provider in **Providers** tab is set to **Ollama**, not a cloud provider.
- The host URL is `http://localhost:11434` (default) — not an HTTPS URL.

### Slow first response with Ollama

Ollama loads models lazily. The first request after startup may take 10–60 seconds while the model loads into memory. Subsequent queries are fast. This is expected behavior.

[screenshot: server log in the Advanced tab showing "model loaded" line from Ollama after a delay]

---

## Documents stuck in 'processing'

A 🟡 dot that stays yellow for more than a few minutes usually means the ingestion pipeline stalled.

1. Check the server log (Advanced tab) for errors. Common causes: API key errors, network timeouts, and out-of-memory errors.
2. The plugin automatically re-queues stuck documents on the next server reconnect.
3. If the dot stays yellow after restarting the server, right-click the file → **Add to graph** to force a fresh attempt.
4. Use the **Reprocess failed documents** button (Settings → Graph & Vault) to bulk-retry all stuck files at once.

---

## Documents show 'unknown' status after restart

After Obsidian restarts, document statuses may briefly show as unknown (no dot) before syncing. This is expected — the plugin re-reads the status index from LightRAG on the first successful connection. Dots populate once the server responds.

If statuses do not appear after a minute and the server dot is green, close and reopen the affected folder in the file explorer.

---

## API key errors (401 Unauthorized)

A `401` in the server log means LightRAG is rejecting the API key for the graph logic model or embedding model.

1. Settings → Providers — confirm the key for the provider used in Graph & Vault is correct and active.
2. Some providers (Groq, OpenRouter) require the key in the `Authorization: Bearer` header — this is handled automatically, but verify the key format in the provider's dashboard.
3. If you recently rotated the key, update it in Providers and click **Restart Server** to apply.

---

## All documents re-processing after vault rename or move

If you rename or move your vault folder, Neural Composer marks all notes for re-ingestion. This happens because the plugin tracks documents by full path, and a vault rename changes every path at once.

Re-ingestion after a vault rename is a one-time event. Let it complete (dots cycle 🟡 → 🟢). Future saves only re-ingest files you actually change.

If you accidentally renamed and then undid the rename, restart Obsidian before the pipeline finishes to cancel the queue.

---

## Large vault performance issues

### Ingestion is very slow

For vaults with thousands of notes, ingestion can take hours on the first run. Tips:

- Increase **Async workers** (Settings → Advanced → Performance tuning). Start with `8`, monitor your API usage.
- Use a cost-efficient graph logic model (e.g., `gpt-4o-mini` or `gemini-flash`) — it's called for every chunk.
- Ingest in batches: right-click individual subfolders rather than the entire vault at once.
- Run the first ingestion overnight with **Auto-start** on.

### High memory usage

LightRAG keeps graph and vector indexes in memory while the server is running. On very large graphs (100k+ nodes), RAM usage can exceed 4 GB.

- Use **Max parallel insert = 1** (Settings → Advanced) to reduce peak memory during ingestion.
- If your machine has limited RAM, consider running LightRAG on a remote server (NAS or VPS). See the [Remote Server](Remote-Server) page.

### Obsidian becomes slow with many status dots

The file explorer re-renders status dots on every status update. With very large watched folders, this can cause UI lag during bulk ingestion. Workaround: temporarily clear the **Watched Folder** field during the initial bulk ingest, then re-enable it for ongoing sync.

---

## Custom entity guidance is not taking effect

Check the following:

1. Each editor line uses `PascalCaseName: description` and no validation error appears below the field.
2. Leave the editor so the status changes from editing to saved.
3. Restart LightRAG after saving.
4. Reprocess affected documents. Existing graph entities retain their old types until reprocessed.
5. For a managed local server, confirm the graph data directory contains `prompts/entity_type/neural-composer.yml`.

Neural Composer configures the YAML profile automatically for managed local servers. For a remote LightRAG instance, create and configure the equivalent entity-type YAML profile on the server host.

---

## Server log shows Python ImportError or ModuleNotFoundError

The LightRAG package or one of its dependencies is not installed in the Python environment pointed to by **Command Path**.

This usually happens when:
- You installed `lightrag-hku[api]` in one venv but the Command Path points to a different Python install.
- You updated the OS and the venv path changed.

Fix: activate the correct venv, run `pip install "lightrag-hku[api]"`, then re-run `which lightrag-server` and update the Command Path.
