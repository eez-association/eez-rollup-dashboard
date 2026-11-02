#!/usr/bin/env bash
# Generate the local Vite runtime config for a running EEZ Kurtosis enclave.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENCLAVE="${KURTOSIS_ENCLAVE:-eez-protocol-dev}"
RUNTIME_DIR="$ROOT/.runtime"

: "${EEZ_UI_L1_FEES_ENABLED:=false}"
: "${EEZ_UI_L2_FEES_ENABLED:=false}"
: "${EEZ_UI_L1_FEE_MAX_TOTAL_WEI:=100000000000000000}"
: "${EEZ_UI_L2_FEE_MAX_TOTAL_WEI:=100000000000000000}"
case "$EEZ_UI_L1_FEES_ENABLED" in true|false) ;; *) echo 'EEZ_UI_L1_FEES_ENABLED must be true or false' >&2; exit 1;; esac
case "$EEZ_UI_L2_FEES_ENABLED" in true|false) ;; *) echo 'EEZ_UI_L2_FEES_ENABLED must be true or false' >&2; exit 1;; esac
case "$EEZ_UI_L1_FEE_MAX_TOTAL_WEI" in ''|*[!0-9]*|0*) echo 'EEZ_UI_L1_FEE_MAX_TOTAL_WEI must be a positive decimal integer' >&2; exit 1;; esac
case "$EEZ_UI_L2_FEE_MAX_TOTAL_WEI" in ''|*[!0-9]*|0*) echo 'EEZ_UI_L2_FEE_MAX_TOTAL_WEI must be a positive decimal integer' >&2; exit 1;; esac

for tool in jq kurtosis; do
    command -v "$tool" >/dev/null || { echo "$tool not found in PATH" >&2; exit 1; }
done

http_url() {
    case "$1" in
        http://*|https://*) printf '%s\n' "$1" ;;
        "") printf '\n' ;;
        *) printf 'http://%s\n' "$1" ;;
    esac
}

tmp_dir="$(mktemp -d -t eez-ui-config-XXXXXXXX)"
trap 'rm -rf "$tmp_dir"' EXIT
mkdir -p "$RUNTIME_DIR"

kurtosis files download "$ENCLAVE" eez-deployments "$tmp_dir" >/dev/null
set -a
# shellcheck disable=SC1091
source "$tmp_dir/deployments.env"
set +a

demo_env=""
mkdir -p "$tmp_dir/demo"
if kurtosis files download "$ENCLAVE" eez-ui-demo "$tmp_dir/demo" >/dev/null 2>&1; then
    demo_env="$tmp_dir/demo/demo.env"
elif [[ -f "$RUNTIME_DIR/demo.env" ]]; then
    demo_env="$RUNTIME_DIR/demo.env"
fi

if [[ -n "$demo_env" && -f "$demo_env" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$demo_env"
    set +a
fi

EEZ_UI_DEMO_BRIDGE_ADDRESS="${EEZ_UI_DEMO_BRIDGE_ADDRESS:-}"
EEZ_UI_DEMO_TOKEN_ADDRESS="${EEZ_UI_DEMO_TOKEN_ADDRESS:-}"
EEZ_UI_DEMO_POOL_ADDRESS="${EEZ_UI_DEMO_POOL_ADDRESS:-}"
EEZ_UI_DEMO_EXECUTOR_L1="${EEZ_UI_DEMO_EXECUTOR_L1:-}"
EEZ_UI_DEMO_EXECUTOR_L2="${EEZ_UI_DEMO_EXECUTOR_L2:-}"
EEZ_UI_DEMO_WRAPPED_TOKEN_L2="${EEZ_UI_DEMO_WRAPPED_TOKEN_L2:-}"
EEZ_UI_DEMO_NFT_L2="${EEZ_UI_DEMO_NFT_L2:-}"
REVERSE_EXECUTOR_L2="${REVERSE_EXECUTOR_L2:-}"
REVERSE_NFT_L1="${REVERSE_NFT_L1:-}"
REVERSE_EXECUTOR_L1="${REVERSE_EXECUTOR_L1:-}"
AGG_WETH_ADDRESS="${AGG_WETH_ADDRESS:-}"
AGG_USDC_ADDRESS="${AGG_USDC_ADDRESS:-}"
AGG_L1_AMM_ADDRESS="${AGG_L1_AMM_ADDRESS:-}"
AGG_AGGREGATOR_ADDRESS="${AGG_AGGREGATOR_ADDRESS:-}"
AGG_L2_EXECUTOR_ADDRESS="${AGG_L2_EXECUTOR_ADDRESS:-}"
AGG_L2_AMM_ADDRESS="${AGG_L2_AMM_ADDRESS:-}"
AGG_L2_EXECUTOR_PROXY_ADDRESS="${AGG_L2_EXECUTOR_PROXY_ADDRESS:-}"
AGG_WRAPPED_WETH_L2="${AGG_WRAPPED_WETH_L2:-}"
AGG_WRAPPED_USDC_L2="${AGG_WRAPPED_USDC_L2:-}"

l1_rpc="$(http_url "$(kurtosis port print "$ENCLAVE" el-1-reth-lighthouse rpc)")"
l2_rpc="$(http_url "$(kurtosis port print "$ENCLAVE" eez-node l2-rpc)")"
l1_front="$(http_url "$(kurtosis port print "$ENCLAVE" eez-node l1-xchain)")"
l2_front="$(http_url "$(kurtosis port print "$ENCLAVE" eez-node l2-xchain)")"
l1_explorer="$(http_url "$(kurtosis port print "$ENCLAVE" l1-blockscout-frontend http 2>/dev/null || true)")"
l2_explorer="$(http_url "$(kurtosis port print "$ENCLAVE" l2-blockscout-frontend http 2>/dev/null || true)")"
l2_explorer_api="$(http_url "$(kurtosis port print "$ENCLAVE" l2-blockscout http 2>/dev/null || true)")"
protocol_commit="${EEZ_UI_PROTOCOL_COMMIT:-unknown}"

jq -n \
    --arg enclave "$ENCLAVE" \
    --arg protocolCommit "$protocol_commit" \
    --arg l1Rpc "$l1_rpc" \
    --arg l2Rpc "$l2_rpc" \
    --arg l1Front "$l1_front" \
    --arg l2Front "$l2_front" \
    --arg l1Explorer "$l1_explorer" \
    --arg l2Explorer "$l2_explorer" \
    --arg l2ExplorerApi "$l2_explorer_api" \
    --arg registry "$EEZ_REGISTRY_ADDRESS" \
    --arg eezl2 "$EEZL2_ADDRESS" \
    --arg proofSystem "$EEZ_ECDSA_PROOF_SYSTEM_ADDRESS" \
    --arg rollupManager "$EEZ_ROLLUP_MANAGER_ADDRESS" \
    --arg bridgeL1 "$EEZ_L1_BRIDGE_SENDER" \
    --arg bridgeL2 "$EEZ_L2_BRIDGE_RECEIVER" \
    --arg treasuryToken "${EEZ_UI_TREASURY_TOKEN_ADDRESS:-}" \
    --arg rollupId "$EEZ_ROLLUP_ID" \
    --argjson l1FeesEnabled "$EEZ_UI_L1_FEES_ENABLED" \
    --argjson l2FeesEnabled "$EEZ_UI_L2_FEES_ENABLED" \
    --arg l1FeeMaxTotalWei "$EEZ_UI_L1_FEE_MAX_TOTAL_WEI" \
    --arg l2FeeMaxTotalWei "$EEZ_UI_L2_FEE_MAX_TOTAL_WEI" \
    --arg demoBridge "$EEZ_UI_DEMO_BRIDGE_ADDRESS" \
    --arg demoToken "$EEZ_UI_DEMO_TOKEN_ADDRESS" \
    --arg demoPool "$EEZ_UI_DEMO_POOL_ADDRESS" \
    --arg demoExecutorL1 "$EEZ_UI_DEMO_EXECUTOR_L1" \
    --arg demoExecutorL2 "$EEZ_UI_DEMO_EXECUTOR_L2" \
    --arg demoWrappedTokenL2 "$EEZ_UI_DEMO_WRAPPED_TOKEN_L2" \
    --arg demoNftL2 "$EEZ_UI_DEMO_NFT_L2" \
    --arg reverseExecutorL2 "$REVERSE_EXECUTOR_L2" \
    --arg reverseNftL1 "$REVERSE_NFT_L1" \
    --arg reverseExecutorL1 "$REVERSE_EXECUTOR_L1" \
    --arg aggWeth "$AGG_WETH_ADDRESS" \
    --arg aggUsdc "$AGG_USDC_ADDRESS" \
    --arg aggL1Amm "$AGG_L1_AMM_ADDRESS" \
    --arg aggAggregator "$AGG_AGGREGATOR_ADDRESS" \
    --arg aggL2Executor "$AGG_L2_EXECUTOR_ADDRESS" \
    --arg aggL2Amm "$AGG_L2_AMM_ADDRESS" \
    --arg aggL2ExecutorProxy "$AGG_L2_EXECUTOR_PROXY_ADDRESS" \
    --arg aggWrappedWethL2 "$AGG_WRAPPED_WETH_L2" \
    --arg aggWrappedUsdcL2 "$AGG_WRAPPED_USDC_L2" \
    '{
      browser: {
        networkName: "EEZ Kurtosis devnet",
        enclave: $enclave,
        l1RpcUrl: "/rpc/l1",
        l2RpcUrl: "/rpc/l2",
        l1FrontUrl: "/composer/l1",
        l2FrontUrl: "/composer/l2",
        l1ExplorerUrl: $l1Explorer,
        l2ExplorerUrl: $l2Explorer,
        l2ExplorerApiUrl: $l2ExplorerApi,
        l1ContractAddress: $registry,
        l2ContractAddress: $eezl2,
        proofSystemAddress: $proofSystem,
        rollupManagerAddress: $rollupManager,
        bridgeL1Address: $bridgeL1,
        bridgeL2Address: $bridgeL2,
        treasuryTokenAddress: $treasuryToken,
        rollupId: $rollupId,
        l1FeesEnabled: $l1FeesEnabled,
        l2FeesEnabled: $l2FeesEnabled,
        l1FeeMaxTotalWei: $l1FeeMaxTotalWei,
        l2FeeMaxTotalWei: $l2FeeMaxTotalWei,
        protocolCommit: $protocolCommit,
        demoBridgeAddress: $demoBridge,
        demoTokenAddress: $demoToken,
        demoPoolAddress: $demoPool,
        demoExecutorL1: $demoExecutorL1,
        demoExecutorL2: $demoExecutorL2,
        demoWrappedTokenL2: $demoWrappedTokenL2,
        demoNftL2: $demoNftL2,
        reverseExecutorL2: $reverseExecutorL2,
        reverseNftL1: $reverseNftL1,
        reverseExecutorL1: $reverseExecutorL1,
        aggWeth: $aggWeth,
        aggUsdc: $aggUsdc,
        aggL1Amm: $aggL1Amm,
        aggAggregator: $aggAggregator,
        aggL2Executor: $aggL2Executor,
        aggL2Amm: $aggL2Amm,
        aggL2ExecutorProxy: $aggL2ExecutorProxy,
        aggWrappedWethL2: $aggWrappedWethL2,
        aggWrappedUsdcL2: $aggWrappedUsdcL2
      },
      proxy: {
        l1Rpc: $l1Rpc,
        l2Rpc: $l2Rpc,
        l1Front: $l1Front,
        l2Front: $l2Front
      }
    }' > "$RUNTIME_DIR/config.json"

printf 'EEZ UI configured for enclave %s\n' "$ENCLAVE"
printf 'Run: cd %s && npm run dev\n' "$ROOT"
