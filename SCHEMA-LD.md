# Memspec Linked-Data Schema

Companion to `context.jsonld`. Documents how memspec's YAML frontmatter projects to RDF via standard vocabularies (Dublin Core, PROV-O, SKOS), the rationale for each mapping, and the recipe for actually running the projection.

**Not to be confused with `SCHEMA.md`.** The auto-generated `SCHEMA.md` (rendered from `src/lib/schema.ts` Zod definitions via `npm run schema`) is the tool's canonical field-by-field reference: types, required-ness, defaults, descriptions. This file (`SCHEMA-LD.md`) is a linked-data view of the same schema — how each field maps to a standard vocabulary term for RDF interop. Read `SCHEMA.md` for the format contract; read this file if you want to project a memspec store to Turtle or share it with an RDF-native tool.

**Why this exists.** Memspec's frontmatter is the load-bearing schema, and until now it lived only in tool code and prose. Making it explicit as JSON-LD costs nothing at runtime — the storage layer is unchanged — but opens a projection path for any downstream tool that speaks RDF: SPARQL queries over supersede chains, PROV-O interop, cross-agent memory share. Verified 2026-07-03 against a live 257-record store.

**Prior art influence.** Inspired by the Vault-LD spec (`The-Knowledge-Graph-Guys/vault-ld`, 2026-06). Memspec deliberately does NOT adopt Vault-LD's directory conventions, IRI-from-filename minting, or roundtrip guarantees — the temporal + provenance discipline memspec relies on (`check_by`, supersede chains, witness ranking) has no counterpart in Vault-LD. This schema is a light-touch semantic mapping only.

---

## Namespaces

| Prefix | IRI | Role |
|---|---|---|
| `memspec:` | `https://memspec.dev/vocab#` | Memspec-specific terms. Placeholder namespace; rewrite if publishing under your own domain. |
| `prov:` | `http://www.w3.org/ns/prov#` | W3C PROV-O — provenance ontology (source, revision). |
| `dcterms:` | `http://purl.org/dc/terms/` | Dublin Core Terms — created, subject, requires. |
| `skos:` | `http://www.w3.org/2004/02/skos/core#` | Simple Knowledge Organization System — concept vocabularies (state values, witness levels). |
| `rdf:` / `rdfs:` | standard | Base RDF. |
| `xsd:` | standard | XML Schema datatypes (dateTime, integer, decimal). |

**Note on `memspec.dev`.** The IRI does not need to resolve. Standard vocabularies (Dublin Core, PROV-O, SKOS) do resolve and are stable. If you ever publish the memspec store under a real domain, rewrite `https://memspec.dev/` throughout — no data change required.

---

## Top-level fields

Every field in the 2026-07-03 inventory (18 fields, 257 records) is mapped below.

| Field | Maps to | Datatype | Rationale |
|---|---|---|---|
| `id` | `@id` (JSON-LD keyword) | — | Standard JSON-LD identity alias. IRI minted from ULID + `@base`. |
| `type` | `@type` (JSON-LD keyword) | — | Class of the memory. Values become `memspec:Fact`, `memspec:Decision`, `memspec:Procedure`, `memspec:Observation` (all defined in the `@graph`). |
| `kind` | `memspec:kind` | string | Always `"claim"` in the current store. Preserved for future extensibility (retrospective, hypothesis, etc.). No standard equivalent. |
| `state` | `memspec:state` | SKOS Concept IRI | Lifecycle: `active` / `superseded` / `captured`. Defined as SKOS concepts in the `@graph` because they form a controlled vocabulary. |
| `created` | `dcterms:created` | `xsd:dateTime` | Exact Dublin Core match. |
| `source` | `prov:wasAttributedTo` | IRI (under `memspec:source/`) | PROV's standard predicate for attribution. String values (`therin`, `therin-2026-06-24`, `openclaw-import`, `claude-code`) coerce to IRIs relative to `memspec:source/`. |
| `source_kind` | `memspec:sourceKind` | SKOS Concept IRI | Class of source: `agent` / `import`. Not a PROV concept (PROV has `Agent` subclasses, but memspec's `import` doesn't fit `SoftwareAgent`/`Person`/`Organization`). SKOS concept vocabulary is the clean fit. |
| `tags` | `dcterms:subject` | Set of SKOS Concept IRIs (under `memspec:tag/`) | Dublin Core `subject` is the standard for topical classification. Each tag becomes a SKOS concept IRI — gives you a taxonomy path if you ever want one, without requiring it. |
| `check_by` | `memspec:checkBy` | `xsd:dateTime` | No standard equivalent. `dcterms:valid` was considered but expects date-range syntax, not a single expiry timestamp. This is memspec's decay mechanism — deserves its own term. |
| `last_verified` | `memspec:lastVerified` | `xsd:dateTime` | No standard fit. `dcterms:modified` is "date changed," which isn't quite "last time we re-verified this claim was still true." |
| `verified_with` | `memspec:verifiedWith` | SKOS Concept IRI | Witness level: `anchor` / `operator` / `evidence` / `assertion`. Defined as SKOS concepts in the `@graph` — this IS the witness chain from CLAUDE.md, made explicit. |
| `supersedes` | `prov:wasRevisionOf` | Set of IRIs | Exact PROV match — "this record is a revision of these prior records." Standard vocabulary at its best. |
| `supersede_reason` | `memspec:supersedeReason` | string | No standard fit for the free-text reason. |
| `conflicts_with` | `memspec:conflictsWith` | Set of IRIs | OWL has `owl:differentFrom` but that's for individuals, not claims. Memspec-specific. |
| `depends_on` | `dcterms:requires` | Set of IRIs | Dublin Core's "the described resource requires the referenced resource" is a clean fit for "this claim/procedure builds on those." |
| `supports` | `memspec:supports` | Set of IRIs | `prov:wasDerivedFrom` was considered (reverse direction) but the semantics don't match. Memspec-specific. |
| `anchors` | `memspec:anchor` | Set of nested objects | Concrete artifacts (file + optional line/sha) the claim points at. Nested context maps `file`, `line`, `sha`, `type` sub-keys. |
| `ext` | `memspec:ext` | Nested object | Extension bag. See §Extension bag. |

---

## Value vocabularies (SKOS concepts, defined in `@graph`)

### Lifecycle (`state`)
- `memspec:active` — live memory returned by default queries.
- `memspec:superseded` — replaced by a newer record; retained for history.
- `memspec:retired` — no longer relevant. Distinct from superseded — nothing replaces it.

### Witness (`verified_with`) — from strongest to weakest
- `memspec:anchor` — claim points at concrete artifact (file, commit, output).
- `memspec:operator` — human-asserted (Siim / user). Protected from agent overwrite.
- `memspec:evidence` — derived from tool output the agent observed at write time.
- `memspec:assertion` — weakest witness: agent-asserted without direct evidence.

### Source kind (`source_kind`)
- `memspec:operator` — record written by a human (Siim / user). Shared with the witness vocabulary; the same concept covers both "who wrote it" and "who asserted it," and gets `override_operator: true` protection on supersede in either role.
- `memspec:agent` — record written by an autonomous agent.
- `memspec:import` — record migrated from a prior system (e.g., openclaw-import).

No `memspec:operator` records exist in the 2026-07-03 store, but the enum in `src/lib/schema.ts` permits it — the vocabulary is complete for the format, not just for current data.

---

## Extension bag (`ext.*`)

The `ext` field is a nested object holding fields memspec doesn't want at the top level. Nested context in `context.jsonld` maps each known sub-key:

| Field | Maps to | Datatype | Origin |
|---|---|---|---|
| `ext.legacy_confidence` | `memspec:legacyConfidence` | `xsd:decimal` | v0.2 numeric confidence, retired in v0.3 in favor of witness chain. Preserved for archival. |
| `ext.confirmations` | `memspec:confirmations` | `xsd:integer` | Stabilization gate counter (how many re-encounters). |
| `ext.confirmed_by` | `memspec:confirmedBy` | Set of strings | Session IDs that confirmed. |
| `ext.importance` | `memspec:importance` | `xsd:integer` | OpenClaw-import artifact. Not written by v0.3+. |
| `ext.openclaw_type` | `memspec:openclawType` | string | OpenClaw-import artifact. |
| `ext.promoted_at` | `memspec:promotedAt` | `xsd:dateTime` | Timestamp when a `captured` record was promoted to `active`. |

New `ext.*` sub-keys not in this table will appear in JSON-LD output under `memspec:ext` but without a specific term — flag them and extend the context when they earn permanence.

---

## What isn't mapped (deliberately)

- **The Markdown body.** Bodies are prose for humans and LLMs, not RDF. This matches Vault-LD's `§5.3` design ("bodies asymmetric by design").
- **Empty tag arrays.** `tags: []` produces no triples. Harmless.
- **Runtime state** (dream-pass proposals, stale-flag reads). These are computed at read time and never written to disk — no schema needed.

## What's silent (worth knowing)

- **Language tags.** No `@language` convention. All strings are treated as untyped literals. Fine while memspec is English-only.
- **Blank nodes.** No RDF ingestion path today, so blank-node handling is undefined. If a future `memspec_import_rdf` is added, decide then.
- **Named graphs.** Format is triple-only. `@graph` in `context.jsonld` is used only to define the class + concept vocabulary, not to partition instance data.

---

## Recipe: project the store to Turtle

If you ever want to run a graph query over the store, install pyld and run something like:

```bash
pip install pyld pyyaml rdflib
```

```python
# scripts/memspec_to_rdf.py (sketch)
import json, os, re, yaml
from pyld import jsonld
from rdflib import Graph

# Adjust to wherever your memspec install lives. Ships with the memspec source project.
CONTEXT_PATH = os.path.expanduser("~/.openclaw/workspace/projects/memspec/context.jsonld")
CONTEXT = json.load(open(CONTEXT_PATH))
g = Graph()

for root, dirs, files in os.walk(os.path.expanduser("~/.memspec/memory")):
    for f in files:
        if not f.endswith(".md"): continue
        text = open(os.path.join(root, f)).read()
        m = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
        if not m: continue
        fm = yaml.safe_load(m.group(1))
        # Coerce id to IRI, apply context
        doc = {"@context": CONTEXT["@context"], **fm}
        doc["id"] = f"https://memspec.dev/mem/{fm['id']}"
        nq = jsonld.to_rdf(doc, {"format": "application/n-quads"})
        g.parse(data=nq, format="nquads")

g.serialize("build/memspec.ttl", format="turtle")
```

Not shipped as a memspec tool because there's no current consumer of the Turtle output. If you want one, this is roughly the shape.

---

## Change log

- **2026-07-03**: initial schema. 18 top-level fields, 6 ext sub-keys, 13 vocab entries in `@graph`. Verified against 257 records in the store. Two drifts corrected same day: `memspec:captured` → `memspec:retired` (matches `src/lib/schema.ts` enum), `memspec:operator` broadened to cover both source_kind and verified_with roles.
