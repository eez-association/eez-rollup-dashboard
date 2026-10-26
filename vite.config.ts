import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin, type ProxyOptions } from "vite";
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
  return {
    name: "eez-runtime-config",
    configureServer(server) {
      const base = process.env.EEZ_UI_BASE_PATH || "/dashboard/";
      for (const configPath of new Set(["/config.json", `${base}config.json`])) {
        server.middlewares.use(configPath, (_req, res) => {
          const latest = loadRuntimeFile();
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(latest.browser ?? runtime.browser ?? {}, null, 2));
        });
      }
    },
  };
}

function rpcProxy(target: string | undefined): ProxyOptions | undefined {
  if (!target) return undefined;
  return { target, changeOrigin: true, rewrite: () => "/" };
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
      [base + "cowdemo"]: {
        target: process.env.EEZ_UI_COW_UPSTREAM || "http://127.0.0.1:8787",
        changeOrigin: true,
        rewrite: (url: string) => url.slice((base + "cowdemo").length) || "/",
      },
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
    build: { outDir: "dist" },
  };
});
