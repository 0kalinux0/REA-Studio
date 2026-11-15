# What REA provides, and what the studio adds

This records the inspection of [morluto/rea](https://github.com/morluto/rea) (version 6.9.0,
npm package `rea-agents`) that the studio's design is based on. Statements are marked:

- **Verified** — confirmed by running REA 6.9.0 during development.
- **Documented** — stated in REA's README or docs, not exercised here.
- **Assumption** — a design judgement, not something REA states.

## What REA is

**Verified.** REA is a command-line tool and MCP server (196 CLI commands, 255 MCP tools in
6.9.0) that returns *Evidence*: JSON records with an evidence id, the operation that produced
them, a confidence value and an explicit list of limitations. It is built to be driven by a
coding agent or a terminal. It has **no graphical interface, no project storage, no feature
selection, no code generation and no preview** — those are what this repository adds.

REA's `DISCLAIMER.md` excludes copying proprietary software or reproducing its protected code
and assets. The studio is designed around that: it works from an inventory of structure and
behaviour and generates original code.

## Capabilities the studio uses

| REA command | What it returned in testing | Status |
| --- | --- | --- |
| `list-browser-targets` | Page targets on a loopback Chrome DevTools endpoint | Verified |
| `inspect-web-page` | DOM node tree (tag and attribute *names* only), accessibility tree with roles and names, script inventory, storage key names, completeness report | Verified |
| `analyze-web-bundle` | Static analysis of loaded scripts: route candidates, literal endpoints, chunk graph, and separately-labelled low-confidence inferences | Verified |
| `capture-web-screenshot` | Visible-viewport PNG, content-addressed | Verified |
| `inspect-desktop-application` | Directory inventory and runtime-family candidates (Electron, .NET, Unity, Godot, GameMaker, Unreal) | Verified on an Electron-style fixture; other families Documented |
| `analyze-javascript-application` | Electron main/preload/renderer entry points, BrowserWindow constructions, IPC channels and handlers, contextBridge APIs, modules, routes | Verified |
| `doctor` | Installation health and which native analysis engines are configured | Verified |

## Limits found while testing

All **Verified** unless noted.

- **REA does not launch or drive a browser for passive inspection.** It attaches to one that is
  already running with a debugging port. The studio starts and owns a dedicated browser profile
  for this.
- **No CSS.** `inspect-web-page` does not report computed styles, attribute values or text
  nodes (only their lengths). Fonts, colour roles, corner radius and layout geometry therefore
  come from the studio's own read-only style probe and are labelled *Probed*, never *Verified*.
  The colour palette is computed from REA's screenshot and labelled *Derived*.
- **Attach-limited network view.** REA only sees requests made while it is attached, and never
  retains headers or bodies. Reloading the page during an inspection makes `inspect-web-page`
  fail ("target changed during observation"), and `observe-web-session` records navigation
  events rather than a request inventory. The studio therefore lists endpoints from static script
  analysis only and says so on every web reference.
- **One page state.** A capture is the page as it was at that moment: closed dialogs, other
  routes, hover states and anything behind sign-in are absent. A closed `<dialog>` shows up only
  as a tag count.
- **Existence, not behaviour.** REA shows that a button labelled "New order" exists; it does not
  show what clicking it does. The plan records each such case as an assumption.
- **Static desktop analysis.** `analyze-javascript-application` never runs the app. IPC channel
  names are observed; what each does is implied only by its name, and no visual design is
  available.

## Targets and how far the studio takes them

| Target | Studio support | Why |
| --- | --- | --- |
| Website / web app (http, https) | Full, automatic | Commands above |
| Electron or JavaScript app folder, `.asar` | Full, automatic (static) | `analyze-javascript-application` |
| Installed desktop app folder | Runtime family + file inventory; full if it contains an Electron/JS app | `inspect-desktop-application` |
| Native binary, installer (`.exe`, `.dll`, `.so`, Mach-O, `.dmg`, …) | Not supported | REA can decompile with Hopper, Ghidra, IDA or Kuna (Documented; none installed here), but decompiled code is not a description of a user interface. **Assumption:** turning it into a feature inventory automatically would produce guesses presented as findings, so the studio declines and offers a manual reference instead. |
| Android APK / device | Not supported | Needs caller-supplied JADX, Apktool or adb (Documented). Not integrated. |
| .NET assemblies, firmware, packet captures, WASM, model files and REA's other static formats | Not supported | Documented REA capabilities that do not describe a user interface. |
| Anything, by description | Manual reference | Labelled *Described*; nothing verified. |

## REA capabilities not yet used

**Documented**, not integrated:

- `capture-browser-scenario` (Playwright-driven multi-step scenarios) and
  `compare-web-captures` — could capture workflows across several steps instead of one page state.
- `inspect-web-event-listeners` — could show which controls have handlers attached.
- `observe-native-ui` / `capture-native-ui-scenario` (macOS) and `capture-desktop-application`
  — runtime observation of desktop apps.
- `inspect-web-network-capture` — reading HAR/SAZ captures for request and response shapes.
- `compare-web-screenshots` — pixel comparison between a reference and the generated app.

## What the studio adds on top of REA

- A GUI and saved projects with version history.
- Launching and owning the analysis browser.
- Turning Evidence into a selectable inventory with provenance labels and per-reference gaps.
- Include / change / exclude selection across multiple references, and plain-language direction.
- A reviewable plan that must be approved before building.
- Two build engines (Claude; offline scaffold), a sandboxed live preview, plain-language
  change requests, and restore.
- An automated check of every version: runtime errors, every page opened, planned labels found on
  screen, plus an REA inspection and screenshot of the generated app itself.
- Export as a runnable zip with `README.md` and `PROVENANCE.md`.

## What was and was not verified about the studio itself

- **Verified** by the automated tests in `test/`: the whole pipeline with the offline engine
  against two fixture websites and a fixture Electron app, using real REA and a real browser;
  the Claude engine's request shape, streaming and file handling against a local stand-in for
  the API.
- **Not verified:** the Claude engine against the live Anthropic API (no key was available
  during development), analysis of public internet sites (the development sandbox blocked
  outbound browsing), and Windows/macOS behaviour (developed and tested on Linux).
