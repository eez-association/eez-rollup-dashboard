import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin, type ProxyOptions, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const runtimeConfigPath = path.resolve(rootDir, process.env.EEZ_UI_RUNTIME_CONFIG || ".runtime/config.json");

type RuntimeFile = {
  browser?: Record<string, unknown>;
  proxy?: Record<string, string>;
};

function loadRuntimeFile(): RuntimeFile {
  if (!fs.existsSync(runtimeConfigPath)) return {};
  return JSON.parse(fs.readFileSync(runtimeConfigPath, "utf8")) as RuntimeFile;
}

function runtimeConfigPlugin(runtime: RuntimeFile): Plugin {
  const configure = (server: Pick<ViteDevServer, "middlewares">) => {
    const base = process.env.EEZ_UI_BASE_PATH || "/dashboard/";
    for (const configPath of new Set(["/config.json", `${base}config.json`])) {
      server.middlewares.use(configPath, (_req, res) => {
        const latest = loadRuntimeFile();
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(latest.browser ?? runtime.browser ?? {}, null, 2));
      });
    }
  };
  return { name: "eez-runtime-config", configureServer: configure, configurePreviewServer: configure };
}

function rpcProxy(target: string | undefined): ProxyOptions | undefined {
  if (!target) return undefined;
  const upstream = new URL(target);
  const endpoint = upstream.pathname + upstream.search;
  upstream.pathname = "/"; upstream.search = ""; upstream.hash = "";
  return { target: upstream.href, changeOrigin: true, rewrite: () => endpoint };
}

export default defineConfig(() => {
  const runtime = loadRuntimeFile();
  const proxy = runtime.proxy ?? {};
  const base = process.env.EEZ_UI_BASE_PATH || "/dashboard/";
  const traceProxy = (prefix: string): ProxyOptions => ({
    target: process.env.EEZ_TRACE_UPSTREAM || "http://127.0.0.1:18082",
    changeOrigin: false,
    rewrite: (url: string) => "/api" + url.slice(prefix.length),
  });
  const proxies = Object.fromEntries(
    Object.entries({
      "/trace/api": traceProxy("/trace/api"),
      [base + "trace/api"]: traceProxy(base + "trace/api"),
      "/monitor/api": {
        target: process.env.EEZ_MONITOR_UPSTREAM || "http://127.0.0.1:18080",
        changeOrigin: false,
        ws: true,
        rewrite: (url: string) => url.replace(/^\/monitor(?=\/|$)/, "") || "/",
      },
      "/dashboard/treasury-verification": { target: "http://127.0.0.1:18081", changeOrigin: false, rewrite: (url: string) => url.replace(/^\/dashboard\/treasury-verification/, "") },
      "/treasury-verification": { target: "http://127.0.0.1:18081", changeOrigin: false, rewrite: (url: string) => url.replace(/^\/treasury-verification/, "") },
      "/rpc/l1": rpcProxy(proxy.l1Rpc),
      "/rpc/l2": rpcProxy(proxy.l2Rpc),
      "/composer/l1": rpcProxy(proxy.l1Front),
      "/composer/l2": rpcProxy(proxy.l2Front),
    }).filter((entry): entry is [string, NonNullable<ReturnType<typeof rpcProxy>>] => Boolean(entry[1])),
  );

  return {
    base,
    plugins: [react(), runtimeConfigPlugin(runtime)],
    server: {
      port: 8080,
      host: "0.0.0.0",
      allowedHosts: true as const,
      proxy: proxies as Record<string, ProxyOptions>,
    },
    // Open preview tabs can still request lazy chunks from the previous build.
    // Content-hashed assets are immutable; retain them across local rebuilds.
    build: { outDir: "dist", emptyOutDir: false },
  };
});
