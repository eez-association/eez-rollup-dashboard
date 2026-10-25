// Browser regression with mocked API/RPC data. Does not send transactions.
// Starts an isolated dashboard unless EEZ_UI_URL selects an existing test server.
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { mkdirSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");
const hash = "0x" + "ab".repeat(32), address = "0x" + "11".repeat(20);
const jobId = "11111111-1111-4111-8111-111111111111";
const model = {
  version: 1, schemaVersion: "1.0.0", label: "Counter.increment()", txHash: hash,
  origin: { chain: "L2", transactionId: "L2:" + hash },
  chains: { L1: { name: "Chiado", chainId: "10200" }, L2: { name: "EEZ test", chainId: "200" } },
  transactions: [{ chain: "L2", hash, block: 42, status: "success", role: "trigger", label: "Trigger · starts on L2", requested: true, traced: true, inFlow: true, evidence: [] }],
  roots: [{ node: 0, chain: "L2", tx: hash, role: "trigger" }],
  nodes: [{ id: 0, kind: "call", chain: "L2", role: "application", protocol: false, callType: "CALL",
    contract: "Counter", address, from: address, fn: "increment()", signature: "increment()",
    args: [{ name: "amount", type: "uint256", value: "7" }], ret: { status: "ok", items: [{ name: "count", type: "uint256", value: "8" }] },
    value: "0", isStatic: false, failed: false, reverted: false, gasUsed: "21000", tx: hash, block: 42,
    path: "0", input: "0x12345678", output: "0x", children: [] }],
  settlements: [], unresolved: [], stats: { frames: 1, crossings: 0, matched: 0, events: 0 },
};
// Independent recorded trees exercise the native view switch and chain numbering.
model.mode = "combined";
model.recordedView = { ...model, mode: "physical", recordedView: null,
  roots: [{ node: 0, chain: "L2", tx: hash, role: "trigger", inFlow: true },
    { node: 1, chain: "L1", tx: hash, role: "execution", inFlow: true }],
  nodes: [{ ...model.nodes[0], preparedResponse: true },
    { ...model.nodes[0], id: 1, chain: "L1", contract: "Remote counter" }],
  stats: { ...model.stats, frames: 2, preparedResponses: 1 },
  matchingNotes: [{ code: "ambiguous-remote-occurrence", message: "Repeated calls could not be paired." }],
};
(async () => {
  const directory = resolve(process.env.EEZ_UI_EVIDENCE || ".runtime/trace-details");
  mkdirSync(`${directory}/tmp`, { recursive: true });
  process.env.TMPDIR = `${directory}/tmp`;
  let server, browser;
  try {
    let url = process.env.EEZ_UI_URL;
    if (!url) {
      const { createServer } = await import("vite");
      const { default: react } = await import("@vitejs/plugin-react");
      server = await createServer({ configFile: false, envFile: false, plugins: [react()],
        base: "/dashboard/", server: { host: "127.0.0.1", port: 0, hmr: false } });
      await server.listen();
      url = `http://127.0.0.1:${server.httpServer.address().port}/dashboard/`;
    }
    browser = await chromium.launch({ headless: true, chromiumSandbox: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    let creates = 0;
    await page.route("**/config.json", route => route.fulfill({ json: { networkName: "EEZ test", l1RpcUrl: "/rpc/l1", l2RpcUrl: "/rpc/l2" } }));
    await page.route("**/rpc/*", route => {
      const request = route.request().postDataJSON();
      const result = request.method === "eth_chainId" ? route.request().url().endsWith("/l1") ? "0x27d8" : "0xc8" : "0x0";
      return route.fulfill({ json: { jsonrpc: "2.0", id: request.id, result } });
    });
    await page.route("**/trace/api/**", route => {
      if (route.request().method() === "DELETE") return route.fulfill({ status: 204 });
      if (route.request().url().endsWith("/result")) return route.fulfill({ json: { apiVersion: 1, partial: false, observedAt: "2026-10-14T12:00:00Z", model } });
      if (route.request().method() === "POST") {
        creates++;
        assert.equal(route.request().postDataJSON().hash, hash);
        assert.equal(route.request().postDataJSON().chainIds.l1, "10200");
      }
      return route.fulfill({ json: { apiVersion: 1, id: jobId, state: "complete", progress: "Trace decoded", error: null, errorCode: null } });
    });
    await page.goto(url + "#/visualizer?mode=trace&chain=l2&tx=" + hash);
    await page.getByRole("heading", { name: "Counter.increment()" }).waitFor();
    assert.equal(await page.locator("iframe").count(), 0);
    assert.equal(await page.getByRole("button", { name: "Call map", exact: true }).getAttribute("aria-pressed"), "true");
    const call = page.getByRole("region", { name: "Call map canvas" })
      .getByRole("button", { name: /Counter.*increment\(\)/ });
    await call.click();
    assert.equal(await call.getAttribute("aria-pressed"), "true");
    await page.getByLabel("Selected call details").getByText("amount", { exact: false }).waitFor();
    const canvas = page.getByRole("region", { name: "Call map canvas" });
    const originalWidth = (await canvas.boundingBox()).width;
    await page.getByRole("button", { name: "Hide call details", exact: true }).click();
    assert.ok((await canvas.boundingBox()).width > originalWidth, "hiding details gives the map more width");
    await page.getByRole("checkbox", { name: "Show local reads", exact: true }).check();
    await page.getByRole("button", { name: "100%", exact: true }).click();
    const beforeFullscreen = creates;
    await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
    await page.waitForFunction(() => document.fullscreenElement?.getAttribute("aria-label") === "Trace viewer");
    assert.ok(await page.evaluate(() => {
      const rect = document.fullscreenElement.getBoundingClientRect();
      return Math.abs(rect.width - innerWidth) < 2 && Math.abs(rect.height - innerHeight) < 2;
    }), "the trace fills the viewport");
    assert.equal(await page.getByLabel("Zoom level").innerText(), "100%");
    assert.equal(await page.getByRole("checkbox", { name: "Show local reads", exact: true }).isChecked(), true);
    assert.equal(await call.getAttribute("aria-pressed"), "true");
    await page.getByRole("button", { name: "Show call details", exact: true }).click();
    await page.getByLabel("Selected call details").getByText("amount", { exact: false }).waitFor();
    await page.getByRole("button", { name: "Exit fullscreen", exact: true }).click();
    await page.waitForFunction(() => !document.fullscreenElement);
    // A browser-initiated exit (such as Escape) must also update the control.
    await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
    await page.waitForFunction(() => !!document.fullscreenElement);
    await page.evaluate(() => document.exitFullscreen());
    await page.getByRole("button", { name: "Fullscreen", exact: true }).waitFor();
    assert.equal(creates, beforeFullscreen, "resizing never starts another decode");
    await page.getByRole("button", { name: "Sequence", exact: true }).click();
    await page.getByRole("columnheader", { name: "Return / status" }).waitFor();
    await page.getByRole("button", { name: "Recorded traces", exact: true }).click();
    await page.getByText("Recorded call order within each transaction.", { exact: false }).waitFor();
    const recordedRows = page.locator("tbody tr");
    await recordedRows.nth(1).waitFor();
    assert.deepEqual(await recordedRows.locator("td:first-child").allTextContents(), ["1", "1"]);
    await page.getByText("Call association notes (1)", { exact: true }).click();
    await page.getByText("Repeated calls could not be paired.", { exact: false }).waitFor();
    await page.getByRole("button", { name: "Lanes", exact: true }).click();
    await page.getByRole("checkbox", { name: "Compact cards", exact: true }).uncheck();
    await page.getByText("Prepared table response", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Linked flow", exact: true }).click();
    await page.getByText("Logical call order across both chains.", { exact: false }).waitFor();
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.getByRole("heading", { name: "Counter.increment()" }).waitFor();
    assert.ok(creates >= 2);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
    await page.waitForFunction(() => !!document.fullscreenElement);
    assert.ok(await page.evaluate(() => document.fullscreenElement.scrollWidth <= window.innerWidth));
    await page.getByRole("button", { name: "Exit fullscreen", exact: true }).click();
    await page.waitForFunction(() => !document.fullscreenElement);
    const inspector = page.getByRole("link", { name: "Blocks & settlement →" });
    assert.ok((await inspector.getAttribute("href")).includes("mode=inspect"));
    assert.deepEqual(errors, []);
    writeFileSync(`${directory}/result.json`, JSON.stringify({ passed: true,
      scope: "Native trace navigation, linked/recorded views, details, refresh, and mobile layout with mocked API/RPC; no wallet or chain writes" }, null, 2) + "\n");
    console.log("Native trace browser regression passed");
  } finally { await browser?.close(); await server?.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
