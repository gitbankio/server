import { Router, type IRouter } from "express";

const USDC_MAINNET  = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO        = "0x1e660A9A1f1F08AFEF9c03c96D66260122464CF2"; // deployer / feeCollector
const AMOUNT_ATOMIC = "200000"; // 0.2 USDC (6 decimals) — above the vault MINIMUM_FEE of 0.1 USDC

const router: IRouter = Router();

/**
 * GET /api/x402-test
 *
 * A minimal x402-compatible endpoint used for E2E testing.
 *
 * - Without X-PAYMENT header: returns HTTP 402 + PAYMENT-REQUIRED header
 * - With X-PAYMENT header: validates presence of the header and returns 200
 *
 * extra.name / extra.version must match the USDC EIP-712 domain on Base mainnet:
 *   name: "USD Coin", version: "2"
 */
router.get("/x402-test", (req, res) => {
  const xPayment = req.headers["x-payment"];

  if (xPayment) {
    res.status(200).json({
      success: true,
      message: "Payment verified. Access granted.",
      resource: "Gitbank x402 test resource",
      paymentReceived: true,
    });
    return;
  }

  const payload = {
    accepts: [
      {
        scheme:            "exact",
        network:           "eip155:8453",
        maxAmountRequired: AMOUNT_ATOMIC,
        resource:          "https://gitbank.io/api/x402-test",
        description:       "Gitbank x402 E2E test endpoint — 0.2 USDC on Base mainnet",
        mimeType:          "application/json",
        payTo:             PAY_TO,
        maxTimeoutSeconds: 300,
        asset:             USDC_MAINNET,
        extra:             { name: "USD Coin", version: "2" },
      },
    ],
  };

  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");

  res
    .status(402)
    .setHeader("PAYMENT-REQUIRED", encoded)
    .json({
      error:  "Payment required",
      amount: AMOUNT_ATOMIC,
      asset:  USDC_MAINNET,
      payTo:  PAY_TO,
    });
});

export default router;
