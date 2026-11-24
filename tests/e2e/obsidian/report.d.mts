export interface Attempt { attempt: number; code: number; failures: string[]; seconds: number }
export interface Row { name: string; attempts: Attempt[] }
export interface Failed { scenario: string; attempt: number; check: string }
export function escapeAnnotation(s: string): string;
export function failedChecks(rows: Row[]): Failed[];
export function failedChecksBlock(list: Failed[]): string;
export function flakyNotes(rows: Row[]): { scenario: string; text: string }[];
export function summaryMarkdown(rows: Row[]): string;
