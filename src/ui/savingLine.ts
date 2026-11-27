// "Saving bookmark…": the small in-process line shown while a shelf write is in flight (next to the bookmark of an open post, in the reader's status line, in the Daily's status line).
// The dots are three spans that blink one after the other (CSS); with prefers-reduced-motion they stay still. Text only (createSpan), never HTML. The line is replaced by the result line ("Saved for later.").
export const SAVING_LABEL = "Saving bookmark…";

/** Draw the line into `parent` and return it. The words are one phrase for a screen reader (role status); the dots are decoration. */
export function drawSaving(parent: HTMLElement): HTMLElement {
  const line = parent.createSpan({ cls: "blyg-saving", attr: { role: "status", "aria-label": SAVING_LABEL } });
  line.createSpan({ cls: "blyg-saving-word", text: "Saving", attr: { "aria-hidden": "true" } });
  line.createSpan({ cls: "blyg-saving-obj", text: " bookmark", attr: { "aria-hidden": "true" } });
  const dots = line.createSpan({ cls: "blyg-saving-dots", attr: { "aria-hidden": "true" } });
  for (let i = 0; i < 3; i++) dots.createSpan({ cls: "blyg-saving-dot", text: "." });
  return line;
}
