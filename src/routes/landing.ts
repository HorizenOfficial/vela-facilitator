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
        events = await fetchLatestEvents(config.subgraphUrl, chainId, 20);
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

/** Friendly chain names; falls back to the eip155 network string for unknown chains. */
const CHAIN_NAMES: Record<number, string> = {
  84532: "Base Sepolia Testnet",
};

function networkLabel(chainId: number | null, network: string | null): string | null {
  if (chainId != null && CHAIN_NAMES[chainId]) return CHAIN_NAMES[chainId];
  return network;
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

/** Favicon (48×48 PNG), embedded so the page is self-contained — matches vela.horizenlabs.io. */
const FAVICON_DATA_URI =
  "data:image/png;base64,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";

/** Horizen Labs wordmark (inline SVG so it inherits the page and needs no extra request). */
const HORIZEN_LOGO_SVG = `<svg viewBox="0 0 170 40" fill="#041742" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M18.4369 0.257324V7.8207C20.7344 7.43097 23.062 7.23555 25.3938 7.23635C26.7737 7.23635 28.1376 7.30175 29.4856 7.43273V0.257324H18.4369Z"/><path d="M18.4369 20.9609V39.7946L29.4856 32.6051V20.3485C28.1564 20.1548 26.8144 20.058 25.4705 20.0586C23.0958 20.061 20.7314 20.3644 18.4369 20.9609Z"/><path d="M0.0191956 32.5957L11.0679 39.7852V21.7461C6.44115 24.3137 2.62068 28.0652 0.0191956 32.5957Z"/><path d="M11.0679 0.257324H0.0191956V13.6406C3.38396 11.169 7.10779 9.20125 11.0679 7.80203V0.257324Z"/><path d="M25.3299 8.63825H25.3938C26.2825 8.63825 27.1709 8.6668 28.0483 8.72328V16.7745C27.1596 16.6982 26.2663 16.6598 25.378 16.6598C20.1232 16.6598 14.9297 17.9966 10.3587 20.5261C6.90645 22.4369 3.88081 24.9757 1.43744 27.9899V16.6808C8.23303 11.49 16.6901 8.63825 25.3299 8.63825ZM25.3299 7.236C16.1053 7.236 7.16218 10.3318 0 16.0054V32.5953C2.60672 28.0622 6.43406 24.3106 11.0678 21.7457C15.4513 19.3202 20.3851 18.062 25.378 18.062C26.7463 18.062 28.1186 18.1565 29.4856 18.3473V7.43222C28.1409 7.30141 26.7768 7.23584 25.3938 7.23584C25.3729 7.23584 25.3507 7.236 25.3299 7.236Z"/><path d="M42.7767 39.7849V28.5659H44.7938V38.0553H49.8678V39.7895L42.7767 39.7849Z"/><path d="M70.4274 39.7849L69.5841 37.63H64.3136L63.4655 39.7849H61.1752L65.6933 28.5659H68.2088L72.727 39.7849H70.4274ZM66.944 30.548L64.879 35.919H69.0139L66.944 30.548Z"/><path d="M84.346 39.7849V28.5659H90.0189C92.1224 28.5659 93.2962 29.8468 93.2962 31.4267C93.3553 32.6439 92.5114 33.7273 91.2935 33.9977C92.6173 34.281 93.5507 35.4384 93.5214 36.7604C93.5214 38.49 92.3284 39.7895 90.1674 39.7895L84.346 39.7849ZM91.2119 31.7587C91.2379 30.9718 90.605 30.3132 89.7984 30.2879C89.7297 30.2856 89.6609 30.2883 89.5925 30.2955H86.368V33.2031H89.5925C90.6274 33.2031 91.2119 32.6002 91.2119 31.7587ZM91.4373 36.4847C91.4373 35.6434 90.8336 34.9375 89.6788 34.9375H86.368V38.0506H89.6788C90.7807 38.0506 91.4564 37.4617 91.4564 36.4847H91.4373Z"/><path d="M105.092 38.2003L106.209 36.6857C107.149 37.6738 108.468 38.2347 109.85 38.233C111.503 38.233 112.16 37.443 112.16 36.7044C112.16 34.3671 105.452 35.8115 105.452 31.6746C105.452 29.8048 107.124 28.4024 109.644 28.4024C111.238 28.3418 112.791 28.9057 113.956 29.9683L112.802 31.4315C111.911 30.5913 110.715 30.1305 109.476 30.1506C108.283 30.1506 107.526 30.7069 107.526 31.5531C107.526 33.6379 114.234 32.343 114.234 36.5314C114.234 38.4013 112.893 39.9999 109.788 39.9999C107.641 39.9858 106.108 39.2613 105.092 38.2003Z"/><path d="M73.7285 1.03348e-06C67.7508 -0.00255141 62.9028 4.72314 62.9002 10.5552C62.8976 16.3872 67.7413 21.117 73.719 21.1196C79.6967 21.1221 84.5447 16.3964 84.5473 10.5644V10.5598C84.5445 4.73064 79.7033 0.00510592 73.7285 1.03348e-06ZM73.7285 17.0433C70.0557 17.0459 67.076 14.1431 67.0734 10.5598C67.0708 6.97647 70.046 4.0694 73.7189 4.06684C77.3917 4.06429 80.3714 6.96706 80.374 10.5504V10.5598C80.3714 14.1396 77.3976 17.0408 73.7285 17.0433Z"/><path d="M46.9643 20.6756H42.7767V0.257324H46.9643V8.42834H55.3252V0.257324H59.5127V20.6758H55.3252V12.5186H46.9643V20.6756Z"/><path d="M112.318 20.6756H108.13V0.257324H112.318V20.6756Z"/><path d="M131.885 20.6756H115.691L124.622 4.34283H115.691V0.257324H131.885L122.988 16.5901H131.885V20.6756Z"/><path d="M149.575 20.6756H135.23V0.257324H149.575V4.34283H139.417V8.42834H146.293V12.5186H139.417V16.5901H149.575V20.6756Z"/><path d="M169.991 20.6756H165.516L157.442 7.23635V20.6756H153.264V0.257324H157.744L165.813 13.7106V0.257324H170L169.991 20.6756Z"/><path d="M104.709 7.00694C104.709 2.64561 102.05 0.256836 97.6898 0.256836H87.9011V20.6751H92.0887V13.7569H95.7684L100.009 20.6751H104.642L100.33 13.3968C103.104 12.5835 104.709 10.3913 104.709 7.00694ZM92.0887 6.72649V4.3425H97.0909C98.9068 4.3425 100.445 5.24942 100.445 7.00694C100.445 8.76445 98.9165 9.67137 97.0909 9.67137H92.0887V6.72649Z"/></svg>`;

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
<link rel="icon" type="image/png" href="${FAVICON_DATA_URI}" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@500;600;700&family=Roboto:wght@400;500;700&display=swap" rel="stylesheet" />
<style>
  :root {
    --fg: #1a1a1a;
    --muted: #666;
    --bg: #fafafa;
    --border: #e5e5e5;
    --accent: #009e9c;
    --up: #00c85a;
    --get: #0b6;
    --post: #b60;
    --font-sans: "Roboto", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --font-heading: "IBM Plex Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --font-mono: "IBM Plex Mono", "Menlo", "Consolas", monospace;
  }
  * { box-sizing: border-box; }
  /* Always reserve the scrollbar gutter so switching views never shifts the layout. */
  html { overflow-y: scroll; }
  body {
    font-family: var(--font-sans);
    color: var(--fg);
    background: var(--bg);
    margin: 0;
    padding: 2rem 1rem;
    line-height: 1.5;
  }
  .topbar { display: flex; align-items: center; gap: 1rem; max-width: 80rem; margin: 0 auto 2rem; padding-bottom: 1.25rem; border-bottom: 1px solid var(--border); }
  .layout { display: flex; gap: 2.5rem; max-width: 80rem; margin: 0 auto; align-items: flex-start; }
  .sidebar { flex: none; width: 12rem; position: sticky; top: 2rem; }
  .brand-logo { display: block; flex: none; }
  .brand-logo svg { width: 8rem; height: auto; display: block; }
  .brand-title { flex: 1; text-align: center; font-size: 1.4rem; margin: 0; }
  .brand-spacer { flex: none; width: 8rem; }
  main { flex: 1; min-width: 0; }
  nav { display: flex; flex-direction: column; gap: 0.25rem; }
  .nav-item { display: flex; align-items: center; gap: 0.55rem; width: 100%; text-align: left; font: inherit; color: var(--muted); background: none; border: none; border-left: 2px solid transparent; padding: 0.4rem 0.75rem; border-radius: 0 4px 4px 0; cursor: pointer; }
  .nav-item:hover { color: var(--fg); background: #fff; }
  .nav-item.active { color: var(--fg); font-weight: 600; border-left-color: var(--accent); background: #fff; }
  .nav-item .nav-icon { flex: none; width: 1rem; height: 1rem; display: inline-flex; align-items: center; justify-content: center; }
  .nav-item .nav-icon svg { width: 100%; height: 100%; }
  /* Pulsing green "service is up" indicator. */
  .status-dot { display: inline-block; width: 0.6rem; height: 0.6rem; border-radius: 50%; background: var(--up); box-shadow: 0 0 0 0 var(--up); animation: status-pulse 1.8s ease-out infinite; }
  @keyframes status-pulse {
    0%   { box-shadow: 0 0 0 0 rgba(0, 200, 90, 0.55); }
    70%  { box-shadow: 0 0 0 0.5rem rgba(0, 200, 90, 0); }
    100% { box-shadow: 0 0 0 0 rgba(0, 200, 90, 0); }
  }
  @media (prefers-reduced-motion: reduce) { .status-dot { animation: none; } }
  .view[hidden] { display: none; }
  h1 { font-family: var(--font-heading); font-weight: 700; font-size: 1.5rem; margin: 0 0 0.25rem; letter-spacing: -0.01em; }
  .tagline { color: var(--muted); margin: 0 0 2rem; }
  h2 { font-family: var(--font-heading); font-weight: 600; font-size: 1rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin: 2rem 0 0.5rem; }
  dl { display: grid; grid-template-columns: max-content 1fr; column-gap: 1rem; row-gap: 0.25rem; margin: 0; }
  dt { color: var(--muted); }
  dd { margin: 0; font-family: var(--font-mono); font-size: 0.9rem; word-break: break-all; }
  table { width: 100%; border-collapse: collapse; margin: 0.5rem 0 0; }
  td { padding: 0.5rem 0.75rem; border-top: 1px solid var(--border); vertical-align: top; }
  tr:first-child td { border-top: none; }
  .events-table { font-size: 0.85rem; }
  .events-table th { text-align: left; padding: 0.35rem 0.75rem; color: var(--muted); font-weight: 600; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; border-bottom: 1px solid var(--border); }
  .events-table td { padding: 0.4rem 0.75rem; }
  .events-table tr:first-child td { border-top: none; }
  .evt-time { white-space: nowrap; color: var(--muted); font-family: var(--font-mono); font-size: 0.8rem; }
  .evt-block { white-space: nowrap; font-family: var(--font-mono); font-size: 0.8rem; }
  .evt-type { font-weight: 600; color: var(--accent); }
  .evt-req code { font-family: var(--font-mono); font-size: 0.8rem; background: transparent; }
  .evt-detail { word-break: break-word; color: var(--fg); }
  .method { font-family: var(--font-mono); font-weight: 600; font-size: 0.8rem; width: 1%; white-space: nowrap; }
  .method-get { color: var(--get); }
  .method-post { color: var(--post); }
  .path code { font-family: var(--font-mono); font-size: 0.9rem; background: transparent; padding: 0; }
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
  .params dt { font-family: var(--font-mono); color: var(--fg); }
  .params dt code { font-size: 0.85rem; }
  .params dd { font-family: inherit; font-size: 0.9rem; color: var(--muted); word-break: normal; }
  pre {
    background: #f0f0f0;
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.75rem;
    margin: 0;
    overflow-x: auto;
    font-family: var(--font-mono);
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
<header class="topbar">
  <a class="brand-logo" href="https://horizenlabs.io" target="_blank" rel="noopener noreferrer">${HORIZEN_LOGO_SVG}</a>
  <h1 class="brand-title">Horizen Vela System info</h1>
  <span class="brand-spacer" aria-hidden="true"></span>
</header>
<div class="layout">
  <aside class="sidebar">
    <nav>
      <button type="button" class="nav-item active" data-view="status"><span class="nav-icon"><span class="status-dot"></span></span>Service status</button>
      <button type="button" class="nav-item" data-view="facilitator"><span class="nav-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m11 17 2 2a1 1 0 1 0 3-3"/><path d="m14 14 2.5 2.5a1 1 0 1 0 3-3l-3.88-3.88a3 3 0 0 0-4.24 0l-.88.88a1 1 0 1 1-3-3l2.81-2.81a5.79 5.79 0 0 1 7.06-.87l.47.28a2 2 0 0 0 1.42.25L21 4"/><path d="m21 3 1 11h-2"/><path d="M3 3 2 14l6.5 6.5a1 1 0 1 0 3-3"/><path d="M3 4h8"/></svg></span>Facilitator</button>
      <button type="button" class="nav-item" data-view="codebase"><span class="nav-icon"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.29-.01-1.05-.02-2.06-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.33-1.76-1.33-1.76-1.09-.74.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.5.99.11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.11-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6.01 0c2.29-1.55 3.3-1.23 3.3-1.23.65 1.66.24 2.88.12 3.18.77.84 1.23 1.91 1.23 3.22 0 4.61-2.8 5.62-5.48 5.92.43.37.81 1.1.81 2.22 0 1.61-.01 2.9-.01 3.29 0 .32.21.7.82.58A12.01 12.01 0 0 0 24 12.5C24 5.87 18.63.5 12 .5z"/></svg></span>Codebase</button>
    </nav>
  </aside>

  <main>
    <section id="view-status" class="view">
      <h2>Version info:</h2>
      <dl>
        <dt>Version</dt><dd>${esc(info.vela.version)}</dd>
        <dt>ProcessorEndpoint</dt><dd><a href="${esc(info.vela.explorerBaseUrl)}/address/${esc(info.vela.processorEndpoint)}" target="_blank" rel="noopener noreferrer">${esc(info.vela.processorEndpoint)}</a></dd>
        <dt>Network</dt><dd>${esc(networkLabel(info.vela.chainId, info.vela.network))}${info.vela.chainId != null ? ` (chainId ${esc(info.vela.chainId)})` : ""}</dd>
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
      <h2>GitHub repositories:</h2>
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
