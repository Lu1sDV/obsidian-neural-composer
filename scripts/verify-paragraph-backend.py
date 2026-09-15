"""Check the native parser/chunker contract using an installed LightRAG backend.

Run with the backend virtualenv's Python. No server, vault, LLM, or embeddings
are used. A failed content-preservation check blocks the paragraph release.
"""

import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory

from lightrag.chunker.paragraph_semantic import chunking_by_paragraph_semantic
from lightrag.utils import TiktokenTokenizer


MARKDOWN = """---
title: Synthetic paragraph contract
---
# Alpha

Alpha widgets are blue and maintained on Monday.

## Alpha details

```markdown
# Code heading must not create a section
[[Literal wiki reference]]
```

| component_header_contract | limit_header_contract |
| --- | --- |
| Widget | 10 |
| Sensor | 20 |

<table>
<tr><th>html_header_contract</th><th>html_limit_contract</th></tr>
<tr><td>HtmlWidget</td><td>37</td></tr>
</table>

# Beta

Beta widgets are red and maintained on Friday.

[[Synthetic note]] and ![[Synthetic attachment.png]] remain literal.

![Unfetched image](https://example.invalid/paragraph-contract.png)
"""

OVERSIZED_MARKERS = [f"oversize_marker_{index:03d}" for index in range(120)]
MARKDOWN += "\n# Oversized section\n\n" + " ".join(OVERSIZED_MARKERS) + "\n"


def main() -> int:
    with TemporaryDirectory(prefix="nc-paragraph-contract-") as directory:
        root = Path(directory)
        source = root / "contract.md"
        source.write_text(MARKDOWN, encoding="utf-8")
        environment = {
            **os.environ,
            "NATIVE_MD_IMAGE_DOWNLOAD_ENABLED": "false",
            "DOCX_SMART_HEADING": "false",
        }
        subprocess.run(
            [sys.executable, "-m", "lightrag.parser.cli", str(source),
             "--engine", "native", "--preview", "0"],
            cwd=root, env=environment, check=True,
        )
        sidecar = root / "contract.md.parsed" / "contract.blocks.jsonl"
        rows = [json.loads(line) for line in sidecar.read_text(encoding="utf-8").splitlines()]
        blocks = [row for row in rows if row["type"] == "content"]
        text = "\n\n".join(row["content"] for row in blocks)
        tokenizer = TiktokenTokenizer()
        chunks = chunking_by_paragraph_semantic(
            tokenizer, text, 160, blocks_path=str(sidecar),
            chunk_overlap_token_size=20, drop_references=False,
        )
        chunk_text = "\n\n".join(chunk["content"] for chunk in chunks)
        blank = root / "blank.md"
        blank.write_text("", encoding="utf-8")
        blank_result = subprocess.run(
            [sys.executable, "-m", "lightrag.parser.cli", str(blank),
             "--engine", "native", "--preview", "0"],
            cwd=root, env=environment, capture_output=True, text=True,
        )
        blank_has_no_content = blank_result.returncode != 0
        if blank_result.returncode == 0:
            blank_sidecar = root / "blank.md.parsed" / "blank.blocks.jsonl"
            blank_rows = [
                json.loads(line)
                for line in blank_sidecar.read_text(encoding="utf-8").splitlines()
            ]
            blank_has_no_content = not any(
                row.get("content") for row in blank_rows if row["type"] == "content"
            )
        checks = {
            "native structural parser": rows[0].get("parse_engine") == "native",
            "heading-aware paragraph output": bool(chunks) and all("heading" in c for c in chunks),
            "token cap": bool(chunks) and all(len(tokenizer.encode(c["content"])) <= 160 for c in chunks),
            "code heading is not structural": all(b["heading"] != "Code heading must not create a section" for b in blocks),
            "frontmatter text retained": "Synthetic paragraph contract" in chunk_text,
            "wikilinks remain literal": "[[Synthetic note]]" in chunk_text and "![[Synthetic attachment.png]]" in chunk_text,
            "no external-image sidecar artifacts": not list(sidecar.parent.glob("*.drawings.json")),
            "table rows retained": "Widget" in chunk_text and "Sensor" in chunk_text,
            "table headers retained in chunk text": "component_header_contract" in chunk_text and "limit_header_contract" in chunk_text,
            "HTML table data retained": all(marker in chunk_text for marker in ("html_header_contract", "html_limit_contract", "HtmlWidget", "37")),
            "oversized section fully retained": all(marker in chunk_text for marker in OVERSIZED_MARKERS),
            "blank note produces no phantom content": blank_has_no_content and blank.read_text(encoding="utf-8") == "",
            "vault source unchanged": source.read_text(encoding="utf-8") == MARKDOWN,
        }
        for name, passed in checks.items():
            print(f"{'PASS' if passed else 'FAIL'}: {name}")
        if not all(checks.values()):
            print("Paragraph release blocked: installed upstream backend does not satisfy the content contract.")
            return 1
        print("Native parser/chunker contract passed. HTTP ingestion and Obsidian checks are separate.")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
