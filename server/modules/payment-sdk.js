/**
 * Payment SDK helper — Nuitee LiteAPI Payment SDK configuration
 *
 * The Nuitee payment SDK is a frontend JavaScript library:
 *   <script src="https://payment-wrapper.liteapi.travel/dist/liteAPIPayment.js?v=a1"></script>
 *
 * This helper gives the frontend the correct config object to instantiate
 * `new LiteAPIPayment(config)` after a successful prebook.
 *
 * Config must match the API key environment:
 *   - sandbox key  → publicKey: "sandbox"
 *   - prod key     → publicKey: "live"
 */

/**
 * Build the payment SDK config from a prebook response.
 *
 * Prebook response must include:
 *   secretKey, transactionId, prebookId
 *
 * @param {Object} prebookData – the prebook response data from createPrebook()
 * @param {string} returnUrl   – where the user goes after payment (e.g. /confirmation?prebookId=...&transactionId=...)
 * @returns {Object} config suitable for `new LiteAPIPayment(config)`
 */
function buildPaymentConfig(prebookData, returnUrl) {
  if (!prebookData?.secretKey) {
    throw new Error("secretKey is required from the prebook response");
  }
  if (!prebookData?.transactionId) {
    throw new Error("transactionId is required from the prebook response");
  }
  if (!returnUrl) {
    throw new Error("returnUrl is required");
  }

  const isSandbox = !process.env.PROD_API_KEY;

  return {
    publicKey:  isSandbox ? "sandbox" : "live",
    secretKey:  prebookData.secretKey,
    transactionId: prebookData.transactionId,
    prebookId:  prebookData.prebookId,
    returnUrl:  returnUrl,
    targetElement: "#payment-target",
    appearance: {
      theme: "flat",
    },
    options: {
      business: {
        name: process.env.BUSINESS_NAME || "PlanurStay",
      },
    },
  };
}

/**
 * Return whether the current environment is sandbox.
 */
function isSandboxEnv() {
  return !process.env.PROD_API_KEY;
}

/**
 * Get the test card details for sandbox mode.
 * Show this to users when they're booking in sandbox.
 */
function sandboxTestCard() {
  return {
    number: "4242424242424242",
    cvv:    "any 3 digits",
    expiry: "any future date",
  };
}

module.exports = {
  buildPaymentConfig,
  isSandboxEnv,
  sandboxTestCard,
};
