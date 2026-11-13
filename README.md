# Inventory Tracker

Donation inventory for an overdose prevention society in Vancouver's Downtown Eastside. Tracks what was donated, where
it is stored, what is held for whom, and what was given out.

It works with no signal. The app holds a full copy on the device and syncs when a connection comes back.

## Status

Being refocused. This started as a copy of [Gear Tracker](https://github.com/varju/10th-richmond-gear-tracker), a gear
inventory for a Scout group, and the code still behaves like one. [docs/requirements/](docs/requirements/README.md) says
what the society needs and what is still undecided. The rest of the documentation describes the Scout version until each
part is rewritten.

## Documentation

| File                                                                                                 | What it holds                     |
| ---------------------------------------------------------------------------------------------------- | --------------------------------- |
| [docs/architecture.md](docs/architecture.md)                                                         | How it is built, and why          |
| [docs/requirements/](docs/requirements/README.md)                                                    | Context, people, scale, locations |
| [docs/requirements/functional-requirements.md](docs/requirements/functional-requirements.md)         | What it must do (FR-\*)           |
| [docs/requirements/non-functional-requirements.md](docs/requirements/non-functional-requirements.md) | How well (NFR-\*)                 |
| [docs/stories/](docs/stories/README.md)                                                              | What a day of use looks like      |
| [docs/tasks.md](docs/tasks.md)                                                                       | The build, in order               |
| [docs/deploy.md](docs/deploy.md)                                                                     | Running your own copy             |

## Getting started

Needs Python 3.14 or newer, and Node 26 or newer for the client. One command sets up everything else, including `uv` if
you do not have it:

```sh
./bin/setup
```

Then:

```sh
make check     # lint, then the server and client tests
make e2e       # browser tests: real server, real browser, built client
make migrate   # bring a database up to date (DB=path/to.db)
make serve     # the API with the built client in front of it
```

To work on the client with live reload, run the API with `uv run gear-serve --db gear.db` and `npm run dev` in
`client/`. Vite forwards API calls to the server.

## Running your own copy

One container on a machine at home, with the database as a file beside it. See [docs/deploy.md](docs/deploy.md).

## Licence

MIT. See [LICENSE](LICENSE). Gear Tracker's copyright notice stays in it.
