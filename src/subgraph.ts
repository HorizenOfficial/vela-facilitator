/**
 * Minimal read-only client for the Vela subgraph (Goldsky). Used by the landing
 * page to show the latest on-chain events. Best-effort: callers should treat a
 * thrown error / null as "subgraph unavailable" and degrade gracefully.
 */

/** A single on-chain event, normalized across the heterogeneous subgraph entities. */
export interface NormalizedEvent {
  /** Event type label, e.g. "RequestSubmitted". */
  type: string;
  /** Unix seconds (from `blockTimestamp`). */
  timestamp: number;
  /** Block number the event was emitted in. */
  blockNumber: number;
  /** The Vela requestId (bytes32 hex), when the event carries one. */
  requestId?: string;
  /** Human-readable, type-specific one-liner (sender, status, amount, …). */
  details: string;
}

/**
 * Each entry maps a subgraph collection (the plural query field) to the fields
 * we select and how to turn a row into a NormalizedEvent.details string.
 */
interface EventSource {
  /** Plural query field on the subgraph, e.g. "requestSubmitteds". */
  collection: string;
  /** Display label for the event type. */
  type: string;
  /** Extra fields (beyond blockNumber/blockTimestamp) to select. */
  fields: string[];
  /** Build the details one-liner from a row. */
  details: (row: Record<string, unknown>) => string;
}

const short = (hex: unknown): string => {
  const s = String(hex ?? "");
  return s.length > 12 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s;
};

const status = (row: Record<string, unknown>): string => {
  const code = Number(row.status);
  if (code === 0) return "✓ completed";
  const msg = row.errorMessage ? `: ${String(row.errorMessage)}` : "";
  return `✗ failed (error ${String(row.errorCode ?? code)})${msg}`;
};

const amount = (row: Record<string, unknown>, to: string): string =>
  `${String(row.amount)} of ${short(row.tokenAddress)} → ${short(row[to])}`;

const SOURCES: EventSource[] = [
  {
    collection: "requestSubmitteds",
    type: "RequestSubmitted",
    fields: ["requestId", "sender"],
    details: (r) => `from ${short(r.sender)}`,
  },
  {
    collection: "requestCompleteds",
    type: "RequestCompleted",
    fields: ["requestId", "status", "errorCode", "errorMessage"],
    details: status,
  },
  {
    collection: "deployRequestSubmitteds",
    type: "DeployRequestSubmitted",
    fields: ["requestId", "sender"],
    details: (r) => `from ${short(r.sender)}`,
  },
  {
    collection: "deployRequestCompleteds",
    type: "DeployRequestCompleted",
    fields: ["requestId", "status", "errorCode", "errorMessage"],
    details: status,
  },
  {
    collection: "onChainRefunds",
    type: "OnChainRefund",
    fields: ["requestId", "to", "tokenAddress", "amount"],
    details: (r) => amount(r, "to"),
  },
  {
    collection: "onChainWithdrawals",
    type: "OnChainWithdrawal",
    fields: ["requestId", "to", "tokenAddress", "amount"],
    details: (r) => amount(r, "to"),
  },
  {
    collection: "claimExecuteds",
    type: "ClaimExecuted",
    fields: ["payee", "tokenAddress", "amount"],
    details: (r) => amount(r, "payee"),
  },
  {
    collection: "tokenAlloweds",
    type: "TokenAllowed",
    fields: ["token"],
    details: (r) => short(r.token),
  },
  {
    collection: "tokenRemoveds",
    type: "TokenRemoved",
    fields: ["token"],
    details: (r) => short(r.token),
  },
];

/**
 * Fetch the latest `limit` on-chain events across all tracked sources, sorted
 * newest-first. Pulls `limit` rows per source then merges, so the result is the
 * true global top-`limit` by timestamp. Throws on network/GraphQL errors.
 */
export async function fetchLatestEvents(
  subgraphUrl: string,
  limit = 20,
  timeoutMs = 4000,
): Promise<NormalizedEvent[]> {
  const query = `{
${SOURCES.map(
    (s) =>
      `  ${s.collection}(first: ${limit}, orderBy: blockTimestamp, orderDirection: desc) { ${[
        ...s.fields,
        "blockNumber",
        "blockTimestamp",
      ].join(" ")} }`,
  ).join("\n")}
}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let json: { data?: Record<string, Record<string, unknown>[]>; errors?: unknown };
  try {
    const res = await fetch(subgraphUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`subgraph HTTP ${res.status}`);
    json = (await res.json()) as typeof json;
  } finally {
    clearTimeout(timer);
  }
  if (json.errors) throw new Error(`subgraph GraphQL error: ${JSON.stringify(json.errors)}`);

  const events: NormalizedEvent[] = [];
  for (const src of SOURCES) {
    const rows = json.data?.[src.collection] ?? [];
    for (const row of rows) {
      events.push({
        type: src.type,
        timestamp: Number(row.blockTimestamp),
        blockNumber: Number(row.blockNumber),
        requestId: row.requestId ? String(row.requestId) : undefined,
        details: src.details(row),
      });
    }
  }

  // Global newest-first ordering; block number breaks ties within a block.
  events.sort((a, b) => b.timestamp - a.timestamp || b.blockNumber - a.blockNumber);
  return events.slice(0, limit);
}
