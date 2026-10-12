/**
 * The reader's version, on its own so that asking "is this invoice stale?" does
 * not drag in the readers themselves.
 *
 * Bumped whenever the reader learns to read something it used to miss — a new
 * catalogue field, a new label, a fixed misreading. A stored invoice keeps the
 * values captured on the day it was imported, so without this an improvement
 * would only ever reach invoices uploaded afterwards. The original file is kept
 * with every invoice precisely so that does not have to be true.
 *
 *  1 — first release
 *  2 — the notify-party block gained its own country and contact fields; before
 *      this, a notify phone / email was read and then discarded
 */
export const EXTRACTION_VERSION = 2;
