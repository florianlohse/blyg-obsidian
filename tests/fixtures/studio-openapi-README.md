`studio-openapi-0.48.2.json` is the unmodified `blygger-openapi-0.48.2.json` release asset of Blygger Studio 0.48.2
(https://github.com/blygger/blygger-studio, MIT License, Copyright (c) 2026 Venkatesh Rao). `tests/studio/openapi.test.ts` checks the
plugin's hand-written Studio client against it. When the plugin is tested against a newer Studio, add that release's file here and
point the test at it.

`studio-openapi-0.49.1.json` is the unmodified `blygger-openapi-0.49.1.json` release asset of Studio 0.49.1 (same source and licence; its
SHA256SUMS line is checked by `tests/studio/openapi-0.49.test.ts`). It is not the base of the client tests: that test shows every endpoint the
client calls is unchanged since 0.48.2, so the 0.48.2 checks carry over.

`studio-openapi-0.51.0.json` is the unmodified `blygger-openapi-0.51.0.json` release asset of Studio 0.51.0 (contract 5.2.0; same source and
licence; SHA-256 `271fdc1b…` from the release's `SHA256SUMS`, checked by `tests/studio/api-types.test.ts`). It is the base of the client since S16:
`src/studio/api-types.ts` is generated from it (`npm run gen:studio-types`). `studio/contract5-observed.json` holds answers recorded from a real local
0.51.0 (see `docs/architecture/spikes/s16/`).

`studio-openapi-0.69.0.json` is the unmodified `blygger-openapi-0.69.0.json` release asset of Studio 0.69.0 (contract 6.2.0; same source and licence; SHA-256
`b5d8e504…` from the release's `SHA256SUMS`, checked by `tests/studio/operations.test.ts`). Since E1 the plugin speaks contract 5 and 6 side by side: the
0.51.0 file stays as the contract-5 base, this one is the contract-6 base. `src/studio/api-types-contract6.ts` is generated from it (`npm run gen:studio-types`
writes both mirrors), `tests/studio/operations.test.ts` runs the client against each file, and `tests/studio/contract-compat.test.ts` checks that every operation
the client calls differs between the two by additions only (the one removal, `GET /changes`, is named there).
