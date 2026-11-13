# Inventory Tracker

Donation inventory for an overdose prevention society in Vancouver's Downtown Eastside. Tracks what was donated, where
it is stored, what is held for whom, and what was given out.

**Status: being refocused.** The code is a copy of Gear Tracker, a Scout group's gear inventory, and still behaves like
one. `docs/requirements/README.md` says what the society needs and what is still undecided. The other requirements, the
stories, the architecture and `docs/tasks.md` describe the Scout version until each is rewritten.

**Independent project.** It started as a fork of `varju/10th-richmond-gear-tracker` and no longer follows it. Never open
a pull request against that repository from here, and do not merge from it.

## Read first

| File                                               | What it holds                     |
| -------------------------------------------------- | --------------------------------- |
| `docs/architecture.md`                             | How it is built, and why          |
| `docs/tasks.md`                                    | What is next                      |
| `docs/deploy.md`                                   | Running your own copy             |
| `docs/stories/README.md`                           | What a day of use looks like      |
| `docs/requirements/README.md`                      | Context, people, scale, locations |
| `docs/requirements/functional-requirements.md`     | What the system must do (FR-\*)   |
| `docs/requirements/non-functional-requirements.md` | How well it must do it (NFR-\*)   |

## Constraints that shape every decision

**Offline first.** Search, intake, and handing goods out must work with no network. Never propose a design that assumes
a live server during use.

**Clients are not identified.** A hold names who it is for with a handle or initials that staff type. No client
accounts, no client fields, and a hold is purged once it is picked up or has expired. Never propose a design that stores
more about a client.

**Goods leave for good.** Gear Tracker lends and expects a return. Here a donation comes in, may be held, and is given
out. Do not build on check-in, overdue, or return when adding features.

**Volunteers maintain this.** Boring, widely known technology. Whoever inherits the code in three years did not write
it.

**Speed beats features.** This competes with taking something off the shelf and handing it over. Slower than that, and
people skip the app and the data goes wrong.

**Event log, not status field.** Movements are append-only; status is derived. That is what makes offline merges safe
(NFR-DATA-02).

**The assistant can do what the app does.** A new capability gets an MCP tool in `assistant.py` in the same change, or a
Won't row in the FR-MCP section saying why it is left out.

## Writing requirements

- Each section is sorted by descending priority: Must, Should, Could, Won't. IDs run linearly from 01 within a section.
- IDs are stable from the September 2026 renumber onward. Never reuse a number. A dropped requirement stays in place,
  moves to Won't, and says what replaced it.
- A new requirement goes at the end of its priority band and takes the next free number. Do not renumber to keep the
  sort perfect; resort only when asked.
- Priorities are MoSCoW: Must, Should, Could, Won't.
- One requirement per row. Testable. No compound "and also".
- No trailing rationale. Explain why only when the reason constrains the build or stops a withdrawn idea coming back.

## iPhone app

On hold. The web app is the only client. Leave `ios/` and `docs/pending-ios.md` as they are: do not build, release, or
update them, and do not add to the pending list.

## Tasks

`docs/tasks.md` is a shrinking list, not a changelog. Delete a task when its work is committed. Git is the record of
what was done.

## Testing

Real dependencies, no mocks. Database code runs against real SQLite — a migrated file per test, never `:memory:`,
because in-memory databases ignore the WAL setting we ship. Pure logic is tested without a database. Client tests run
against a real IndexedDB implementation and a fake `fetch`; browser tests (`make e2e`) run the built client against the
real server. See [architecture.md](docs/architecture.md#testing) for the layers and what each costs.

Replay exists in Python and TypeScript. A change to either means changing `vectors/replay/` too.

## Formatting

Pre-configured hooks format files automatically on write. Do not hand-align markdown tables, wrap lines to a column, or
otherwise tidy whitespace — the hooks do it. Never reformat a file just to fix layout.

This covers layout only. The House style rules above are about what you write, and still apply.

## Git

- Never `--no-verify`, never `commit --amend`, never `reset --hard`.
- Prefer `git grep` and `git ls-files` over `find`.
- Pull requests are created as drafts.
