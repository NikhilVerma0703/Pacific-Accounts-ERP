/**
 * The fields of one line item, and how each is read.
 *
 * In `lib` rather than beside the save path in `server/lineItems.ts` because the
 * editor is a client component and the save path is server-only: a client
 * component importing the server module pulls Prisma into the browser bundle,
 * and `server-only` fails the build rather than letting that happen quietly.
 *
 * Both sides import this one list, so the form renders exactly the fields the
 * action reads back. Adding a field here puts it on the form and saves it,
 * without either file being touched.
 */
export const LINE_ITEM_FIELDS = [
  ["description", "Description", "text"],
  ["designColour", "Design / colour", "text"],
  ["thickness", "Thickness", "text"],
  ["hsn", "HSN", "text"],
  ["quantity", "Quantity", "number"],
  ["unit", "Unit", "text"],
  ["rate", "Rate", "number"],
  ["amount", "Amount", "number"],
  ["slabsPcs", "Slabs / pcs", "number"],
  ["netWeight", "Net weight", "number"],
  ["netWeightUnit", "Weight unit", "text"],
  ["marksNos", "Marks & nos.", "text"],
  ["packages", "Packages", "text"],
] as const;

export type LineItemField = (typeof LINE_ITEM_FIELDS)[number][0];

/** The ones parsed as numbers rather than kept as text. */
export const LINE_ITEM_NUMERIC: ReadonlySet<string> = new Set(
  LINE_ITEM_FIELDS.filter(([, , kind]) => kind === "number").map(([key]) => key),
);
