/** Runtime configuration. Only identity and toggles — never business values. */

export const APP_NAME = "Accounts Automation";
export const APP_OWNER = "Pacific Surfaces";
export const APP_PHASE = "Phase 1 — Commercial Invoice Extraction";

/** Home currency for conversion and reporting. */
export const HOME_CURRENCY = (process.env.HOME_CURRENCY ?? "INR").trim().toUpperCase();

/** Home country — used only to tell Export from Domestic. */
export const HOME_COUNTRY = (process.env.HOME_COUNTRY ?? "INDIA").trim().toUpperCase();

/**
 * Register-wide jobs (recalculate after a rule change, re-extract everything).
 *
 * false — run them inline in the request. Nothing else to start; this is the
 *         local default and is fine for a few hundred invoices.
 * true  — hand them to Inngest (`npm run inngest:dev`).
 */
export const USE_INNGEST = process.env.USE_INNGEST === "true";

/**
 * The Commercial ERP sync endpoint (/api/commercial/sync) is off until this is
 * set. The boundary exists so the integration can be written without touching
 * the Accounts module; the switch exists so it cannot be reached before it has
 * authentication.
 */
export const COMMERCIAL_ERP_SYNC_ENABLED = process.env.COMMERCIAL_ERP_SYNC === "true";

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const DUE_SOON_DAYS = 7;
