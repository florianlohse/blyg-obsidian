export interface Target {
  contract: number;
  spec: string;
  out: string;
}
export const TARGETS: readonly [Target, Target];
/** Contract 5 (the 0.51.0 file), kept under the old names. */
export const SPEC: string;
export const OUT: string;
export const HEADER: string;
export function header(spec: string): string;
export function generate(target?: Target): Promise<string>;
