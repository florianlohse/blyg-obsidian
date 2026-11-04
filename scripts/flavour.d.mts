export declare const FLAVOURS: string[];
export declare function manifestFor<T extends { id: string; name: string }>(manifest: T, flavour: string): T;
export declare function versionKind(version: string): "stable" | "dev" | "invalid";
export declare function nextDevVersion(base: string, existingTags: string[]): string;
