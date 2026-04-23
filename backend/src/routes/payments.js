const router = require("express").Router();
const { body, query, validationResult } = require("express-validator");
const StellarSdk = require("@stellar/stellar-sdk");
const authMiddleware = require("../middleware/auth");
const idempotency = require("../middleware/idempotency");
const paymentSendValidators = require("../validators/paymentSendValidators");
const paymentBatchValidators = require("../validators/paymentBatchValidators");
const {
  send,
  sendBatch,
  history,
  exportCSV,
  estimateFee,
  findPath,
  sendPath,
} = require("../controllers/paymentController");
const { resolveFederationAddress } = require("../services/stellar");
const { isMemoRequired } = require("../services/memoRequired");
const { ALLOWED_HISTORY_ASSETS } = require("../utils/historyQuery");

const VALID_ASSETS = ["XLM", "USDC", "NGN", "GHS", "KES"];

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  next();
};

router.use(authMiddleware);

router.get("/estimate-fee", estimateFee);

router.post("/send", paymentSendValidators, validate, idempotency, send);
router.post("/batch", paymentBatchValidators, validate, idempotency, sendBatch);

router.get(
  "/resolve-federation",
  [query("address").notEmpty().withMessage("Address is required")],
  validate,
  async (req, res) => {
    try {
      const publicKey = await resolveFederationAddress(req.query.address);
      res.json({ public_key: publicKey });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  },
);

router.get(
  "/memo-required",
  [query("address").notEmpty().withMessage("Address is required")],
  validate,
  async (req, res) => {
    try {
      const required = await isMemoRequired(req.query.address);
      res.json({ memo_required: required });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

router.get(
  "/history",
  [
    query("page").optional().isInt({ min: 1 }).withMessage("page must be a positive integer"),
    query("limit")
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage("limit must be between 1 and 100"),
    query("from")
      .optional({ values: "falsy" })
      .trim()
      .isISO8601()
      .withMessage("from must be a valid ISO 8601 date"),
    query("to")
      .optional({ values: "falsy" })
      .trim()
      .isISO8601()
      .withMessage("to must be a valid ISO 8601 date"),
    query("asset")
      .optional({ values: "falsy" })
      .trim()
      .isIn(ALLOWED_HISTORY_ASSETS)
      .withMessage(`asset must be one of: ${ALLOWED_HISTORY_ASSETS.join(", ")}`),
  ],
  validate,
  history,
);

router.get("/export", exportCSV);

router.post(
  "/find-path",
  [
    body("source_asset").isIn(VALID_ASSETS).withMessage("Invalid source asset"),
    body("source_amount").isFloat({ gt: 0 }).withMessage("source_amount must be greater than 0"),
    body("destination_asset").isIn(VALID_ASSETS).withMessage("Invalid destination asset"),
    body("recipient_address")
      .notEmpty()
      .custom((value) => {
        if (!StellarSdk.StrKey.isValidEd25519PublicKey(value)) {
          throw new Error("Invalid Stellar wallet address");
        }
        return true;
      }),
  ],
  validate,
  findPath,
);

router.post(
  "/send-path",
  [
    body("recipient_address")
      .notEmpty()
      .custom((value) => {
        if (!StellarSdk.StrKey.isValidEd25519PublicKey(value)) {
          throw new Error("Invalid Stellar wallet address");
        }
        return true;
      }),
    body("source_asset").isIn(VALID_ASSETS).withMessage("Invalid source asset"),
    body("source_amount").isFloat({ gt: 0 }).withMessage("source_amount must be greater than 0"),
    body("destination_asset").isIn(VALID_ASSETS).withMessage("Invalid destination asset"),
    body("destination_min_amount")
      .isFloat({ gt: 0 })
      .withMessage("destination_min_amount must be greater than 0"),
    body("path").optional().isArray(),
  ],
  validate,
  idempotency,
  sendPath,
);

module.exports = router;
