# Inventory Tracker requirements

Donation inventory for an overdose prevention society in Vancouver's Downtown Eastside.

The society collects donated goods, stores them, holds them for clients and support workers, and gives them out.

## Where this came from

This is an independent project that started as a copy of
[Gear Tracker](https://github.com/varju/10th-richmond-gear-tracker), a gear inventory for a Scout group. Intake is the
same job: a wide variety of things arrive and each needs a name, a place, and a label. What happens after is not. Scout
gear is lent and comes back. Donations leave for good.

The functional requirements, non-functional requirements and stories still describe the Scout version, apart from roles
(FR-USR-36 on), holds (section 12), visibility (section 13), handing out (section 14) and intake (section 15), which are
written for the society. Handing out and intake are built. Holds are built for Staff and Administrators: Outreach
requests, approval and delivery are not (FR-HLD-05 to 07, 14, 15, 21 to 25). The public catalogue is built (FR-VIS-04 to
07, 15 to 23). Outreach accounts are not, so the Outreach mark does nothing yet (FR-VIS-02, 03, 09 to 12). Roles are not
built yet. Until a section is rewritten, read it as what the code does today, not what the society needs.

## Documents

| Document                                                         | Purpose         |
| ---------------------------------------------------------------- | --------------- |
| [functional-requirements.md](functional-requirements.md)         | What it must do |
| [non-functional-requirements.md](non-functional-requirements.md) | How well        |

## What it does

| Step       | What happens                                                               |
| ---------- | -------------------------------------------------------------------------- |
| Intake     | A donation arrives. Each thing, or each stack of things, is recorded.      |
| Storage    | It goes on a shelf. The system knows which one.                            |
| Hold       | Some of it is set aside for a named client or support worker.              |
| Distribute | It is handed over and leaves the inventory. Nothing is expected to return. |

## People

Three roles sign in.

| Role          | Who                                | Can                                                                                                                 |
| ------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Administrator | The society                        | Everything, including approving Outreach requests, users and settings                                               |
| Staff         | The society                        | Record donations, place holds, put held goods back into general stock, hand goods out                               |
| Outreach      | A worker from another organization | Request a hold, which an Administrator must approve. Book how approved goods are collected: in person, or delivered |

Two kinds of people never sign in.

| Person | Does                                                      |
| ------ | --------------------------------------------------------- |
| Client | Receives goods. No account, and no record beyond a handle |
| Donor  | Gives goods. No account                                   |

## Decisions

**Clients are not identified.** A hold says who it is for with a handle or initials typed by whoever places it. There
are no client accounts and no client fields. The handle is removed once the goods are handed out or the hold has ended.

**Nobody gets goods without contact with the society's staff.** The public catalogue shows what may be available and how
to get in touch. It takes no requests.

**Items are shown outside the society only when marked.** Each item is Staff only, Outreach, or Public. Outreach workers
see what is marked for them; the public catalogue shows what is marked Public.

**Every hold has an end date.** It is set when the hold is made and can be moved later. A hold that runs out goes back
into general stock, and everyone involved is told.

**Only an Administrator approves an Outreach request,** for now.

**Staff are trusted.** A hold placed by Staff needs no approval.

**The system never contacts a client.** It has no way to. Staff or the Outreach worker pass news on.

**A delivery is a time and a drop-off point.** No address book, no recipient details. Staff make deliveries.

**Anyone on a hold can move its end date.** Staff and Administrators can move any hold's. An Outreach worker can move
their own with no new approval; Administrators are told.

**Anyone named on a hold hears when it changes.** That is whoever placed or requested it, whoever approved it, and the
Staff member delivering it. They are told when it expires, when its end date moves, and when its goods are put back.

**Outreach sees what is available, once an item is marked for them:** its location and how many can be requested. Goods
on someone else's hold are simply not there.

**The found-item pages stay for now** (section 7). They are expected to turn into a page saying where an item came from
and how to ask the society for things like it.

**A donation's source is optional.** Intake can record where a donation came from, and never requires it.

**Offline first.** Recording, searching and handing out work with no network.

**No iPhone app for now.** The web app is the only client. The iPhone app inherited from Gear Tracker is on hold.

**No procurement for now.** Buying stock may come later. Nothing is designed for it yet.

**No repairs, weights or cleaning.** Repair tickets (section 6), weighing and refilling (FR-INV-62 on), and sending gear
home for cleaning (FR-OUT-46 on) are dropped. Each requirement moves to Won't in the change that removes its code.

**No calendars for now.** Calendar feeds (FR-RES-20) are not used in the first version. A calendar of holds and
deliveries is wanted later.

## Open questions

- Does Public include Outreach, or can an item be Public and hidden from Outreach? Assumed for now: Public includes
  Outreach. To confirm with the society.
- Does the public catalogue show how many are available? No for now (FR-VIS-05).
- Should the public catalogue list an item when none is free to give? No for now (FR-VIS-15).
- Does Outreach still see an item when none is available (FR-VIS-12)? Assumed: no.
- Is a delivery taken by one named Staff member (FR-HLD-25)? Assumed, so that there is someone to tell.
- May a source name a person who donated? It is written to the permanent log, so it could not be erased later.
- How many people hold each role?
- Where are goods stored, and how is that space divided?
- How many items and stacks are on hand, and how much moves in a day?
- What do a donation drop-off and a pickup look like, step by step? Not known yet; to learn from the society.

## Conventions

Priorities are MoSCoW: **Must**, **Should**, **Could**, **Won't** (this release).

IDs are `FR-<area>-<nn>` and `NFR-<area>-<nn>`, and are stable. Mark dropped requirements withdrawn. Never reuse a
number.
