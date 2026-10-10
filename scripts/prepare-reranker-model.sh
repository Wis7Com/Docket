#!/usr/bin/env bash
# Builds the search-reranker model file (Qwen3-Reranker-0.6B, Q8_0 GGUF) that
# the backend looks for in <userData>/models/.
#
# Why this is a script and not a download: there is no official GGUF of this
# reranker whose chat template we control. The template carries the retrieval
# instruction ("Given a question about ..."), and for this model the
# instruction is part of the prompt the model was trained on, so it changes
# scores. We therefore convert the official weights ourselves and bake our
# own instruction into the GGUF metadata, instead of trusting a third-party
# conversion with an unknown instruction and an unknown llama.cpp vintage.
#
# Why the toolchain is matched to the installed llama.cpp: a GGUF written by
# a converter newer than the llama-server that loads it can carry metadata the
# server does not understand, and Qwen3 reranking support (pooling "rank",
# the yes/no classifier head) has changed between builds. The script reads the
# build number from `llama-server --version` and fetches the converter and
# gguf-py from exactly that git tag (b<build>).
#
# Idempotent: if the output file exists it prints where and exits 0 (use
# --force to rebuild). The output is written to a temp name and renamed only
# after the smoke test passes, so a failed run never leaves a half-good model.
#
# Needs: uv, git (or curl+tar), curl, node (for pick-free-port.js), and
# llama-server + llama-quantize from Homebrew llama.cpp. Weights come from the
# local Hugging Face cache when present, otherwise from huggingface.co (set
# HF_TOKEN if your network needs it). Nothing is installed globally; the
# Python environment is a throwaway venv in the work dir.

set -euo pipefail

readonly HF_REPO="Qwen/Qwen3-Reranker-0.6B"
readonly HF_REVISION="e61197ed45024b0ed8a2d74b80b4d909f1255473"
readonly QUANT="Q8_0"
readonly MODEL_BASENAME="qwen3-reranker-0.6b-q8_0"
readonly DEFAULT_INSTRUCTION="Given a question about the documents in a legal case file, retrieve the passage that answers the question"

# Everything convert_hf_to_gguf.py needs for this model. The sentence-
# transformers files in the repo (modules.json, 1_LogitScore/, ...) are not
# read by the converter. README.md is: the converter recognises a Qwen3
# reranker by its README heading, because the snapshot directory is named
# after a revision hash, not the model.
readonly HF_FILES=(
  README.md
  chat_template.jinja
  config.json
  generation_config.json
  merges.txt
  model.safetensors
  tokenizer.json
  tokenizer_config.json
  vocab.json
)
# Integrity pins for the two big files (Hugging Face LFS blobs are named by
# their sha256). A cache or download that does not match is rejected.
readonly SAFETENSORS_SHA256="27cd75a405b9c1b46b59abfd88aaa209e6fed2a1972cde9b70e7659537c5e65b" # gitleaks:allow (file digest, not a credential)
readonly TOKENIZER_SHA256="aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4" # gitleaks:allow (file digest, not a credential)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

MODELS_DIR="${DOCKET_MODELS_DIR:-$HOME/Library/Application Support/docket-desktop/models}"
INSTRUCTION="$DEFAULT_INSTRUCTION"
FORCE=0
KEEP=0
SMOKE=1
WORK_DIR=""
WORK_IS_TEMP=0
SERVER_PID=""
SUCCESS=0

log() { printf '[prepare-reranker-model] %s\n' "$*"; }
die() { printf '[prepare-reranker-model] ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<EOF
Usage: scripts/prepare-reranker-model.sh [options]

Builds ${MODEL_BASENAME}.gguf (${HF_REPO} @ ${HF_REVISION:0:12}, ${QUANT})
with the retrieval instruction baked into its rerank chat template.

Options:
  --instruction "<text>"  Instruction to bake in. Default:
                          "${DEFAULT_INSTRUCTION}"
  --force                 Rebuild even if the output file already exists.
  --work-dir <path>       Scratch directory (default: a fresh mktemp -d,
                          removed on success unless --keep).
  --keep                  Keep the work directory after success.
  --no-smoke              Skip the llama-server smoke test.
  --help                  Show this help.

Environment:
  DOCKET_MODELS_DIR  Output directory (default:
                     ~/Library/Application Support/docket-desktop/models)
  HF_TOKEN           Optional Hugging Face token, used only for downloads.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --instruction)
      [ $# -ge 2 ] || die "--instruction needs a value"
      INSTRUCTION="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --work-dir)
      [ $# -ge 2 ] || die "--work-dir needs a value"
      WORK_DIR="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --no-smoke) SMOKE=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

[ -n "$INSTRUCTION" ] || die "--instruction must not be empty"
case "$INSTRUCTION" in
  *$'\n'*) die "--instruction must be a single line" ;;
esac

OUT_FILE="$MODELS_DIR/$MODEL_BASENAME.gguf"
OUT_SHA="$OUT_FILE.sha256"
OUT_JSON="$MODELS_DIR/$MODEL_BASENAME.json"

if [ -f "$OUT_FILE" ] && [ "$FORCE" -eq 0 ]; then
  log "already present: $OUT_FILE"
  log "pass --force to rebuild it."
  exit 0
fi

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    # Give it a moment to exit cleanly, then make sure it is gone.
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$SERVER_PID" 2>/dev/null || break
      sleep 0.3
    done
    kill -9 "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [ "$SUCCESS" -eq 1 ] && [ "$WORK_IS_TEMP" -eq 1 ] && [ "$KEEP" -eq 0 ] && [ -n "$WORK_DIR" ]; then
    rm -rf "$WORK_DIR"
  elif [ -n "$WORK_DIR" ] && [ -d "$WORK_DIR" ]; then
    log "work dir kept at: $WORK_DIR"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ---------------------------------------------------------------- prerequisites

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

find_tool() {
  # PATH first, then the two standard Homebrew prefixes.
  local name="$1" dir
  if command -v "$name" >/dev/null 2>&1; then
    command -v "$name"; return 0
  fi
  for dir in /opt/homebrew/bin /usr/local/bin; do
    if [ -x "$dir/$name" ]; then
      printf '%s\n' "$dir/$name"; return 0
    fi
  done
  return 1
}

UV="$(find_tool uv)" || die "uv not found. Install it with: brew install uv"
command -v curl >/dev/null 2>&1 || die "curl not found"
if [ "$SMOKE" -eq 1 ]; then
  command -v node >/dev/null 2>&1 || die "node not found (needed for scripts/pick-free-port.js); use --no-smoke to skip the smoke test"
  [ -f "$REPO_ROOT/scripts/pick-free-port.js" ] || die "missing $REPO_ROOT/scripts/pick-free-port.js"
fi

LLAMA_SERVER="$(find_tool llama-server)" || die "llama-server not found on PATH, /opt/homebrew/bin or /usr/local/bin. Install it with: brew install llama.cpp"
LLAMA_BIN_DIR="$(dirname "$LLAMA_SERVER")"
if [ -x "$LLAMA_BIN_DIR/llama-quantize" ]; then
  LLAMA_QUANTIZE="$LLAMA_BIN_DIR/llama-quantize"
else
  LLAMA_QUANTIZE="$(find_tool llama-quantize)" || die "llama-quantize not found next to $LLAMA_SERVER or on PATH"
fi

VERSION_OUT="$("$LLAMA_SERVER" --version 2>&1 || true)"
LLAMA_BUILD="$(printf '%s\n' "$VERSION_OUT" | sed -nE 's/.*\(build ([0-9]+).*/\1/p' | head -n 1)"
[ -n "$LLAMA_BUILD" ] || die "could not read a build number from '$LLAMA_SERVER --version'. Output was:
$VERSION_OUT"
LLAMA_TAG="b$LLAMA_BUILD"
log "llama-server: $LLAMA_SERVER ($LLAMA_TAG)"
log "llama-quantize: $LLAMA_QUANTIZE"

# ------------------------------------------------------------------- work dir

if [ -z "$WORK_DIR" ]; then
  WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/docket-reranker.XXXXXX")"
  WORK_IS_TEMP=1
else
  mkdir -p "$WORK_DIR"
  WORK_DIR="$(cd "$WORK_DIR" && pwd)"
fi
log "work dir: $WORK_DIR"
mkdir -p "$MODELS_DIR"

SNAPSHOT_DIR="$WORK_DIR/snapshot"
LLAMA_SRC="$WORK_DIR/llama.cpp"
VENV_DIR="$WORK_DIR/venv"
F16_GGUF="$WORK_DIR/f16.gguf"
Q8_GGUF="$WORK_DIR/q8.gguf"
TEMPLATES_JSON="$WORK_DIR/templates.json"
BAKED_GGUF="$WORK_DIR/baked.gguf"
STAGED_GGUF="$MODELS_DIR/.$MODEL_BASENAME.gguf.partial"

# A rerun in a reused work dir starts clean so a stale half-step cannot leak in.
rm -rf "$SNAPSHOT_DIR" "$LLAMA_SRC" "$VENV_DIR" "$F16_GGUF" "$Q8_GGUF" "$TEMPLATES_JSON" "$BAKED_GGUF"

# --------------------------------------------------------------- 1. the weights

HF_CACHE_SNAPSHOT="${HF_HOME:-$HOME/.cache/huggingface}/hub/models--${HF_REPO//\//--}/snapshots/$HF_REVISION"
mkdir -p "$SNAPSHOT_DIR"

if [ -d "$HF_CACHE_SNAPSHOT" ]; then
  log "using Hugging Face cache: $HF_CACHE_SNAPSHOT"
  CACHE_REAL="$(cd "$HF_CACHE_SNAPSHOT" && pwd -P)"
  for f in "${HF_FILES[@]}"; do
    [ -e "$HF_CACHE_SNAPSHOT/$f" ] || die "cached snapshot is missing $f (delete $HF_CACHE_SNAPSHOT to force a fresh download)"
    ln -s "$CACHE_REAL/$f" "$SNAPSHOT_DIR/$f"
  done
else
  log "downloading $HF_REPO @ ${HF_REVISION:0:12} from huggingface.co"
  CURL_AUTH=()
  if [ -n "${HF_TOKEN:-}" ]; then
    CURL_AUTH=(-H "Authorization: Bearer $HF_TOKEN")
  fi
  for f in "${HF_FILES[@]}"; do
    log "  $f"
    curl -fL --retry 3 --silent --show-error "${CURL_AUTH[@]+"${CURL_AUTH[@]}"}" \
      -o "$SNAPSHOT_DIR/$f" \
      "https://huggingface.co/$HF_REPO/resolve/$HF_REVISION/$f" \
      || die "download failed for $f"
  done
fi

# `-s` follows symlinks, so a dangling cache link fails here rather than
# mid-conversion.
for f in "${HF_FILES[@]}"; do
  [ -s "$SNAPSHOT_DIR/$f" ] || die "weights file missing or empty: $SNAPSHOT_DIR/$f"
done
[ "$(sha256_of "$SNAPSHOT_DIR/model.safetensors")" = "$SAFETENSORS_SHA256" ] \
  || die "model.safetensors does not match the pinned sha256 for revision $HF_REVISION"
[ "$(sha256_of "$SNAPSHOT_DIR/tokenizer.json")" = "$TOKENIZER_SHA256" ] \
  || die "tokenizer.json does not match the pinned sha256 for revision $HF_REVISION"
log "weights verified"

# ------------------------------------------------------------ 2. llama.cpp tag

# Only these paths of the llama.cpp tree are needed. conversion/ is the
# per-architecture converter package that convert_hf_to_gguf.py imports in
# recent builds.
SPARSE_PATHS=(/convert_hf_to_gguf.py /conversion/ /gguf-py/ /requirements/)
REPO_URL="https://github.com/ggml-org/llama.cpp"

fetch_with_git() {
  git ls-remote --exit-code --tags "$REPO_URL.git" "refs/tags/$LLAMA_TAG" >/dev/null 2>&1 \
    || die "tag $LLAMA_TAG does not exist in $REPO_URL (is this a locally built llama-server?)"
  git clone --quiet --filter=blob:none --no-checkout --depth 1 --branch "$LLAMA_TAG" "$REPO_URL.git" "$LLAMA_SRC"
  git -C "$LLAMA_SRC" sparse-checkout set --no-cone "${SPARSE_PATHS[@]}"
  git -C "$LLAMA_SRC" checkout --quiet
}

fetch_with_tarball() {
  # Fallback when git is missing. The tag tarball is the whole tree, but
  # extracting only the wanted paths stays correct for any tag, whereas a
  # hardcoded list of raw files would go stale as the converter is split up.
  command -v tar >/dev/null 2>&1 || die "neither git nor tar is available"
  mkdir -p "$LLAMA_SRC"
  curl -fL --retry 3 --silent --show-error \
    "https://codeload.github.com/ggml-org/llama.cpp/tar.gz/refs/tags/$LLAMA_TAG" \
    | tar -xz -C "$LLAMA_SRC" --strip-components=1 \
        '*/convert_hf_to_gguf.py' '*/conversion/*' '*/gguf-py/*' '*/requirements/*' \
    || die "could not fetch $LLAMA_TAG from codeload.github.com"
}

log "fetching converter from llama.cpp $LLAMA_TAG"
if command -v git >/dev/null 2>&1 && [ "${DOCKET_FORCE_TARBALL:-0}" != "1" ]; then
  fetch_with_git
else
  log "git unavailable (or forced off), using tarball fallback"
  fetch_with_tarball
fi

REQ_FILE="$LLAMA_SRC/requirements/requirements-convert_hf_to_gguf.txt"
for p in "$LLAMA_SRC/convert_hf_to_gguf.py" "$LLAMA_SRC/gguf-py/gguf/scripts/gguf_new_metadata.py" "$REQ_FILE"; do
  [ -f "$p" ] || die "expected file missing from llama.cpp $LLAMA_TAG checkout: ${p#"$LLAMA_SRC"/}"
done

# --------------------------------------------------------- 3. Python environment

PY_VERSION=""
for v in 3.12 3.11; do
  if "$UV" venv --quiet --python "$v" "$VENV_DIR" >/dev/null 2>&1; then
    PY_VERSION="$v"; break
  fi
  rm -rf "$VENV_DIR"
done
[ -n "$PY_VERSION" ] || die "uv could not create a Python 3.12 or 3.11 venv (try: uv python install 3.12)"
PY="$VENV_DIR/bin/python"
log "installing converter dependencies (python $PY_VERSION)"
# gguf-py is installed editable from the checkout so the converter and the
# metadata script below run against the very same gguf version.
"$UV" pip install --quiet --python "$PY" -r "$REQ_FILE" -e "$LLAMA_SRC/gguf-py" \
  || die "dependency install failed (requirements: $REQ_FILE)"

# --------------------------------------------------------------- 4. convert+quant

log "converting to GGUF f16"
(
  cd "$LLAMA_SRC"
  HF_HUB_OFFLINE=1 "$PY" convert_hf_to_gguf.py "$SNAPSHOT_DIR" --outtype f16 --outfile "$F16_GGUF"
) || die "convert_hf_to_gguf.py failed"
[ -s "$F16_GGUF" ] || die "converter produced no output at $F16_GGUF"

log "quantizing to $QUANT"
"$LLAMA_QUANTIZE" "$F16_GGUF" "$Q8_GGUF" "$QUANT" >"$WORK_DIR/quantize.log" 2>&1 \
  || die "llama-quantize failed; see $WORK_DIR/quantize.log"
[ -s "$Q8_GGUF" ] || die "llama-quantize produced no output at $Q8_GGUF"

# ------------------------------------------------------------ 5. bake instruction

log "baking instruction into the rerank chat template"
"$PY" -I - "$Q8_GGUF" "$INSTRUCTION" "$TEMPLATES_JSON" <<'PY'
import json
import re
import sys

import gguf

src, instruction, out_json = sys.argv[1], sys.argv[2], sys.argv[3]

reader = gguf.GGUFReader(src)


def read_string(key):
    field = reader.get_field(key)
    if field is None:
        return None
    return field.contents()


default_tpl = read_string("tokenizer.chat_template")
rerank_tpl = read_string("tokenizer.chat_template.rerank")
if rerank_tpl is None:
    sys.exit("converter did not write tokenizer.chat_template.rerank; cannot bake instruction")

# Exactly one <Instruct> line, sitting right before <Query>.
pattern = re.compile(r"(<Instruct>: )[^\n]*(\n<Query>)")
if len(pattern.findall(rerank_tpl)) != 1:
    sys.exit("rerank template does not contain exactly one '<Instruct>: ...' line; "
             "the converter's template layout changed, update this script")
new_rerank = pattern.sub(lambda m: m.group(1) + instruction + m.group(2), rerank_tpl)

templates = []
if default_tpl is not None:
    templates.append({"name": "default", "template": default_tpl})
templates.append({"name": "rerank", "template": new_rerank})

with open(out_json, "w", encoding="utf-8") as fh:
    json.dump(templates, fh, ensure_ascii=False)
PY

"$PY" "$LLAMA_SRC/gguf-py/gguf/scripts/gguf_new_metadata.py" "$Q8_GGUF" "$BAKED_GGUF" \
  --chat-template "$(cat "$TEMPLATES_JSON")" >"$WORK_DIR/new_metadata.log" 2>&1 \
  || die "gguf_new_metadata.py failed; see $WORK_DIR/new_metadata.log"

"$PY" -I - "$BAKED_GGUF" "$INSTRUCTION" <<'PY'
import sys

import gguf

path, instruction = sys.argv[1], sys.argv[2]
reader = gguf.GGUFReader(path)
field = reader.get_field("tokenizer.chat_template.rerank")
if field is None:
    sys.exit("verification failed: output has no tokenizer.chat_template.rerank")
tpl = field.contents()
needle = "<Instruct>: " + instruction + "\n<Query>"
if needle not in tpl:
    sys.exit("verification failed: rerank template does not contain the requested instruction")
if "Given a web search query" in tpl and "Given a web search query" not in instruction:
    sys.exit("verification failed: the stock instruction is still present in the rerank template")
if reader.get_field("tokenizer.chat_template") is None:
    sys.exit("verification failed: default chat template was lost")
PY
log "instruction verified in output metadata"

# --------------------------------------------------------------- 6. smoke test

if [ "$SMOKE" -eq 1 ]; then
  PORT="$(cd "$REPO_ROOT" && node scripts/pick-free-port.js)"
  [[ "$PORT" =~ ^[0-9]+$ ]] || die "pick-free-port.js returned '$PORT'"
  log "smoke test: llama-server on 127.0.0.1:$PORT"
  "$LLAMA_SERVER" -m "$BAKED_GGUF" --rerank --host 127.0.0.1 --port "$PORT" \
    -c 4096 -np 1 -ngl 99 >"$WORK_DIR/smoke-server.log" 2>&1 &
  SERVER_PID=$!

  healthy=0
  for _ in $(seq 1 120); do
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      die "llama-server exited during startup; see $WORK_DIR/smoke-server.log"
    fi
    if curl -fs --max-time 2 "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"ok"'; then
      healthy=1; break
    fi
    sleep 0.5
  done
  [ "$healthy" -eq 1 ] || die "llama-server was not healthy within 60s; see $WORK_DIR/smoke-server.log"

  RERANK_BODY='{"query":"contract termination notice period","documents":["The agreement may be terminated with thirty days written notice.","Apples are red."],"top_n":2}'
  RERANK_RESP="$(curl -fs --max-time 60 -H 'Content-Type: application/json' \
    -d "$RERANK_BODY" "http://127.0.0.1:$PORT/v1/rerank")" \
    || die "POST /v1/rerank failed; see $WORK_DIR/smoke-server.log"

  printf '%s' "$RERANK_RESP" | "$PY" -I -c '
import json, sys
data = json.load(sys.stdin)
scores = {r["index"]: r["relevance_score"] for r in data["results"]}
if set(scores) != {0, 1}:
    sys.exit("unexpected rerank response: %r" % data)
if not scores[0] > scores[1]:
    sys.exit("smoke test failed: relevant document scored %r, irrelevant %r" % (scores[0], scores[1]))
print("[prepare-reranker-model] smoke test ok: relevant=%.4f irrelevant=%.4f" % (scores[0], scores[1]))
' || die "rerank smoke test failed. Response: $RERANK_RESP"

  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  SERVER_PID=""
else
  log "smoke test skipped (--no-smoke)"
fi

# ------------------------------------------------------------------ 7. publish

# Stage next to the destination (same filesystem) and rename, so readers never
# see a partial model file.
cp "$BAKED_GGUF" "$STAGED_GGUF"
mv -f "$STAGED_GGUF" "$OUT_FILE"

SHA="$(sha256_of "$OUT_FILE")"
printf '%s  %s\n' "$SHA" "$(basename "$OUT_FILE")" >"$OUT_SHA"

CREATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
"$PY" -I - "$OUT_JSON" "$HF_REPO" "$HF_REVISION" "$QUANT" "$INSTRUCTION" "$LLAMA_TAG" "$CREATED_AT" <<'PY'
import json
import sys

out, source, revision, quant, instruction, tag, created_at = sys.argv[1:8]
with open(out, "w", encoding="utf-8") as fh:
    json.dump(
        {
            "source": source,
            "revision": revision,
            "quant": quant,
            "instruction": instruction,
            "llama_cpp_tag": tag,
            "created_at": created_at,
        },
        fh,
        ensure_ascii=False,
        indent=2,
    )
    fh.write("\n")
PY

SIZE_BYTES="$(wc -c <"$OUT_FILE" | tr -d ' ')"
SUCCESS=1
log "done"
log "  file:        $OUT_FILE"
log "  size:        $SIZE_BYTES bytes ($((SIZE_BYTES / 1048576)) MiB)"
log "  sha256:      $SHA"
log "  llama.cpp:   $LLAMA_TAG"
log "  instruction: $INSTRUCTION"
