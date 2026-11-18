// S15: how the TEXT view looks: the reading surface's contrast. (The web page view is never changed by a setting.)
export type ReaderContrast = "reduced" | "normal" | "high";
export const CONTRASTS: ReaderContrast[] = ["reduced", "normal", "high"];
export const CONTRAST_LABELS: Record<ReaderContrast, string> = { reduced: "Reduced contrast", normal: "Normal contrast", high: "High contrast" };
export const isReaderContrast = (v: unknown): v is ReaderContrast => v === "reduced" || v === "normal" || v === "high";
