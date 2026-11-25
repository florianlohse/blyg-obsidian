// What the reader's own button drawing (ReaderView.button) does with its options, kept out of ReaderView.ts (its size is capped). `icon` is a glyph of Obsidian's own set drawn in the button;
// `label` is what a screen reader says when the button has no words (a glyph button); `pressed` says a toggle's state.
export interface ButtonOpts {
  active?: boolean;
  disabled?: boolean;
  title?: string;
  cls?: string;
  icon?: string;
  label?: string;
  pressed?: boolean;
}

export function styleButton(b: HTMLButtonElement, o: ButtonOpts, addIcon: (el: HTMLElement, name: string) => void): void {
  if (o.active) b.addClass("is-active");
  b.disabled = o.disabled === true;
  if (o.icon) addIcon(b, o.icon);
  if (o.label) b.setAttr("aria-label", o.label);
  if (o.pressed !== undefined) b.setAttr("aria-pressed", String(o.pressed));
}
