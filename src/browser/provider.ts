import type { BrowserOptions, BrowserPageSnapshot, NormalizedTarget } from "../core/types.js";

export type BrowserProvider = {
  name: string;
  snapshotPage(input: {
    target: NormalizedTarget;
    snapshotAt: string;
    options: BrowserOptions;
  }): Promise<BrowserPageSnapshot>;
};
