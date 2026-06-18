import { Router, Request, Response } from "express";
import { ethers } from "ethers";
import { Config } from "../config.js";
import { fetchLatestEvents, NormalizedEvent } from "../subgraph.js";

/**
 * Single source of truth for the endpoints the facilitator exposes. Also
 * printed by the landing page and served as JSON under `Accept: application/json`.
 * Keep in sync when mounting new routes in src/app.ts.
 */
interface EndpointParam {
  name: string;
  desc: string;
}

interface EndpointDescriptor {
  method: string;
  path: string;
  summary: string;
  /** Human note about the request body (e.g. "no body", or the JSON shape). */
  request?: string;
  /** Request body / query parameters. */
  params?: EndpointParam[];
  /** Compact example request body or invocation. */
  example?: string;
}

const ENDPOINTS: EndpointDescriptor[] = [
  {
    method: "GET",
    path: "/",
    summary: "Service info and endpoint directory (this page).",
    request: "No body. Send `Accept: application/json` for a machine-readable view.",
  },
  {
    method: "POST",
    path: "/submit",
    summary: "Application-agnostic gasless request submission (ASSOCIATEKEY, PROCESS).",
    request:
      "JSON body with an EIP-712 RequestAuthorization signed by the user. The nonce is read from `facilitatorNonces[sender]` on-chain by the client before signing (no nonce endpoint).",
    params: [
      { name: "protocolVersion", desc: "Protocol version (currently 0)." },
      { name: "applicationId", desc: "Target application ID" },
      { name: "sender", desc: "User address that signed the request." },
      { name: "requestType", desc: "1 = PROCESS, 3 = ASSOCIATEKEY (only these two are accepted)." },
      {
        name: "payload",
        desc: "Hex bytes. ASSOCIATEKEY: raw 133-byte P-521 pubkey (0x04 || x || y). PROCESS: ECIES-encrypted PayloadInstructions (app specific format).",
      },
      { name: "tokenAddress", desc: "ERC-20 address, or address(0) when assetAmount = 0." },
      { name: "assetAmount", desc: "Token amount in base units, as a string." },
      { name: "deadline", desc: "Unix timestamp after which the signature is rejected." },
      { name: "requestSignature", desc: "EIP-712 RequestAuthorization signature (hex)." },
      { name: "depositPermit", desc: "EIP-2612 permit { v, r, s } when assetAmount > 0, otherwise null." },
    ],
    example: `{
  "sender": "0xUSER",
  "protocolVersion": 0,
  "applicationId": 1,
  "requestType": 3,
  "payload": "0x04...133bytes",
  "tokenAddress": "0x0000000000000000000000000000000000000000",
  "assetAmount": "0",
  "deadline": "1711929600",
  "requestSignature": "0x...",
  "depositPermit": null
}
// → 200 { "requestId": "0x..." }`,
  },
  {
    method: "POST",
    path: "/claim",
    summary: "Permissionless claim of pending balances on ProcessorEndpoint.",
    request:
      "JSON body. Anyone can call it — funds are always sent to `payee`, so there is no auth risk. If nothing is pending, it is a no-op returning amount \"0\".",
    params: [
      { name: "tokenAddress", desc: "ERC-20 address, or address(0) for ETH." },
      { name: "payee", desc: "Address that will receive the pending balance." },
    ],
    example: `{
  "tokenAddress": "0xTOKEN",
  "payee": "0xPAYEE"
}
// → 200 { "amount": "1000000", "transaction": "0x..." }`,
  },
  {
    method: "GET",
    path: "/supported",
    summary: "x402: supported schemes and networks.",
    request: "No body.",
    example: `// → 200
{ "schemes": [ { "scheme": "private-vela-fixed", "network": "eip155:<chainId>" } ] }`,
  },
  {
    method: "POST",
    path: "/verify",
    summary: "x402: off-chain payment verification.",
    request:
      "x402 JSON body. Checks the EIP-712 signature, deadline, nonce and permit off-chain — no transaction is sent.",
    params: [
      { name: "paymentPayload", desc: "x402 payload: { x402Version, accepted, payload: { sender, requestSignature, depositPermit, requestAuthorization, payload } }." },
      { name: "paymentRequirements", desc: "x402 requirements: { scheme, network, asset, amount, payTo, maxTimeoutSeconds, extra: { invoiceId } }." },
    ],
    example: `{ "paymentPayload": { ... }, "paymentRequirements": { ... } }
// → 200 { "isValid": true }  |  { "isValid": false, "invalidReason": "..." }`,
  },
  {
    method: "POST",
    path: "/settle",
    summary: "x402: on-chain settlement; blocks until the TEE emits the matching AppEvent.",
    request:
      "Same body shape as /verify. Calls ProcessorEndpoint.submitRequestFor(), then polls for the matching AppEvent (eventSubType = keccak256(len(invoiceId)||invoiceId||sender||token||amount||recipient)). Tunable via APP_EVENT_POLL_INTERVAL_MS / APP_EVENT_POLL_TIMEOUT_MS.",
    params: [
      { name: "paymentPayload", desc: "Same as /verify." },
      { name: "paymentRequirements", desc: "Same as /verify." },
    ],
    example: `{ "paymentPayload": { ... }, "paymentRequirements": { ... } }
// → 200 (confirmed) { "success": true, "transaction": "0x...", "extensions": { "requestId": "0x...", "eventSubType": "0x..." } }
// → 200 (timeout)   { "success": false, "errorReason": "tee_processing_timeout", "extensions": { "requestId": "0x..." } }`,
  },
];

interface ServiceInfo {
  service: string;
  description: string;
  vela: {
    version: string | null;
    network: string | null;
    chainId: number | null;
    rpcUrl: string;
    subgraphUrl: string | null;
    processorEndpoint: string;
    explorerBaseUrl: string | null;
    maxFeeValue: string;
  };
  facilitator: { address: string };
  scheme: { name: string; applicationId: string };
  endpoints: EndpointDescriptor[];
  /** Latest on-chain events from the subgraph; null when none configured/reachable. */
  events: NormalizedEvent[] | null;
}

/**
 * GET / — service landing page.
 * Returns HTML by default and JSON when `Accept: application/json` is sent.
 * Useful as a dev sanity check ("is it up?") and as a machine-readable
 * discovery endpoint for tooling.
 */
export function createLandingRouter(config: Config, provider: ethers.JsonRpcProvider): Router {
  const router = Router();

  router.get("/", async (req: Request, res: Response) => {
    let chainId: number | null = null;
    try {
      chainId = Number((await provider.getNetwork()).chainId);
    } catch {
      // Leave chainId as null — the RPC might be temporarily unreachable; we
      // still want to render the page so the operator can see the config.
    }

    let events: NormalizedEvent[] | null = null;
    if (config.subgraphUrl) {
      try {
        events = await fetchLatestEvents(config.subgraphUrl, 20);
      } catch {
        // Best-effort: a slow/unreachable subgraph must not break the page.
        events = null;
      }
    }

    const info: ServiceInfo = {
      service: "vela-facilitator",
      description:
        "A gasless facilitator for Vela is available, with endpoints compatible with x402 payment standard. \nIt submits signed user requests on-chain via ProcessorEndpoint.submitRequestFor() and pays gas on their behalf.",
      vela: {
        version: config.velaVersion,
        network: chainId != null ? `eip155:${chainId}` : null,
        chainId,
        rpcUrl: config.rpcUrl,
        subgraphUrl: config.subgraphUrl,
        processorEndpoint: config.contractAddress,
        explorerBaseUrl: config.explorerBaseUrl,
        maxFeeValue: config.maxFeeValue.toString(),
      },
      facilitator: { address: config.signer.address },
      scheme: {
        name: "private-vela-fixed",
        applicationId: config.applicationId.toString(),
      },
      endpoints: ENDPOINTS,
      events,
    };

    const preferred = req.accepts(["html", "json"]);
    if (preferred === "json") {
      res.json(info);
      return;
    }
    res.type("html").send(renderHtml(info));
  });

  return router;
}

function esc(s: string | number | null): string {
  if (s === null) return "—";
  return String(s).replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default:  return c;
    }
  });
}

/** Escape, then turn `inline code` markdown spans into <code> elements. */
function inlineText(s: string): string {
  return esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");
}

/** Format Unix seconds as a compact UTC timestamp, e.g. "2026-06-15 09:25:12 UTC". */
function formatTime(unixSeconds: number): string {
  return `${new Date(unixSeconds * 1000).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/** Render the "Latest events" table, or a fallback line when unavailable/empty. */
function renderEvents(events: NormalizedEvent[] | null, explorerBaseUrl: string | null): string {
  if (events === null) {
    return `<p class="hint">No subgraph configured, or it is currently unreachable.</p>`;
  }
  if (events.length === 0) {
    return `<p class="hint">No events found yet.</p>`;
  }
  const blockCell = (n: number): string =>
    explorerBaseUrl
      ? `<a href="${esc(explorerBaseUrl)}/block/${esc(n)}" target="_blank" rel="noopener noreferrer">${esc(n)}</a>`
      : esc(n);
  const rows = events
    .map(
      (e) => `<tr>
        <td class="evt-time">${esc(formatTime(e.timestamp))}</td>
        <td class="evt-block">${blockCell(e.blockNumber)}</td>
        <td><span class="evt-type">${esc(e.type)}</span></td>
        <td class="evt-req">${e.requestId ? `<code>${esc(e.requestId.slice(0, 10))}…${esc(e.requestId.slice(-8))}</code>` : "—"}</td>
        <td class="evt-detail">${esc(e.details)}</td>
      </tr>`,
    )
    .join("");
  return `<table class="events-table">
    <tr><th>Time</th><th>Block</th><th>Event</th><th>Request ID</th><th>Details</th></tr>
    ${rows}
  </table>`;
}

function renderHtml(info: ServiceInfo): string {
  const endpointBlocks = info.endpoints
    .map((e) => {
      const hasDetail = e.request || (e.params && e.params.length) || e.example;
      const paramsHtml =
        e.params && e.params.length
          ? `<dl class="params">${e.params
              .map((p) => `<dt><code>${esc(p.name)}</code></dt><dd>${inlineText(p.desc)}</dd>`)
              .join("")}</dl>`
          : "";
      const requestHtml = e.request ? `<p>${inlineText(e.request)}</p>` : "";
      const exampleHtml = e.example ? `<pre>${esc(e.example)}</pre>` : "";
      const summary = `<summary>
        <span class="method method-${e.method.toLowerCase()}">${esc(e.method)}</span>
        <code class="path">${esc(e.path)}</code>
        <span class="ep-summary">${esc(e.summary)}</span>
      </summary>`;
      if (!hasDetail) {
        return `<details class="endpoint">${summary}</details>`;
      }
      return `<details class="endpoint">${summary}
        <div class="ep-detail">${requestHtml}${paramsHtml}${exampleHtml}</div>
      </details>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Horizen Vela</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root {
    --fg: #1a1a1a;
    --muted: #666;
    --bg: #fafafa;
    --border: #e5e5e5;
    --accent: #0b6;
    --get: #0b6;
    --post: #b60;
  }
  * { box-sizing: border-box; }
  body {
    font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
    color: var(--fg);
    background: var(--bg);
    margin: 0;
    padding: 2rem 1rem;
    line-height: 1.5;
  }
  .layout { display: flex; gap: 2.5rem; max-width: 60rem; margin: 0 auto; align-items: flex-start; }
  .sidebar { flex: none; width: 12rem; position: sticky; top: 2rem; }
  main { flex: 1; min-width: 0; }
  nav { display: flex; flex-direction: column; gap: 0.25rem; margin-top: 1.5rem; }
  .nav-item { display: block; width: 100%; text-align: left; font: inherit; color: var(--muted); background: none; border: none; border-left: 2px solid transparent; padding: 0.4rem 0.75rem; border-radius: 0 4px 4px 0; cursor: pointer; }
  .nav-item:hover { color: var(--fg); background: #fff; }
  .nav-item.active { color: var(--fg); font-weight: 600; border-left-color: var(--accent); background: #fff; }
  .view[hidden] { display: none; }
  h1 { font-size: 1.5rem; margin: 0 0 0.25rem; }
  .tagline { color: var(--muted); margin: 0 0 2rem; }
  h2 { font-size: 1rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin: 2rem 0 0.5rem; }
  dl { display: grid; grid-template-columns: max-content 1fr; column-gap: 1rem; row-gap: 0.25rem; margin: 0; }
  dt { color: var(--muted); }
  dd { margin: 0; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.9rem; word-break: break-all; }
  table { width: 100%; border-collapse: collapse; margin: 0.5rem 0 0; }
  td { padding: 0.5rem 0.75rem; border-top: 1px solid var(--border); vertical-align: top; }
  tr:first-child td { border-top: none; }
  .events-table { font-size: 0.85rem; }
  .events-table th { text-align: left; padding: 0.35rem 0.75rem; color: var(--muted); font-weight: 600; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; border-bottom: 1px solid var(--border); }
  .events-table td { padding: 0.4rem 0.75rem; }
  .events-table tr:first-child td { border-top: none; }
  .evt-time { white-space: nowrap; color: var(--muted); font-family: ui-monospace, monospace; font-size: 0.8rem; }
  .evt-block { white-space: nowrap; font-family: ui-monospace, monospace; font-size: 0.8rem; }
  .evt-type { font-weight: 600; color: var(--accent); }
  .evt-req code { font-family: ui-monospace, monospace; font-size: 0.8rem; background: transparent; }
  .evt-detail { word-break: break-word; color: var(--fg); }
  .method { font-family: ui-monospace, monospace; font-weight: 600; font-size: 0.8rem; width: 1%; white-space: nowrap; }
  .method-get { color: var(--get); }
  .method-post { color: var(--post); }
  .path code { font-family: ui-monospace, monospace; font-size: 0.9rem; background: transparent; padding: 0; }
  .hint { color: var(--muted); font-size: 0.85rem; margin: 0 0 0.25rem; }
  .endpoints { margin-top: 0.25rem; }
  .endpoint { border-top: 1px solid var(--border); }
  .endpoint:first-child { border-top: none; }
  .endpoint > summary {
    padding: 0.55rem 0.25rem;
    cursor: pointer;
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
    align-items: baseline;
    list-style: none;
  }
  .endpoint > summary::-webkit-details-marker { display: none; }
  .endpoint > summary::before { content: "\\25B8"; color: var(--muted); font-size: 0.75rem; flex: none; }
  .endpoint[open] > summary::before { content: "\\25BE"; }
  .endpoint > summary .method { flex: none; width: 3rem; }
  .endpoint > summary .path { flex: none; width: 7rem; }
  .endpoint > summary:hover .ep-summary { color: var(--fg); }
  .ep-summary { color: var(--muted); flex: 1 1 14rem; }
  .ep-detail { padding: 0 0.25rem 1rem 1.5rem; }
  .ep-detail > p { margin: 0.25rem 0 0.75rem; color: var(--fg); }
  .params { row-gap: 0.4rem; margin: 0 0 0.75rem; }
  .params dt { font-family: ui-monospace, monospace; color: var(--fg); }
  .params dt code { font-size: 0.85rem; }
  .params dd { font-family: inherit; font-size: 0.9rem; color: var(--muted); word-break: normal; }
  pre {
    background: #f0f0f0;
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.75rem;
    margin: 0;
    overflow-x: auto;
    font-family: ui-monospace, monospace;
    font-size: 0.78rem;
    line-height: 1.45;
  }
  footer { margin-top: 2.5rem; color: var(--muted); font-size: 0.85rem; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  @media (max-width: 44rem) {
    .layout { flex-direction: column; gap: 1rem; }
    .sidebar { position: static; width: auto; }
    nav { flex-direction: row; flex-wrap: wrap; margin-top: 0.5rem; }
    .nav-item { width: auto; border-left: none; border-bottom: 2px solid transparent; border-radius: 4px 4px 0 0; }
    .nav-item.active { border-left-color: transparent; border-bottom-color: var(--accent); }
  }
</style>
<noscript><style>.view[hidden] { display: block; } nav { display: none; }</style></noscript>
</head>
<body>
<div class="layout">
  <aside class="sidebar">
    <h1>Horizen Vela</h1>
    <nav>
      <button type="button" class="nav-item active" data-view="status">Service status</button>
      <button type="button" class="nav-item" data-view="facilitator">Facilitator</button>
      <button type="button" class="nav-item" data-view="codebase">Codebase</button>
    </nav>
  </aside>

  <main>
    <section id="view-status" class="view">
      <dl>
        <dt>Version</dt><dd>${esc(info.vela.version)}</dd>
        <dt>ProcessorEndpoint</dt><dd><a href="${esc(info.vela.explorerBaseUrl)}/address/${esc(info.vela.processorEndpoint)}" target="_blank" rel="noopener noreferrer">${esc(info.vela.processorEndpoint)}</a></dd>
        <dt>Network</dt><dd>${esc(info.vela.network)}${info.vela.chainId != null ? ` (chainId ${esc(info.vela.chainId)})` : ""}</dd>
        <dt>Network RPC</dt><dd>${esc(info.vela.rpcUrl)}</dd>
        <dt>SubGraph URL</dt><dd>${info.vela.subgraphUrl != null ? `<a href="${esc(info.vela.subgraphUrl)}" target="_blank" rel="noopener noreferrer">${esc(info.vela.subgraphUrl)}</a>` : "—"}</dd>
      </dl>

      <h2>Latest events:</h2>
      <p class="hint">Most recent on-chain events from the subgraph (newest first).</p>
      ${renderEvents(info.events, info.vela.explorerBaseUrl)}
    </section>

    <section id="view-facilitator" class="view" hidden>
      <h2>Facilitator service:</h2>
      <p class="tagline">${esc(info.description)}</p>
      <dl>
        <dt>Facilitator public wallet address</dt><dd>${esc(info.facilitator.address)}</dd>
        <dt>x402 scheme Name</dt><dd>${esc(info.scheme.name)}</dd>
        <dt>x402 Nova applicationId</dt><dd>${esc(info.scheme.applicationId)}</dd>
      </dl>

      <h2>Facilitator endpoints</h2>
      <p class="hint">Click an endpoint to see its parameters and an example.</p>
      <div class="endpoints">${endpointBlocks}
      </div>
    </section>

    <section id="view-codebase" class="view" hidden>
      <h2>GitHub reposositories:</h2>
      <p class="tagline">The Vela project codebase is available in the following public repositories: </p>
      <dl>
        <dt>Developer starter kit</dt><dd><a href="https://github.com/HorizenOfficial/vela-starterkit" target="_blank" rel="noopener noreferrer">https://github.com/HorizenOfficial/vela-starterkit</a></dd>
        <dt>Main repository</dt><dd><a href="https://github.com/HorizenOfficial/vela" target="_blank" rel="noopener noreferrer">https://github.com/HorizenOfficial/vela</a></dd>
        <dt>Client TypeScript library</dt><dd><a href="https://github.com/HorizenOfficial/vela-common-ts" target="_blank" rel="noopener noreferrer">https://github.com/HorizenOfficial/vela-common-ts</a></dd>
        <dt>Common GO library</dt><dd><a href="https://github.com/HorizenOfficial/vela-common-go" target="_blank" rel="noopener noreferrer">https://github.com/HorizenOfficial/vela-common-go</a></dd>
        <dt>Vela Facilitator (this service)</dt><dd><a href="https://github.com/HorizenOfficial/vela-facilitator" target="_blank" rel="noopener noreferrer">https://github.com/HorizenOfficial/vela-facilitator</a></dd>
        </dl>
    </section>

    <footer>
      Send <code>Accept: application/json</code> to this endpoint for a machine-readable view.
    </footer>
  </main>
</div>
<script>
  (function () {
    var items = document.querySelectorAll(".nav-item");
    var views = { status: "view-status", facilitator: "view-facilitator", codebase: "view-codebase" };
    function show(view) {
      if (!views[view]) view = "status";
      Object.keys(views).forEach(function (k) {
        document.getElementById(views[k]).hidden = k !== view;
      });
      items.forEach(function (i) {
        i.classList.toggle("active", i.dataset.view === view);
      });
      if (history.replaceState) history.replaceState(null, "", "#" + view);
    }
    items.forEach(function (i) {
      i.addEventListener("click", function () { show(i.dataset.view); });
    });
    show(location.hash.replace("#", "") || "status");
  })();
</script>
</body>
</html>
`;
}
