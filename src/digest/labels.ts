// The user-facing names of the digest's own headings, in one place so a rename is one edit. The lead block (the biggest stories) is "Top stories".
// Records written before the rename hold the old name ("Front page"): it is mapped to the current label when READ (sectionLabel); a stored record is never rewritten.
export const TOP_STORIES = "Top stories";
/** What the lead block was called before DG11. Only for reading old records and old chips. */
export const LEGACY_FRONT_PAGE = "Front page";
export const MIXED_BAG = "Mixed bag";

/** The heading a stored section name is shown under now. */
export const sectionLabel = (name: string): string => (name === LEGACY_FRONT_PAGE ? TOP_STORIES : name);
