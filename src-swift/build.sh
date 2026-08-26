#!/bin/bash
set -e
# Build Mana with bundled Node.js — zero external dependencies
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
APP_NAME="Mana"
BUILD_DIR="$PROJECT_ROOT/src-swift/build"
APP_BUNDLE="$BUILD_DIR/$APP_NAME.app"
RES_DIR="$APP_BUNDLE/Contents/Resources"

echo "=== Building $APP_NAME ==="
rm -rf "$BUILD_DIR"
mkdir -p "$APP_BUNDLE/Contents/MacOS" "$RES_DIR"

# 1. Compile Swift
echo "Compiling Swift..."
swiftc -o "$APP_BUNDLE/Contents/MacOS/$APP_NAME" \
    -framework Cocoa -framework WebKit \
    -target arm64-apple-macos13.0 -O \
    "$SCRIPT_DIR/MenubarLogic.swift" "$SCRIPT_DIR/main.swift"

# 2. Copy Info.plist & icon
cp "$SCRIPT_DIR/Info.plist" "$APP_BUNDLE/Contents/"
echo -n "APPL????" > "$APP_BUNDLE/Contents/PkgInfo"
cp "$SCRIPT_DIR/icons/AppIcon.icns" "$RES_DIR/AppIcon.icns"

# 3. Bundle Node.js runtime
echo "Bundling Node.js..."
NODE_BIN="$(readlink -f /opt/homebrew/bin/node 2>/dev/null || readlink -f /usr/local/bin/node 2>/dev/null)"
NODE_PREFIX="$(dirname "$(dirname "$NODE_BIN")")"
cp "$NODE_BIN" "$RES_DIR/node"
mkdir -p "$RES_DIR/lib"

# Copy libnode
LIBNODE=$(find "$NODE_PREFIX/lib" -name "libnode.*.dylib" -maxdepth 1 2>/dev/null | head -1)
cp "$LIBNODE" "$RES_DIR/lib/"

# Recursively collect all Homebrew dylib deps
collect_and_copy() {
    local bin="$1" dest="$2"
    otool -L "$bin" 2>/dev/null | grep -E '(/opt/homebrew|@rpath)' | awk '{print $1}' | while read ref; do
        local src=""
        case "$ref" in
            /opt/homebrew/*) src="$ref" ;;
            @rpath/*) name="${ref#@rpath/}"; for p in "$NODE_PREFIX/lib" /opt/homebrew/lib /opt/homebrew/opt/*/lib; do [ -f "$p/$name" ] && src="$p/$name" && break; done ;;
        esac
        [ -z "$src" ] || [ ! -f "$src" ] && continue
        base=$(basename "$src")
        [ -f "$dest/$base" ] && continue
        cp "$src" "$dest/$base"
        echo "  $base"
        collect_and_copy "$src" "$dest"
    done
}
collect_and_copy "$RES_DIR/node" "$RES_DIR/lib"
# libicudata is a transitive dep that the recursive collector misses
ICU_DATA=/opt/homebrew/opt/icu4c@78/lib/libicudata.78.dylib
[ -f "$ICU_DATA" ] && [ ! -f "$RES_DIR/lib/libicudata.78.dylib" ] && cp "$ICU_DATA" "$RES_DIR/lib/" && echo "  libicudata.78.dylib"

# Second pass: re-scan bundled dylibs for transitive deps
for f in "$RES_DIR/lib/"*.dylib; do
    collect_and_copy "$f" "$RES_DIR/lib"
done
# Fix all install names
echo "Fixing dylib paths..."
install_name_tool -change "@rpath/$(basename "$LIBNODE")" "@loader_path/lib/$(basename "$LIBNODE")" "$RES_DIR/node"
for f in "$RES_DIR/node" "$RES_DIR/lib/"*.dylib; do
    otool -L "$f" 2>/dev/null | grep -E '(/opt/homebrew|@rpath)' | awk '{print $1}' | while read ref; do
        local_name=""
        case "$ref" in
            /opt/homebrew/*) local_name=$(basename "$ref") ;;
            @rpath/*) local_name="${ref#@rpath/}" ;;
        esac
        [ -z "$local_name" ] && continue
        [ ! -f "$RES_DIR/lib/$local_name" ] && continue
        case "$f" in
            */node) install_name_tool -change "$ref" "@loader_path/lib/$local_name" "$f" 2>/dev/null ;;
            */lib/*) install_name_tool -change "$ref" "@loader_path/$local_name" "$f" 2>/dev/null ;;
        esac
    done
done
for f in "$RES_DIR/lib/"*.dylib; do
    base=$(basename "$f"); install_name_tool -id "@loader_path/$base" "$f" 2>/dev/null
done

# 4. Bundle server code
echo "Bundling server..."
cp "$PROJECT_ROOT/server.js" "$RES_DIR/"
cp -R "$PROJECT_ROOT/src" "$RES_DIR/"
cp "$PROJECT_ROOT/.github-oauth.json" "$RES_DIR/" 2>/dev/null || true
if [ "$DIST" = "1" ]; then
    # 分发模式：不打包本机个人数据（Keychain keyId 元数据 / 通知配置），目标机器从零开始
    echo "DIST mode: skipping .keys.json / .config.json"
else
    cp "$PROJECT_ROOT/.keys.json" "$RES_DIR/" 2>/dev/null || true
    cp "$PROJECT_ROOT/.config.json" "$RES_DIR/" 2>/dev/null || true
fi

# 版本号唯一来源 package.json：写入 Resources/version（自更新用，Node/Swift 读）
# + Info.plist 两个版本键（Finder 显示）
APP_VERSION="$(node -p "require('$PROJECT_ROOT/package.json').version")"
echo "$APP_VERSION" > "$RES_DIR/version"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $APP_VERSION" -c "Set :CFBundleVersion $APP_VERSION" "$APP_BUNDLE/Contents/Info.plist"
echo "Version: $APP_VERSION"

# 5. Install production deps
cp "$PROJECT_ROOT/package.json" "$RES_DIR/"
(cd "$RES_DIR" && npm install --omit=dev --ignore-scripts 2>&1 | tail -1)
rm -f "$RES_DIR/package.json" "$RES_DIR/package-lock.json"

# 6. Sign everything
# 优先正式 Developer ID；本机只有 Apple Development 时按用户要求使用它。
# SIGN_IDENTITY="-" 可显式退回 ad-hoc，SIGN_IDENTITY="证书名" 可显式指定。
chmod +x "$APP_BUNDLE/Contents/MacOS/$APP_NAME" "$RES_DIR/node"
if [ -z "$SIGN_IDENTITY" ]; then
    SIGN_IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null \
        | sed -n 's/.*"\(Developer ID Application:[^"]*\)".*/\1/p' | head -1)
fi
if [ -z "$SIGN_IDENTITY" ]; then
    SIGN_IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null \
        | sed -n 's/.*"\(Apple Development:[^"]*\)".*/\1/p' | head -1)
fi
SIGN_IDENTITY=${SIGN_IDENTITY:--}
echo "Signing identity: $SIGN_IDENTITY"

for f in "$RES_DIR/lib/"*.dylib; do
    codesign --force --sign "$SIGN_IDENTITY" "$f"
done
codesign --force --sign "$SIGN_IDENTITY" "$RES_DIR/node"
codesign --force --sign "$SIGN_IDENTITY" "$APP_BUNDLE"
codesign --verify --deep --strict --verbose=2 "$APP_BUNDLE"

echo "Bundle: $(du -sh "$RES_DIR" | cut -f1) ($(ls "$RES_DIR/lib/"*.dylib | wc -l | tr -d ' ') dylibs)"

# 7. Create DMG
DMG_FILE="$BUILD_DIR/$APP_NAME.dmg"
DMG_DIR="$BUILD_DIR/dmg"
mkdir -p "$DMG_DIR"
cp -R "$APP_BUNDLE" "$DMG_DIR/"
ln -s /Applications "$DMG_DIR/Applications"
hdiutil create -volname "$APP_NAME" -srcfolder "$DMG_DIR" -ov -format UDZO "$DMG_FILE" > /dev/null
rm -rf "$DMG_DIR"
codesign --force --sign "$SIGN_IDENTITY" "$DMG_FILE"
codesign --verify --verbose=2 "$DMG_FILE"

echo "=== Done ==="
echo "DMG: $DMG_FILE ($(du -h "$DMG_FILE" | cut -f1))"
