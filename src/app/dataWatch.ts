// The panel follows the plugin's settings file (data.json): Obsidian Sync can bring in a changed copy in the background (a record of a
// publish made on the other device), and the panel only knew about it after the note was closed and opened again. Its record is already
// read fresh from disk whenever the panel is drawn; what was missing is the moment to draw.
//
// Not Obsidian's low-level "raw" file event: it is undocumented, and whether Sync's writes raise it on iOS was never verified. A look at the
// file's modified time while the panel is on screen, plus a redraw whenever the app returns to the foreground, needs only documented calls.
export interface DataWatch {
  /** Look once. Redraws the panel when the file changed since the last look; does nothing while the panel is not on screen. */
  look(): Promise<void>;
  /** The app came back to the foreground: redraw, whatever happened meanwhile. */
  returned(): void;
}

export function createDataWatch(deps: {
  /** The file's modified time in ms, or null when it does not exist or cannot be read. */
  modified(): Promise<number | null>;
  panelVisible(): boolean;
  redraw(): void;
}): DataWatch {
  let seen: number | null | undefined;
  return {
    async look() {
      if (!deps.panelVisible()) return;
      let now: number | null;
      try {
        now = await deps.modified();
      } catch {
        return; // a failed look says nothing about the file
      }
      const changed = seen !== undefined && now !== seen;
      seen = now;
      if (changed) deps.redraw();
    },
    returned() {
      deps.redraw();
    },
  };
}
