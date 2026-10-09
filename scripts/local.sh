#!/usr/bin/env bash
# Run the Worker + Chat Durable Object in a local workerd (the real Workers runtime), with
# SQLite-backed DO storage on disk and a Worker Loader. Token: dev-token. Port: 8787.
# The dashboard is served on PORT+1: http://127.0.0.1:8788/ui/index.html?api=http://127.0.0.1:8787
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .local/do
node scripts/bundle.mjs .local
cat > .local/config.capnp <<CAPNP
using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "main", worker = .optchat),
    (name = "do-disk", disk = (path = "$(pwd)/.local/do", writable = true)),
    (name = "internet", network = (allow = ["public"], tlsOptions = (trustBrowserCas = true))),
  ],
  sockets = [ (name = "http", address = "127.0.0.1:${PORT:-8787}", http = (), service = "main") ],
);
const optchat :Workerd.Worker = (
  modules = [ (name = "worker.js", esModule = embed "worker.js") ],
  compatibilityDate = "2026-09-25",
  compatibilityFlags = [${EXTRA_FLAGS:-}],
  bindings = [
    (name = "Chat", durableObjectNamespace = "Chat"),
    (name = "LOADER", workerLoader = ()),
    (name = "OPTCHAT_TOKEN", text = "dev-token"),
    (name = "MODEL_MODE", text = "${MODEL_MODE:-mock}"),
  ],
  durableObjectNamespaces = [ (className = "Chat", uniqueKey = "optchat-chat", enableSql = true) ],
  durableObjectStorage = (localDisk = "do-disk"),
  globalOutbound = "internet",
);
CAPNP
# The dashboard, as Cloudflare's asset layer would serve it.
python3 -m http.server "$(( ${PORT:-8787} + 1 ))" --bind 127.0.0.1 --directory public >/dev/null 2>&1 &
trap 'kill $! 2>/dev/null' EXIT
node_modules/@cloudflare/workerd-darwin-arm64/bin/workerd serve .local/config.capnp --verbose --experimental ${WORKERD_FLAGS:-}
