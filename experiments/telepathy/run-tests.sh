#!/usr/bin/env bash
# Test only in the experiment's own virtual environment. Never fall through to
# a global Python, inherited production DATABASE_URL, or a networked provider.
set -euo pipefail
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="${SCRIPT_DIR}/.venv/bin/python"
if [[ ! -x "${PYTHON}" || ! -f "${SCRIPT_DIR}/.venv/pyvenv.cfg" ]]; then
  printf '%s\n' 'Create the isolated Telepathy .venv first; see experiments/telepathy/README.md.' >&2
  exit 1
fi
export DATABASE_URL='sqlite+aiosqlite:///:memory:'
export LLM_PROVIDER='offline'
export GEMINI_API_KEY=''
export OPENAI_API_KEY=''
export PREBUFFER_BASE_URL='https://example.invalid/test-audio'
exec "${PYTHON}" -I -m pytest -c "${SCRIPT_DIR}/pyproject.toml" "${SCRIPT_DIR}/tests" "$@"
