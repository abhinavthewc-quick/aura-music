# Telepathy experiment (not deployed)

This directory preserves Aura's psycho-acoustic recommendation prototype for
research. It is outside both `src/` and `functions/`: Vite does not bundle it and
Cloudflare Pages does not deploy these endpoints.

It is **not a product feature or a public service**. The Cloudflare prototype
uses request-supplied candidates/events and example fallbacks. The separate
Python service has its own database/scoring model; the existing file name
`llm_profiler.py` now contains deterministic mathematical profiling, not an LLM
client. Neither service has Aura's production catalogue, consent, identity,
authorization, or playback contract. Do not expose either API publicly.

## Contents

- `browser/` — disconnected browser telemetry/scoring client.
- `cloudflare-api/` — non-deployed Pages Function prototypes.
- `telepathy/` — Python FastAPI/scoring/DSP prototype.
- `tests/` — offline unit and in-process API tests.
- `migrations/` — prototype PostgreSQL schema, not a deployed application DB.
- `AGENT_SPEC.md` — original research specification, not a claim of shipped scope.
- `requirements-test.lock` — exact dependencies used for the verified CPython
  3.12 test environment.
- `run-tests.sh` — isolated test runner; it refuses to use a global Python.

## Reproduce the test environment

Python 3.11+ is declared; CPython **3.12** is the verified scientific-wheel
runtime. Use a compatible Python rather than the host's newest interpreter if
NumPy/Numba/SciPy wheels are unavailable.

From this directory:

```bash
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements-test.lock
.venv/bin/python -m pip install --no-deps -e .
./run-tests.sh -q
```

Alternatively, install the declared dependency ranges and test extra:

```bash
.venv/bin/python -m pip install -e '.[test]'
./run-tests.sh -q
```

The package explicitly declares setuptools discovery and `sqlalchemy[asyncio]`
(including `greenlet`) so editable installation does not accidentally package
research assets or fail while importing the asynchronous database layer.

From the repository root the same safe runner is:

```bash
bash experiments/telepathy/run-tests.sh -q
```

## Test isolation

- The runner and test bootstrap replace inherited `DATABASE_URL` with an
  **in-memory SQLite database before importing the global database singleton**.
- Every test gets a fresh database; connections are disposed afterwards.
- Provider keys are cleared. Metadata and lyrics use local, deterministic
  fixtures; the mathematical profiler and DSP extraction remain real code.
- External HTTP transports and Internet socket connections are blocked. The API
  tests use `httpx.ASGITransport` in-process, not a listening server.
- No actual MusicBrainz/LRCLIB/provider, deployed Pages Function, or production
  database is contacted. Dependency installation only accesses the package
  registry.
- Tests passed: **14/14** in the isolated CPython 3.12 environment. The original
  API timing test measures a warmed local request; it is not a production
  latency/SLA guarantee.

`.venv/`, database files, Python caches, and editable-install metadata are
ignored by Git. Do not move the API files back under `functions/` or import the
browser client until an approved product contract, consent model, catalogue
enrichment source, and end-to-end acceptance suite exist.
