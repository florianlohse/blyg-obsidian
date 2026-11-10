export interface PrInput { number: number; title: string; html_url?: string; body?: string | null }
export interface ClassifiedPr { number: number; title: string; url: string; declared: boolean; note: string | null; steps: string | null }
export interface Release { items: ClassifiedPr[]; notesBody: string; changelogSection: string; scopeLines: string[]; deviceSteps: string[]; undeclared: ClassifiedPr[] }
export function bumpVersion(current: string, kind: "patch" | "minor" | "major"): string;
export function classifyPr(pr: PrInput): ClassifiedPr;
export function buildRelease(o: { prs: PrInput[]; version: string; date: string }): Release;
export function insertChangelogSection(changelog: string, section: string): string;
export const TICKS: string[];
export function renderPrBody(o: { release: Release; version: string; previous: string; bump: string; minAppVersion: string }): string;
export function unticked(body: string): string[];
