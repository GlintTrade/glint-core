// Provenance of the Lighter WASM signer that loadLighterSigner (wasm.ts) is allowed to load.
// Build it with packages/lighter/scripts/build-lighter-signer.sh; the binary is not part of this repository.
// Built from elliottech/lighter-go wasm/main.go with Go 1.25.5, -trimpath (reproducible).
export const LIGHTER_SIGNER_PIN = {
  lighterGoTag: "v1.0.12",
  lighterGoCommit: "324c93b067f24ede24918f3ac10663605d5f11c3",
  goVersion: "1.25.5",
  wasmSha256: ["550f978b39c822cdbc99f3d7bf02418b1d4a89c757374fb1217b54c19806964a"],
  // golang/go go1.25.5 lib/wasm/wasm_exec.js
  wasmExecSha256: ["0c949f4996f9a89698e4b5c586de32249c3b69b7baadb64d220073cc04acba14"],
} as const;
