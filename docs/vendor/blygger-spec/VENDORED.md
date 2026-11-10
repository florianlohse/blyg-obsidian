# Vendored: Blygger spec

Copied so that cloud sessions with limited web access have the normative text at hand.
**Do not edit these files.** To refresh, re-copy from upstream and update the commit below.
The same four files, byte-identical, are vendored in the plugin's repository and in the maintainer's site repository (`diff -r` between the two folders must be empty).

| File | Upstream | sha256 |
|---|---|---|
| `protocol-v0.3.md` | `blygger/blygger-spec` `docs/protocol-v0.3.md` (the wire the site serves; revised upstream up to its eleventh revision) | `5bd47ddbf495993b4a954f84ca235c75437d5f8f53111b52eb6a0d80de449dd6` |
| `protocol-v0.4.md` | `blygger/blygger-spec` `docs/protocol-v0.4.md` (what Studio 0.47+ speaks: the bracket label §10.1, links disclosed §10.3a, the `link` mention relation §15.5; since the ninth revision also hopper feeds and the `hoppers` manifest key §6.1/§13.5, the fixed `{origin}blyg.json` at every identity origin §12.1 step 4, and the ruled-but-unbuilt origin succession `moved_from` §16.13) | `0d0101440c6e6f04ce11dcd73d178466fb286da49d63d4940f8485920393b40d` |
| `css-contract.md` | `blygger/blygger-spec` `docs/css-contract.md` | `062a672bc10fedd9545b60f5fcc18439e5d0691e8e58840fa96609c9fd3d556c` |
| `LICENSE` | `blygger/blygger-spec` `LICENSE` (MIT, Venkatesh Rao) | `214d94148e00a368af0ca7bb392e0f4bc9074f31627698b567135e9f34f6a6c5` |

- Upstream commit: `30a64ed10febce7a5f6f55bdb3cc4021a389a020` (2026-11-03; `protocol-v0.4.md`, ninth revision, 2967 lines)
- Copied: 2026-11-04 (plan E7, plugin half, in the plugin's planning repository; the site repository's copy is **not yet updated**, so the two folders differ until E7's site half is done). Earlier: `protocol-v0.4.md` at `443f88ad0c5ea2a4d4e143c6641d02e3e18f7c3a` (2026-10-20, sha256 `ae818bf9…`, copied 2026-10-23, plan E5). Before that: `protocol-v0.3.md` at `fae1bf615f6f1032f13d18389fa00a102856451f` (2026-10-05, copied 2026-10-06; sha256 `37b2e43786734170…`); `css-contract.md` and `LICENSE` had not changed upstream.
- **The site's wire stays 0.3** (`BLYG_VERSION = "0.3"`): every 0.3 document is a valid 0.4 document (0.4 intro). Read 0.4 for what Studio and the plugin do; read 0.3 for what the site must serve.
- Refresh: `GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 https://github.com/blygger/blygger-spec /tmp/blygger-spec`
  (public; works through the cloud session's git proxy without attaching), then copy the four files into **both** repos.

The spec is a pre-1.0 draft. Check upstream `docs/protocol-v0.3.md` §16–§17 (ruled and deferred constructs,
revision history) and the same sections of `protocol-v0.4.md` before building anything that depends on a construct marked "next revision".
