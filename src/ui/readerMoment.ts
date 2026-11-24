// The short moment between two posts (moved out of ReaderView.ts, unchanged in behaviour): the text fades, a centred "Marked read" appears and goes again. (Reduced motion: no waiting.)

export async function markedMoment(body: HTMLElement | null, wasUnread: boolean): Promise<void> {
  const reduce = activeWindow.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!body || reduce) return;
  const pause = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));
  body.addClass("is-leaving");
  const note = wasUnread ? body.createDiv({ cls: "blyg-reader-done", text: "✓ Marked read" }) : null;
  await pause(30);
  note?.addClass("is-in");
  await pause(wasUnread ? 520 : 200);
  note?.removeClass("is-in");
  await pause(wasUnread ? 220 : 0);
  note?.remove();
  body.removeClass("is-leaving");
}
