// Types
export * from "./types.js";

// Scheme + facilitator registration
export { PrivateVelaFixedScheme, SCHEME_NAME } from "./scheme.js";
export { registerPrivateVelaFixedScheme } from "./register.js";

// Verify / settle (also usable standalone)
export { verifyPayment } from "./verify.js";
export { settlePayment } from "./settle.js";

// Transfer receipt hash — TypeScript port of vela-nova's AppEvent.eventSubType.
// Exposed so sellers / monitoring tools can recompute the expected hash and
// subscribe to the corresponding AppEvent without going through /settle.
export { computeTransferReceiptHash } from "./transfer-receipt-hash.js";

export { registerPrivateVelaFixedClient } from "./client.js";
export { registerPrivateVelaFixedServer } from "./server.js";

// Standalone HTTP helper for the vela-facilitator server — convenience wrapper
// around /submit, /claim, /verify, /settle, /supported (plus EIP-712/EIP-2612
// signing + P-521 payload encryption helpers). Kept separate from the x402Client
// interface (FacilitatorClient) of @x402/core to avoid naming collisions.
export {
  FacilitatorHelper,
  type FacilitatorHelperConfig,
  type HttpResponse,
} from "./facilitator-helper.js";
