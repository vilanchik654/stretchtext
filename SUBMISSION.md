# App submission — ready-to-paste form values

Quest: **#17998** — [A browser extension that turns any web page into stretchtext](https://github.com/pollinations/pollinations/issues/17998)

Open <https://github.com/pollinations/pollinations/issues/new?template=app-submission.yml> and fill it with the values below. Fields are listed in form order.

| Field | Value |
| --- | --- |
| **App Name** | StretchText |
| **App Description** | Select any text on any page and stretch it: a short version appears in place, and dotted phrases grow the cut detail back where you click. Readers sign in with their own Pollen. |
| **App URL** | https://vilanchik654.github.io/stretchtext/docs/ |
| **GitHub Repository URL** | https://github.com/vilanchik654/stretchtext |
| **Screenshot** | `docs/screenshot.png` (1600×900) |
| **App Category** | `writing` |
| **Platform** | `browser-ext` |
| **App Language** | `en` |
| **Quest** | `#17998` |

The description above is 197 characters, under the 200 limit.

## What to say in the quest thread

> Submitted **StretchText** for quest #17998 — install page https://vilanchik654.github.io/stretchtext/docs/, source https://github.com/vilanchik654/stretchtext.
>
> Manifest V3 for Chrome / Brave / Edge. Select a paragraph, press `Alt+S`: it is replaced in place by a
> kernel of about a sixth of its length, with two or three dotted phrases. Clicking one streams the
> dropped detail back *after that phrase*; `−` shrinks it, `↺` restores the original nodes byte for byte.
> Selection is bracketed by marker spans and dimmed with `::highlight` until the first token arrives, so
> nothing is destroyed if the request fails or you cancel.
>
> BYOP device flow in the popup (`/api/device/code` → `/api/device/token`), key kept in
> `chrome.storage.session`, every request billed to the reader, no backend and no app secret. Kernels and
> expansions are cached per session, so shrinking and re-growing costs nothing.
>
> `node test/core.test.mjs` → 24/24, `node test/e2e.mjs` → 21 checks in real Chrome against a local
> mock API (selection, streamed markers, expansion, shrink, byte-identical restore, popup state,
> request headers). Nothing is spent to verify it.

## After approval

Claim the reward at <https://enter.pollinations.ai/quests>.

## Notes for the maintainer

- The extension ships no app key. `pk_…` can be pasted into the popup's settings to attribute traffic;
  without it the device flow still works and the reader still pays.
- The repo has no build step: `manifest.json` + `src/` is the extension.
- Screenshot was produced by `test/e2e.mjs` from the real extension UI, not a mockup.

