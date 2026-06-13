#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# build-sqljs-fts5.sh — Rebuild sql.js WASM with SQLITE_ENABLE_FTS5
#
# This script rebuilds the sql-wasm-fts5.wasm binary that ships with
# the project. It's only needed when upgrading sql.js to a new version.
#
# Prerequisites:
#   - Git
#   - Node.js >= 18
#   - Python >= 3.8
#
# Usage:
#   bash packages/core/scripts/build-sqljs-fts5.sh
#
# Output:
#   packages/core/src/assets/sql-wasm-fts5.wasm
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_ROOT="$(cd "$CORE_DIR/../.." && pwd)"
OUTPUT_DIR="$CORE_DIR/src/assets"
OUTPUT_WASM="$OUTPUT_DIR/sql-wasm-fts5.wasm"
BUILD_DIR="$PROJECT_ROOT/.sql-js-build"

# MUST match the emscripten version used by the npm sql.js package.
# sql.js 1.12.0 was built with Emscripten 3.1.64 (commit 1eb07a3).
EMSCRIPTEN_VERSION="3.1.64"
SQLJS_VERSION="1.12.0"

echo "═══════════════════════════════════════════════════════"
echo "  sql.js FTS5 Rebuild Script"
echo "  sql.js:      v${SQLJS_VERSION}"
echo "  Emscripten:  ${EMSCRIPTEN_VERSION}"
echo "  Output:      ${OUTPUT_WASM}"
echo "═══════════════════════════════════════════════════════"
echo ""

# ── 1. Install Emscripten SDK ────────────────────────────────────────
if ! command -v emcc &>/dev/null; then
    echo "[1/6] Installing Emscripten SDK ${EMSCRIPTEN_VERSION}..."
    if [ ! -d "$PROJECT_ROOT/.emsdk" ]; then
        git clone https://github.com/emscripten-core/emsdk.git "$PROJECT_ROOT/.emsdk"
    fi
    cd "$PROJECT_ROOT/.emsdk"
    git pull
    ./emsdk install "$EMSCRIPTEN_VERSION"
    ./emsdk activate "$EMSCRIPTEN_VERSION"
    source ./emsdk_env.sh
else
    echo "[1/6] Emscripten already available ($(emcc --version 2>&1 | head -1))"
fi

# ── 2. Clone sql.js source ───────────────────────────────────────────
echo "[2/6] Preparing sql.js v${SQLJS_VERSION} source..."
if [ -d "$BUILD_DIR" ]; then
    cd "$BUILD_DIR"
    git fetch --tags
else
    git clone https://github.com/sql-js/sql.js.git "$BUILD_DIR"
    cd "$BUILD_DIR"
fi
git checkout "v${SQLJS_VERSION}" 2>/dev/null || git checkout "$SQLJS_VERSION"

# ── 3. Install build dependencies ────────────────────────────────────
echo "[3/6] Installing build dependencies..."
npm install --ignore-scripts 2>&1 | tail -1

# ── 4. Download SQLite amalgamation (if not present) ─────────────────
if [ ! -f "sqlite-amalgamation-3450200/sqlite3.c" ]; then
    echo "[4/6] Downloading SQLite amalgamation..."
    curl -sL "https://www.sqlite.org/2024/sqlite-amalgamation-3450200.zip" -o sqlite.zip
    python -c "import zipfile; zipfile.ZipFile('sqlite.zip').extractall()"
    rm sqlite.zip
else
    echo "[4/6] SQLite amalgamation already present"
fi
if [ ! -f "extension-functions.c" ]; then
    curl -sL "https://www.sqlite.org/contrib/download/extension-functions.c?get=25" -o extension-functions.c
fi

# ── 5. Compile with FTS5 ────────────────────────────────────────────
echo "[5/6] Compiling WASM with -DSQLITE_ENABLE_FTS5..."
rm -rf out dist
mkdir -p out dist

# Compile sqlite3.o
emcc \
    -Oz \
    -DSQLITE_OMIT_LOAD_EXTENSION \
    -DSQLITE_DISABLE_LFS \
    -DSQLITE_ENABLE_FTS3 \
    -DSQLITE_ENABLE_FTS3_PARENTHESIS \
    -DSQLITE_ENABLE_FTS5 \
    -DSQLITE_THREADSAFE=0 \
    -DSQLITE_ENABLE_NORMALIZE \
    -c sqlite-amalgamation-3450200/sqlite3.c \
    -o out/sqlite3.o

# Compile extension-functions.o
emcc \
    -Oz \
    -Isqlite-amalgamation-3450200 \
    -DSQLITE_OMIT_LOAD_EXTENSION \
    -DSQLITE_DISABLE_LFS \
    -c extension-functions.c \
    -o out/extension-functions.o

# Link into JS+WASM
emcc \
    -Oz -flto --closure 1 \
    -s RESERVED_FUNCTION_POINTERS=64 \
    -s ALLOW_TABLE_GROWTH=1 \
    -s EXPORTED_FUNCTIONS=@src/exported_functions.json \
    -s EXPORTED_RUNTIME_METHODS=@src/exported_runtime_methods.json \
    -s SINGLE_FILE=0 \
    -s NODEJS_CATCH_EXIT=0 \
    -s NODEJS_CATCH_REJECTION=0 \
    -s STACK_SIZE=5MB \
    -s WASM=1 \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s MODULARIZE=1 \
    -s EXPORT_NAME=initSqlJs \
    --pre-js src/api.js \
    out/sqlite3.o out/extension-functions.o \
    -o out/sql-wasm.js

# Post-process: wrap with shell-pre.js and shell-post.js
cat src/shell-pre.js out/sql-wasm.js src/shell-post.js > dist/sql-wasm.js
cp out/sql-wasm.wasm dist/sql-wasm.wasm

# ── 6. Copy output ───────────────────────────────────────────────────
echo "[6/6] Installing custom WASM..."
mkdir -p "$OUTPUT_DIR"
cp dist/sql-wasm.wasm "$OUTPUT_WASM"

FILESIZE=$(stat -c%s "$OUTPUT_WASM" 2>/dev/null || stat -f%z "$OUTPUT_WASM" 2>/dev/null || echo "unknown")
echo ""
echo "═══════════════════════════════════════════════════════"
echo "  ✅ Build complete!"
echo "  WASM size: ${FILESIZE} bytes"
echo "  Output:    ${OUTPUT_WASM}"
echo ""
echo "  Committed to repo — Octopus will load it automatically."
echo "═══════════════════════════════════════════════════════"
