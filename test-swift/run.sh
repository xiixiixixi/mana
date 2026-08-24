#!/bin/bash
set -e

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEST_BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mana-menubar-tests.XXXXXX")"
trap 'rm -rf "$TEST_BUILD_DIR"' EXIT

swiftc "$PROJECT_ROOT/src-swift/MenubarLogic.swift" "$PROJECT_ROOT/test-swift/main.swift" \
    -o "$TEST_BUILD_DIR/mana-menubar-tests"
"$TEST_BUILD_DIR/mana-menubar-tests"
