import { Router, Request, Response } from "express";
import { ethers } from "ethers";
import { Config } from "../config.js";

/**
 * Single source of truth for the endpoints the facilitator exposes. Also
 * printed by the landing page and served as JSON under `Accept: application/json`.
 * Keep in sync when mounting new routes in src/app.ts.
 */
interface EndpointDescriptor {
  method: string;
  path: string;
  summary: string;
}

const ENDPOINTS: EndpointDescriptor[] = [
  { method: "GET",  path: "/",          summary: "Service info and endpoint directory (this page)." },
  { method: "POST", path: "/submit",    summary: "Application-agnostic gasless request submission (ASSOCIATEKEY, PROCESS)." },
  { method: "POST", path: "/claim",     summary: "Permissionless claim of pending balances on ProcessorEndpoint." },
  { method: "GET",  path: "/supported", summary: "x402: supported schemes and networks." },
  { method: "POST", path: "/verify",    summary: "x402: off-chain payment verification." },
  { method: "POST", path: "/settle",    summary: "x402: on-chain settlement; blocks until the TEE emits the matching AppEvent." },

];

interface ServiceInfo {
  service: string;
  description: string;
  vela: {
    version: string | null;
    network: string | null;
    chainId: number | null;
    rpcUrl: string;
    processorEndpoint: string;
    explorerBaseUrl: string | null;
    maxFeeValue: string;
  };
  facilitator: { address: string };
  scheme: { name: string; applicationId: string };
  endpoints: EndpointDescriptor[];
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

    const info: ServiceInfo = {
      service: "vela-facilitator",
      description:
        "A gasless facilitator for Vela is available, with endpoints compatible with x402 payment standard. \nIt submits signed user requests on-chain via ProcessorEndpoint.submitRequestFor() and pays gas on their behalf.",
      vela: {
        version: config.velaVersion,
        network: chainId != null ? `eip155:${chainId}` : null,
        chainId,
        rpcUrl: config.rpcUrl,
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

function renderHtml(info: ServiceInfo): string {
  const endpointRows = info.endpoints
    .map(
      (e) => `
      <tr>
        <td class="method method-${e.method.toLowerCase()}">${esc(e.method)}</td>
        <td class="path"><code>${esc(e.path)}</code></td>
        <td>${esc(e.summary)}</td>
      </tr>`,
    )
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
  main { max-width: 48rem; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin: 0 0 0.25rem; }
  .tagline { color: var(--muted); margin: 0 0 2rem; }
  h2 { font-size: 1rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin: 2rem 0 0.5rem; }
  dl { display: grid; grid-template-columns: max-content 1fr; column-gap: 1rem; row-gap: 0.25rem; margin: 0; }
  dt { color: var(--muted); }
  dd { margin: 0; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.9rem; word-break: break-all; }
  table { width: 100%; border-collapse: collapse; margin: 0.5rem 0 0; }
  td { padding: 0.5rem 0.75rem; border-top: 1px solid var(--border); vertical-align: top; }
  tr:first-child td { border-top: none; }
  .method { font-family: ui-monospace, monospace; font-weight: 600; font-size: 0.8rem; width: 1%; white-space: nowrap; }
  .method-get { color: var(--get); }
  .method-post { color: var(--post); }
  .path code { font-family: ui-monospace, monospace; font-size: 0.9rem; background: transparent; padding: 0; }
  footer { margin-top: 2.5rem; color: var(--muted); font-size: 0.85rem; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
<main>
  <h1>Horizen Vela</h1>
  <dl>
    <dt>Version</dt><dd>${esc(info.vela.version)}</dd>
    <dt>ProcessorEndpoint</dt><dd><a href="${esc(info.vela.explorerBaseUrl)}/address/${esc(info.vela.processorEndpoint)}" target="_blank" rel="noopener noreferrer">${esc(info.vela.processorEndpoint)}</a></dd>
    <dt>Network</dt><dd>${esc(info.vela.network)}${info.vela.chainId != null ? ` (chainId ${esc(info.vela.chainId)})` : ""}</dd>
    <dt>Network RPC</dt><dd>${esc(info.vela.rpcUrl)}</dd>
    <dt>Git repos:</dt><dd>
    Developer starter kit: <a href="https://github.com/HorizenOfficial/vela-starterkit">https://github.com/HorizenOfficial/vela-starterkit</a><br/>
    Client TypeScript library: <a href="https://github.com/HorizenOfficial/vela-common-ts">https://github.com/HorizenOfficial/vela-common-ts</a><br/>
    Framework repository: <a href="https://github.com/HorizenOfficial/vela">https://github.com/HorizenOfficial/vela</a><br/>
    Comon GO library: <a href="https://github.com/HorizenOfficial/vela-common-go">https://github.com/HorizenOfficial/vela-common-go</a><br/>
    
    </dd>
  </dl>



  <h2>Facilitator service:</h2>
  <p class="tagline">${esc(info.description)}</p>
  <dl>
    <dt>Facilitator public wallet address</dt><dd>${esc(info.facilitator.address)}</dd>
    <dt>x402 scheme Name</dt><dd>${esc(info.scheme.name)}</dd>
    <dt>x402 Nova applicationId</dt><dd>${esc(info.scheme.applicationId)}</dd>
  </dl>

  <h2>Facilitator endpoints</h2>
  <table>${endpointRows}
  </table>

  <footer>
    Send <code>Accept: application/json</code> to this endpoint for a machine-readable view.
  </footer>
</main>
</body>
</html>
`;
}
