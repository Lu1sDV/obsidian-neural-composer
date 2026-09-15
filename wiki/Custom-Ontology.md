# Custom Ontology

By default, LightRAG extracts a broad set of entity types from your notes: `Person`, `Organization`, `Location`, `Event`, `Concept`, and so on. Custom Ontology lets you replace this default set with types specific to your domain, so the graph reflects the vocabulary of your work.

---

## Why it matters

The entity types you define shape what LightRAG pays attention to during ingestion. With the default types, a machine learning researcher's notes will generate `Person` (authors) and `Concept` (algorithms), but miss domain-specific categories like `Dataset`, `Experiment`, or `Benchmark`. A novelist's notes will miss `Character` and `PlotArc`.

Defining the right entity types produces a graph that is:
- More precisely structured around your domain
- Better at multi-hop reasoning across domain-specific relationships
- Easier to explore in the graph visualization (nodes are categorized correctly)

---

## Configure custom guidance

1. Open **Settings → Neural Composer → Graph & Vault → Ontology**.
2. Toggle **Use custom entity types** on.
3. Enter one type per line as `PascalCaseName: description`.
4. Leave the field to validate and save the changes.
5. Click **Restart server now**, then reprocess affected documents.

Example:

```text
Person: Human individuals, real or fictional
Organization: Companies, institutions, government bodies, or groups
Dataset: A structured collection of observations used for analysis
Experiment: A controlled study with a defined setup and outcome
Method: A procedure, technique, algorithm, or workflow
Vulnerability: A weakness or condition that can cause harm or be exploited
```

The name becomes the entity type stored in the graph. The description is sent to the extraction model and should define what belongs in the category. An invalid line or duplicate name is shown below the editor and is not saved.

For a managed local server, Neural Composer creates `prompts/entity_type/neural-composer.yml` under the graph data directory and configures `PROMPT_DIR` and `ENTITY_TYPE_PROMPT_FILE` automatically. It also emits the legacy `ENTITY_TYPES` list for older LightRAG servers. The generated YAML file is plugin-owned and will be replaced when the guidance changes.

Remote LightRAG instances cannot be configured through the local filesystem. Configure an equivalent YAML entity-type profile on the remote server host.

### Tips for choosing entity types

- **Keep it to 8–15 types.** Too many similar choices reduce classification consistency.
- **Use singular PascalCase names.** Use `ResearchPaper`, not `research papers`.
- **Describe the boundary.** Explain what belongs in a type instead of merely restating its name.
- **Avoid unnecessary overlap.** Keep both `Theory` and `Concept` only when that distinction helps retrieval or graph browsing.
- **Test with a small folder first** before reprocessing the entire vault.

### Generate from representative notes

The optional **Source folder for generation** is used only when you click **Generate from folder**. Neural Composer samples up to five supported files from that vault folder and asks the configured chat model to propose 8–15 described entity types.

Review the generated lines before restarting LightRAG. The source folder is not automatically ingested and LightRAG does not read it at startup.

---

## Changing entity types on an existing graph

**You don't need to delete the graph to change entity types.** New and re-ingested notes will use the new types. Existing nodes in the graph retain their original types until those notes are re-ingested.

If you want the entire graph to use the new types:
1. Change the entity type guidance.
2. Delete the LightRAG data directory contents (or use a fresh directory).
3. Re-ingest all notes.

This is a destructive operation — the graph is rebuilt from scratch — but it's the only way to guarantee consistency across all nodes.

---

## Source folder for generation (optional)

Set **Source folder for generation** to a vault folder containing representative notes, glossaries, or reference material. Neural Composer samples up to five supported files from it only when you click **Generate from folder**.

This setting does not ingest the folder, and LightRAG does not read it directly.
