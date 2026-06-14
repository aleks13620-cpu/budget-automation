# Open-Source Landscape: SKU / Product Matching for Russian Construction SaaS

**Date:** 2026-06-11  
**Scope:** Tools that could REPLACE or AUGMENT the current LLM-heavy matcher  
**Goal:** More durable, cheaper, self-improving matching; on-prem friendly; Russian-language  

---

## Executive Summary (Top 3 to Evaluate First)

| Rank | Tool | Role | Why First |
|------|------|------|-----------|
| 1 | **BGE-M3 / USER-bge-m3** (sentence-transformers) | Semantic embedding backbone | Best proven multilingual+Russian embedder; replaces LLM for most semantic gaps; 428k downloads/month; Apache 2.0; runs on CPU |
| 2 | **sqlite-vec** + BGE-M3 | Vector search directly in existing SQLite | Zero new infra; npm install; keeps current stack intact; ANN over catalog embeddings |
| 3 | **Splink** (Python sidecar) | Entity-resolution / blocking layer | Probabilistic scoring over multiple features (name+unit+standard); MIT; DuckDB backend; 2.2k stars; OpenUK Award 2025; unsupervised OR label-guided |

---

## Category 1 — Entity Resolution / Record Linkage Toolkits

### 1.1 Splink
- **What it is:** Probabilistic record linkage (Fellegi-Sunter model) with configurable blocking and multi-column fuzzy comparison. Developed by UK Ministry of Justice.
- **Repo:** https://github.com/moj-analytical-services/splink  
- **Stars:** 2,200+ | **License:** MIT | **Latest:** v4.0.16 (March 2026)
- **Fit for our context:**
  - Designed for matching records that share NO common unique key — exactly the smeta↔invoice case.
  - Works on ANY structured record: product name + unit + quantity + position — not limited to person data.
  - DuckDB backend means it can run as a Python sidecar reading our SQLite (export to Parquet/CSV, run Splink, import results).
  - Unsupervised mode requires zero labeled pairs to start; can improve with confirmed matches fed back as training labels.
  - Does NOT natively understand Russian morphology — names must be pre-normalized before feeding in.
  - Single-column matching (just "name") is acknowledged to be its weak spot; combining name + unit + GOST standard number + quantity gives it multiple signals.
- **Self-improving path:** Confirmed operator matches become labeled pairs; Splink model is periodically retrained (EM algorithm).
- **Integration effort:** Python sidecar (~100 LOC glue). High.
- **Verdict:** AUGMENT. Best fit as the "structured scoring layer" on top of normalized names.

### 1.2 dedupe (dedupeio)
- **What it is:** Active-learning record deduplication / record linkage library.
- **Repo:** https://github.com/dedupeio/dedupe  
- **Stars:** 4,500 | **License:** MIT | **Latest release:** 2.0.x (2023, slowing)
- **Fit:**
  - Strengths: active learning loop; human labels guide the model.
  - Weaknesses: primarily used for person/contact data in examples; single-process Python; 2023 was last major release; scaling is limited.
  - Less suited than Splink for large batch runs.
- **Verdict:** SKIP for now — Splink supersedes it for our scale.

### 1.3 Python RecordLinkage Toolkit
- **Repo:** https://github.com/J535D165/recordlinkage  
- **Stars:** 1,100 | **License:** BSD-3 | **Latest:** v0.16 (July 2023)
- **Fit:** Research-focused, small/medium files. Less maintained than Splink. Good as a reference implementation for custom classifiers (Logistic Regression on feature vectors).
- **Verdict:** REFERENCE only — understand the feature-engineering ideas; use Splink for production.

### 1.4 Zingg
- **Repo:** https://github.com/zinggAI/zingg  
- **Stars:** 1,200 | **License:** AGPL-3.0 (copyleft — commercial use requires care) | **Latest:** v0.6.0 (April 2026)
- **Fit:**
  - Spark-based; built for large-scale MDM.
  - Active learning with interactive training builder.
  - Java/Spark dependency is heavy overhead for our TS/Node SQLite stack.
  - AGPL-3.0 is a license concern for SaaS.
  - Supports "products" as entity type explicitly.
- **Verdict:** SKIP — license risk + Spark overhead makes it wrong for our size.

---

## Category 2 — Semantic Embedding & Vector Search

### 2.1 BGE-M3 (BAAI) + USER-bge-m3 (deepvk) — RECOMMENDED #1
- **Base model repo:** https://github.com/flagopen/flagembedding (11,800 stars, MIT)
- **HuggingFace (base):** https://huggingface.co/BAAI/bge-m3
- **HuggingFace (Russian-tuned):** https://huggingface.co/deepvk/USER-bge-m3 (428k downloads/month, Apache 2.0)
- **What it does:** 
  - Multi-functionality: dense retrieval + sparse (BM25-like learned weights) + multi-vector (ColBERT) — all in one model.
  - 1024-dimensional vectors; input up to 8,192 tokens.
  - 100+ languages; deepvk fine-tune pushes Russian MTEB average from 0.689 → 0.706, STS 0.735 → 0.753.
- **Fit for our context:**
  - Directly resolves brand-synonym gaps: "Сильфонный компенсатор ОСТ 36-146-88" ↔ "Компенсатор AYVAZ DN…" will land near each other in embedding space.
  - On-prem: runs on CPU via sentence-transformers Python; no cloud API call.
  - Self-improving: once confirmed matches accumulate (>200-500 pairs), fine-tune with `sentence-transformers` triplet loss or MultipleNegativesRanking loss — standard documented workflow.
  - Sparse output can double as BM25-style keyword fallback in the same inference call.
  - Python sidecar or ONNX-export + `onnxruntime` for Node.js (no Python dependency in prod).
- **Integration effort:** Medium. Python embedding service (Flask/FastAPI ~50 LOC) called from Node, OR ONNX port.
- **Cost:** Zero marginal cost per query after deployment — eliminates most LLM calls.
- **Verdict:** REPLACE LLM for semantic gap resolution (tier 2.5 / tier 3 catalog search). Top priority.

### 2.2 LaBSE (Google)
- **HuggingFace:** https://huggingface.co/sentence-transformers/LaBSE (109 languages)
- **Stars (sbert.net):** widely used, 100k+ monthly downloads
- **License:** Apache 2.0
- **Fit:** Excellent bitext mining (cross-lingual parallel sentence retrieval). Russian is supported. However, 2024-2025 benchmarks show BGE-M3 surpasses LaBSE on most Russian retrieval tasks. LaBSE still wins on cross-lingual alignment (RU→EN pairs).
- **When to use:** If we ever need to match Russian estimates against English-labeled catalogs (cross-lingual).
- **Verdict:** AUGMENT as fallback / cross-lingual; BGE-M3 preferred for monolingual RU.

### 2.3 multilingual-e5 (Microsoft)
- **HuggingFace:** https://huggingface.co/embaas/sentence-transformers-multilingual-e5-large
- **License:** MIT
- **Fit:** Strong multilingual embedding with good Russian scores. Slightly lower on Russian-specific benchmarks than USER-bge-m3. Useful as a second opinion or ensemble component.
- **Verdict:** AUGMENT / ensemble; USER-bge-m3 preferred as primary.

### 2.4 sqlite-vec — RECOMMENDED #2
- **Repo:** https://github.com/asg017/sqlite-vec (7,700 stars, Apache-2.0 / MIT dual)
- **Latest:** v0.1.9 (March 2026) — pre-v1, API may change
- **npm:** `npm install sqlite-vec` — direct Node.js integration
- **What it does:** SQLite extension for K-nearest-neighbor vector search over float/int8/binary vectors. Works with the existing `better-sqlite3` or `sqlite3` npm packages.
- **Fit:**
  - Zero new infra: vectors stored in same SQLite DB where matches live.
  - Tutorial exists specifically for TypeScript: https://github.com/stephenc222/example-sqlite-vec-tutorial
  - Pre-v1 warning: breaking changes possible; pin version.
  - Catalog size is the limiting factor for ANN quality — we have ~1800 aliases now, well within SQLite-vec sweet spot.
  - Recommended workflow: embed all catalog entries with USER-bge-m3 once; store in `vec_items` virtual table; at match time embed query name and run KNN top-5 → feed to reranker or directly to threshold check.
- **Integration effort:** Low-Medium. Add sqlite-vec npm package + Python embedding sidecar.
- **Verdict:** REPLACE dedicated vector DB (no Qdrant/FAISS overhead needed at our scale).

### 2.5 Qdrant
- **Repo:** https://github.com/qdrant/qdrant (~22k stars, Apache 2.0)
- **TS SDK:** https://github.com/qdrant/qdrant-js
- **Fit:** Excellent for >100k vectors, payload filtering, production-grade. For our current catalog size (~1800-5000 entries) it is overengineered — requires a separate Docker service.
- **Verdict:** DEFER — revisit when catalog exceeds ~50k entries.

### 2.6 RapidFuzz
- **Repo:** https://github.com/rapidfuzz/RapidFuzz (Python, C++ core)
- **npm equivalent:** `@3leaps/string-metrics-wasm` (WASM bindings to rapidfuzz-rs)
- **License:** MIT
- **Fit:** We already use Dice/similar. RapidFuzz adds Jaro-Winkler, token-sort-ratio, partial-ratio — faster and more metrics than fuzzywuzzy. The WASM npm package brings these directly to Node.js without a Python sidecar.
- **Verdict:** AUGMENT — replace current Dice similarity with RapidFuzz WASM for the string-similarity tier (tier 1). Low effort, immediate gain.

---

## Category 3 — Russian Product NER / Attribute Extraction

### 3.1 Natasha / Yargy
- **Repo:** https://github.com/natasha/natasha (1,300 stars, MIT)
- **Yargy repo:** https://github.com/natasha/yargy (rule-based fact extraction for Russian)
- **What it does:** Full Russian NLP pipeline: tokenization, morphology, lemmatization, NER (person/org/location), fact extraction via grammar rules.
- **Fit for our context:**
  - Out-of-box NER covers persons/orgs/dates/amounts — NOT construction product attributes.
  - **Yargy** is the relevant component: write custom grammars for Russian product names to extract DN/PN values, ГОСТ/ОСТ codes, material types, wall thicknesses, etc.
  - Used in production at Sberbank, Interfax — mature, CPU-friendly.
  - No GPU required; runs on Numpy/CPU.
- **What needs building:** Custom Yargy grammar rules for pipe/fitting attributes (DN, PN, schedule, material, standard code). This is 1-2 days of rule authoring — not a large project.
- **Self-improving path:** Rules are deterministic; confirmed parse corrections become rule refinements.
- **Integration effort:** Medium (Python sidecar). Grammar rules require domain knowledge.
- **Verdict:** BUILD custom Yargy grammar as the "attribute extraction" layer feeding normalized keys into embedding matching. Strongly supports the "clean representation" strategic lever.

### 3.2 Gherman/bert-base-NER-Russian
- **HuggingFace:** https://huggingface.co/Gherman/bert-base-NER-Russian
- **Fit:** General Russian NER (person/org/location). Not specialized for product attributes. Low relevance.
- **Verdict:** SKIP.

---

## Category 4 — Russian Construction Taxonomies / Classifiers

### 4.1 КСИ (Классификатор строительной информации) — ФАУ ФЦС
- **URL:** http://ksi.faufcc.ru/ | **API docs:** http://ksi.faufcc.ru/apihelp.php
- **What it is:** Official Russian government construction information classifier. 21 tables, 30,000+ elements. Synchronized with IFC 4.0, ГЭСН, ОКПД2. Updated quarterly.
- **API:** REST-ish HTTP API. `getFullInfo` returns code, level, parent class, synonyms, status, cross-classifier mappings.
- **Fit:**
  - Provides official Russian construction taxonomy — pipe types, fittings, valves, structural elements — with standard codes and synonyms.
  - Can serve as a BACKBONE CATALOG: map our confirmed aliases to КСИ codes, then use codes to find equivalent names across suppliers.
  - Cross-mapping to ГЭСН/ОКПД2 is useful for matching smeta line items (ГЭСН codes) to supplier products.
  - **Caveat:** The API is on a government HTTP server — reliability and rate limits are unknown. No SLA. Data may not cover niche products.
  - **Not downloadable as an open bulk dataset** (no confirmed CSV/dump link found).
- **Integration effort:** Medium. Write a scraper/cache layer that mirrors the 30k entries locally, then cross-reference.
- **Verdict:** AUGMENT catalog backbone. Fetch once, cache locally. Use КСИ synonyms to bootstrap catalog aliases.

### 4.2 ОКПД2
- **URL:** https://classifikators.ru/okpd | https://economy.gov.ru (Минэкономразвития)
- **What it is:** All-Russian product classifier by type of economic activity. Hierarchical codes (e.g., 23.61 = concrete products). 
- **Fit:** Section F (construction) and C.23/C.24/C.25/C.28 cover construction materials. Can be downloaded as Excel/PDF from classifikators.ru or Rosstat. Provides a shallow taxonomy rather than rich synonyms.
- **Verdict:** AUGMENT — useful for category-level blocking (only compare items in the same ОКПД2 subtree). Not enough for name-level disambiguation.

### 4.3 ФГИС ЦС / ФССЦ
- **URL:** https://fgiscs.minstroyrf.ru/
- **What it is:** Federal price database for construction materials (ФССЦ prices from manufacturers).
- **Fit:** Contains МАТЕРИАЛ НАИМЕНОВАНИЕ + ЕДИНИЦА + manufacturer-reported prices. This is a gold mine of normalized Russian construction material names.
- **Caveat:** No confirmed open API or bulk download. Access via the Минстрой web UI only. May require registration. Data is technically "public" but not machine-readable in bulk.
- **Verdict:** INVESTIGATE — if bulk access is possible, ФССЦ names are exactly the canonical forms we need for the catalog.

---

## Category 5 — Product Matching & RAG-over-Catalog Approaches

### 5.1 Hybrid BM25 + Dense Retrieval (Architecture Pattern)
- **Not a single library but a proven architecture pattern** (2025 benchmarks show RRF > either alone):
  1. BM25 (term matching) for recall on exact tokens (ГОСТ numbers, DN sizes, brand codes).
  2. Dense embedding (BGE-M3) for semantic recall on synonym gaps.
  3. Reciprocal Rank Fusion (RRF) to merge lists.
  4. Cross-encoder reranker for top-k candidates (optional; most savings come from steps 1-3).
- **Node.js BM25:** `oramasearch/orama` (npm, MIT, 8.5k stars) provides full-text BM25 in TypeScript with optional vector search.
- **Verdict:** BUILD this pipeline as the primary matching flow, replacing LLM for the top-2 tiers.

### 5.2 wbsg-uni-mannheim ProductBERT / MatchGPT
- **Repos:** https://github.com/wbsg-uni-mannheim (various, 38-66 stars)
- **Fit:** Academic BERT fine-tuning for product matching. Requires WDC product corpus (English). No Russian support. Interesting as a fine-tuning blueprint but not directly usable.
- **Verdict:** REFERENCE only — adapt the fine-tuning recipe for Russian product pairs.

### 5.3 Orama Search (BM25 in TypeScript)
- **Repo:** https://github.com/oramasearch/orama (8,500 stars, Apache 2.0)
- **What it does:** Full-featured in-process search engine in TypeScript — BM25, vector search, facets. Zero external dependencies.
- **Fit:** Could replace our current name-similarity tier with proper BM25 tokenization (handles Russian morphology with a custom stemmer/tokenizer). Runs in Node.js, same process as the backend.
- **Integration effort:** Low. npm install.
- **Verdict:** AUGMENT — replace or enhance current Dice similarity with Orama BM25.

---

## Priority Evaluation Roadmap

### Phase A (1-2 weeks): Zero-infra wins
1. **sqlite-vec npm** + pre-computed USER-bge-m3 embeddings for all catalog entries  
   → ANN retrieval replaces current LLM "no-catalog-match" fallback  
2. **RapidFuzz WASM** (`@3leaps/string-metrics-wasm`) as drop-in for current Dice  
   → Better string similarity, same Node.js process, no Python  

### Phase B (2-4 weeks): Python embedding sidecar
3. Deploy **USER-bge-m3** as a local Python embedding service (FastAPI, 1 file)  
   → Encode all smeta + catalog items; store vectors in sqlite-vec  
   → Hybrid BM25 (Orama) + vector (sqlite-vec) with RRF merge  
   → Expected: covers most of the "semantic gap" class B failures without any LLM calls  

### Phase C (4-8 weeks): Structured attribute extraction + entity resolution
4. **Yargy custom grammar** for pipe/fitting attribute extraction  
   → Produces `{type, dn, pn, material, standard}` structured keys  
   → Feeds as additional columns into Splink-style probabilistic scoring  
5. **КСИ API scrape** → local synonym dictionary bootstrapping the catalog  
6. **Splink** probabilistic layer for ambiguous candidates (score on name + unit + attributes)  

### Phase D (ongoing): Self-improvement loop
7. Every confirmed operator match → fine-tuning pair for USER-bge-m3 domain adaptation  
   → With ~500+ pairs: fine-tune with `MultipleNegativesRankingLoss`; baked into monthly retrain  

---

## Key Sources

- Splink: https://github.com/moj-analytical-services/splink
- FlagEmbedding / BGE-M3: https://github.com/flagopen/flagembedding
- USER-bge-m3 (Russian): https://huggingface.co/deepvk/USER-bge-m3
- LaBSE: https://www.aimodels.fyi/models/huggingFace/labse-sentence-transformers
- multilingual-e5: https://huggingface.co/embaas/sentence-transformers-multilingual-e5-large
- sqlite-vec: https://github.com/asg017/sqlite-vec
- sqlite-vec TypeScript tutorial: https://github.com/stephenc222/example-sqlite-vec-tutorial
- Qdrant: https://github.com/qdrant/qdrant
- RapidFuzz Python: https://github.com/rapidfuzz/RapidFuzz
- RapidFuzz WASM for npm: https://www.npmjs.com/package/@3leaps/string-metrics-wasm
- Natasha (Russian NLP): https://github.com/natasha/natasha
- Yargy (rule-based extraction): https://github.com/natasha/yargy
- dedupe.io: https://github.com/dedupeio/dedupe
- Python RecordLinkage: https://github.com/J535D165/recordlinkage
- Zingg: https://github.com/zinggAI/zingg
- КСИ API: http://ksi.faufcc.ru/apihelp.php
- ОКПД2: https://classifikators.ru/okpd
- ФГИС ЦС: https://fgiscs.minstroyrf.ru/
- data-matching-software list: https://github.com/J535D165/data-matching-software
- Awesome Entity Resolution: https://github.com/OlivierBinette/Awesome-Entity-Resolution
- ruMTEB benchmark paper: https://arxiv.org/pdf/2408.12503
- Hybrid search (BM25 + vector) 2026 guide: https://www.digitalapplied.com/blog/hybrid-search-bm25-vector-reranking-reference-2026
