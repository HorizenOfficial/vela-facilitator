// Types
export * from "./types.js";

// Scheme + facilitator registration
export { PrivateVelaFixedScheme, SCHEME_NAME } from "./scheme.js";
export { registerPrivateVelaFixedScheme } from "./register.js";

// Verify / settle (also usable standalone)
export { verifyPayment } from "./verify.js";
export { settlePayment } from "./settle.js";

// Client + server (added in Tasks 10 & 11)
export { registerPrivateVelaFixedClient } from "./client.js";
export { registerPrivateVelaFixedServer } from "./server.js";

// Standalone HTTP client for the vela-facilitator server
export {
  FacilitatorClient,
  type FacilitatorClientConfig,
  type HttpResponse,
} from "./facilitator-client.js";
