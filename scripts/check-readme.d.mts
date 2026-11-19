export interface ReadmeProblem { line: number; message: string }
export function htmlProblems(text: string): ReadmeProblem[];
export function readmeProblems(readme: string, exists: (path: string) => boolean): ReadmeProblem[];
export function changelogProblems(text: string): ReadmeProblem[];
