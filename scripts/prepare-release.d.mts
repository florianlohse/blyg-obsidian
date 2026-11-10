export function mergedSince<T extends { merged_at?: string | null; merge_commit_sha?: string | null; title: string }>(prs: T[], commitsSince: string[]): T[];
export function lastReleaseCommit(prs: { merged_at?: string | null; merge_commit_sha?: string | null; title: string }[]): string | undefined;
