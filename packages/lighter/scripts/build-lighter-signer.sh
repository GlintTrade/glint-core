#!/usr/bin/env sh
# Builds the official Lighter WASM signer (elliottech/lighter-go, wasm/main.go) from pinned source.
#
# Why build: lighter-go releases ship a prebuilt *web* WASM (lighter-signer-web.wasm, underscore API, one client per
# account index) but the documented Node API (GenerateAPIKey, CreateClient, SignCreateOrder, ...) is wasm/main.go,
# whose last prebuilt asset is v1.0.9 (int16 market indexes, cancel-all range bug fixed in v1.0.10).
# The build is reproducible: same tag + Go version + -trimpath give the same bytes; loadLighterSigner refuses to load
# a WASM whose sha256 is not pinned in packages/lighter/src/lighter/signer-pin.ts (extra hash: SignerFiles.extraSha256).
# The binary is not part of this repository; build it locally.
#
# Usage: sh packages/lighter/scripts/build-lighter-signer.sh   (local Go 1.25.5, or Docker golang:1.25.5 if go is missing)
# Output: packages/lighter/vendor/lighter-signer/lighter-signer.wasm + wasm_exec.js (from the SAME Go toolchain,
# as Go requires)
set -eu
LIGHTER_GO_TAG="v1.0.12"
LIGHTER_GO_COMMIT="324c93b067f24ede24918f3ac10663605d5f11c3"
GO_VERSION="1.25.5"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$HERE/vendor/lighter-signer"
mkdir -p "$OUT"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
curl -fsSL "https://codeload.github.com/elliottech/lighter-go/tar.gz/$LIGHTER_GO_COMMIT" | tar -xz -C "$WORK"
SRC="$WORK/lighter-go-$LIGHTER_GO_COMMIT"
if command -v go >/dev/null 2>&1 && go version | grep -q "go$GO_VERSION "; then
  (cd "$SRC" && GOOS=js GOARCH=wasm GOTOOLCHAIN=local go build -trimpath -buildvcs=false -o "$OUT/lighter-signer.wasm" ./wasm/)
  cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" "$OUT/wasm_exec.js"
else
  docker run --rm -v "$SRC:/src" -v "$OUT:/out" -w /src "golang:$GO_VERSION" sh -c \
    'GOOS=js GOARCH=wasm go build -trimpath -buildvcs=false -o /out/lighter-signer.wasm ./wasm/ && cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" /out/wasm_exec.js'
fi
echo "lighter-go $LIGHTER_GO_TAG ($LIGHTER_GO_COMMIT), go$GO_VERSION:"
sha256sum "$OUT/lighter-signer.wasm" "$OUT/wasm_exec.js" 2>/dev/null || shasum -a 256 "$OUT/lighter-signer.wasm" "$OUT/wasm_exec.js"
