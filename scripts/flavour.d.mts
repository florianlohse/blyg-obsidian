export declare const FLAVOURS: string[];
export declare function manifestFor<T extends { id: string; name: string }>(manifest: T, flavour: string): T;
export declare function versionKind(version: string): "stable" | "dev" | "invalid";
export declare function nextDevVersion(base: string, existingTags: string[]): string;
export function compareReleaseTags(a: string, b: string): number | null;
export function normalReleasesAbove(version: string, releases: { tagName: string; isPrerelease: boolean }[]): string[];
