import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, test, vi } from "vitest";
import { App } from "../App";
import { createApi } from "../lib/api";
import { openDb } from "../lib/db";
import { navigate } from "../lib/router";
import { API_BASE } from "../lib/server";
import { Store } from "../lib/store";
import { localDate } from "../lib/time";
import { Outreach } from "./Outreach";

// What a worker from another organization sees, and that their device holds none of the inventory
// (FR-USR-39, FR-VIS-02, FR-VIS-03, FR-VIS-09).
const T0 = 1_756_684_800_000;
const answer = (body: object, status = 200) => new Response(JSON.stringify({ ...body, server_time: T0 }), { status });
const listing = {
  group: { name: "The Society", contact: "desk@example.org" },
  items: [
    {
      id: "socks",
      name: "Socks",
      description: "",
      categories: ["Clothing"],
      photos: [],
      locations: ["Back room"],
      available: 12,
    },
    {
      id: "coat",
      name: "Winter coat",
      description: "Warm, **size L**",
      categories: [],
      photos: [],
      locations: ["Back room", "Front desk"],
      available: 2,
    },
  ],
};

// A week from "today", wherever the test runs.
const WEEK = localDate(T0 + 7 * 86_400_000);
const user = userEvent.setup();

const waiting = {
  id: "h1",
  item: "Socks",
  count: 3,
  expires_on: "2025-09-08",
  state: "waiting",
  for: "Mouse",
  requested_at: T0,
};

interface Fake {
  calls: string[];
  sent: unknown[];
  holds: object[];
  fetch: typeof fetch;
}

/** A server that lists, takes a request, and moves a date. */
function fake(items = listing.items): Fake {
  const state: Fake = {
    calls: [],
    sent: [],
    holds: [],
    fetch: async (input, init) => {
      const path = String(input).replace(API_BASE, "");
      state.calls.push(`${init?.method ?? "GET"} ${path}`);
      if (init?.body) state.sent.push(JSON.parse(String(init.body)));
      if (path === "/outreach/items") return answer({ ...listing, items });
      if (path === "/outreach/holds" && init?.method === "POST") {
        state.holds = [waiting];
        return answer({ hold_ids: ["h1"], holds: state.holds });
      }
      if (path === "/outreach/holds/h1/expiry") {
        const { expires_on } = JSON.parse(String(init?.body)) as {
          expires_on: string;
        };
        state.holds = [{ ...waiting, expires_on }];
        return answer({ holds: state.holds });
      }
      if (path === "/outreach/holds") return answer({ holds: state.holds });
      return answer({ error: "not_found", message: path }, 404);
    },
  };
  return state;
}

function mount(fetchFake: typeof fetch, onSignOut = vi.fn()) {
  const api = createApi({
    fetch: fetchFake,
    token: () => "tok",
    now: () => T0,
  });
  render(<Outreach api={api} name="Omar" onSignOut={onSignOut} now={() => T0} />);
  return onSignOut;
}

const itemNames = () => screen.getAllByRole("heading", { level: 3 }).map((x) => x.textContent);

test("each item says how many are available and where it is kept (FR-VIS-09)", async () => {
  const server = fake();
  mount(server.fetch);
  expect(await screen.findByRole("heading", { name: "The Society" })).toBeInTheDocument();
  expect(screen.getByText("Signed in as Omar, Outreach.")).toBeInTheDocument();
  expect(itemNames()).toEqual(["Socks", "Winter coat"]);
  expect(screen.getByText("12 available · Back room")).toBeInTheDocument();
  expect(screen.getByText("2 available · Back room, Front desk")).toBeInTheDocument();
  expect(screen.getByText("size L").tagName).toBe("STRONG");
  expect(server.calls.sort()).toEqual(["GET /outreach/holds", "GET /outreach/items"]);
  // With no requests yet, there is no list of them.
  expect(screen.queryByRole("region", { name: "Your requests" })).toBeNull();
});

test("nothing available says so", async () => {
  mount(fake([]).fetch);
  expect(await screen.findByText("Nothing is available right now.")).toBeInTheDocument();
});

test("offline, the page says it needs a connection", async () => {
  mount(async () => {
    throw new TypeError("Failed to fetch");
  });
  expect(await screen.findByRole("alert")).toHaveTextContent("No connection. This page needs one.");
});

test("a session ended at the server signs the device out", async () => {
  const onSignOut = mount(async () => answer({ error: "unauthorized", message: "sign in first" }, 401));
  await waitFor(() => expect(onSignOut).toHaveBeenCalled());
});

test("a worker asks for a hold: who for, how many, until when (FR-HLD-05)", async () => {
  const server = fake();
  mount(server.fetch);
  await user.click(await screen.findByRole("button", { name: "Ask for a hold on Socks" }));
  const send = screen.getByRole("button", { name: "Send request" });
  expect(send).toBeDisabled();
  // A week from today unless they say otherwise.
  expect(screen.getByLabelText("Hold until")).toHaveValue(WEEK);
  await user.type(screen.getByLabelText("Hold for"), "  Mouse ");
  await user.clear(screen.getByLabelText("How many"));
  await user.type(screen.getByLabelText("How many"), "13");
  expect(send).toBeDisabled(); // only 12 are available
  await user.clear(screen.getByLabelText("How many"));
  await user.type(screen.getByLabelText("How many"), "3");
  await user.click(send);

  expect(await screen.findByRole("status")).toHaveTextContent(
    `Asked for 3 × Socks, until ${WEEK}. An Administrator will answer.`,
  );
  expect(server.sent).toEqual([{ item_id: "socks", count: 3, expires_on: WEEK, handle: "Mouse" }]);
  const mine = within(screen.getByRole("region", { name: "Your requests" }));
  expect(mine.getByText("3 × Socks")).toBeInTheDocument();
  expect(mine.getByText("Waiting for approval · for Mouse · until 2025-09-08")).toBeInTheDocument();
});

test("something with one available is asked for without a count", async () => {
  const server = fake([{ ...listing.items[1]!, available: 1 }]);
  mount(server.fetch);
  await user.click(
    await screen.findByRole("button", {
      name: "Ask for a hold on Winter coat",
    }),
  );
  expect(screen.queryByLabelText("How many")).toBeNull();
  await user.type(screen.getByLabelText("Hold for"), "JD");
  await user.click(screen.getByRole("button", { name: "Send request" }));
  await screen.findByRole("status");
  expect(server.sent).toEqual([{ item_id: "coat", count: 1, expires_on: WEEK, handle: "JD" }]);
});

test("a refusal from the server is shown, and the form stays", async () => {
  const server = fake();
  const refuse: typeof fetch = async (input, init) =>
    init?.method === "POST"
      ? answer({ error: "conflict", message: "only 2 available" }, 409)
      : server.fetch(input, init);
  mount(refuse);
  await user.click(await screen.findByRole("button", { name: "Ask for a hold on Socks" }));
  await user.type(screen.getByLabelText("Hold for"), "Mouse");
  await user.click(screen.getByRole("button", { name: "Send request" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("only 2 available");
  expect(screen.getByRole("button", { name: "Send request" })).toBeEnabled();
});

test("each request says how it stands, and an open one can have its day moved (FR-HLD-07, FR-HLD-21)", async () => {
  const server = fake();
  server.holds = [
    waiting,
    {
      ...waiting,
      id: "h2",
      item: "Winter coat",
      count: 1,
      state: "approved",
      for: "JD",
    },
    {
      ...waiting,
      id: "h3",
      item: "Tent",
      count: 1,
      state: "declined",
      for: null,
    },
    {
      ...waiting,
      id: "h4",
      item: "Boots",
      count: 1,
      state: "handed_out",
      for: null,
    },
  ];
  mount(server.fetch);
  const mine = within(await screen.findByRole("region", { name: "Your requests" }));
  expect(mine.getByText("Approved · for JD · until 2025-09-08")).toBeInTheDocument();
  expect(mine.getByText("Declined · was until 2025-09-08")).toBeInTheDocument();
  expect(mine.getByText("Handed out · was until 2025-09-08")).toBeInTheDocument();
  // Only the two still open can be moved.
  expect(mine.getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
    "Change the date for Socks",
    "Change the date for Winter coat",
  ]);

  await user.click(mine.getByRole("button", { name: "Change the date for Socks" }));
  const day = mine.getByLabelText("Hold until");
  await user.clear(day);
  await user.type(day, "2025-09-12");
  await user.click(mine.getByRole("button", { name: "Save date" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Socks is now until 2025-09-12.");
  expect(server.sent).toEqual([{ expires_on: "2025-09-12" }]);
});

// --- in the app --------------------------------------------------------------------------

let store: Store;
let calls: string[];
let factory: IDBFactory;

const server = async (input: string | URL | Request): Promise<Response> => {
  const path = new URL(String(input), "http://x").pathname;
  calls.push(path);
  if (path === "/outreach/items") return answer(listing);
  if (path === "/outreach/holds") return answer({ holds: [] });
  if (path === "/auth/sign-out") return answer({});
  return answer({ error: "forbidden", message: "Outreach accounts cannot do this" }, 403);
};

beforeEach(async () => {
  calls = [];
  navigate("/");
  factory = new IDBFactory();
  store = await Store.open(await openDb("test", factory), () => T0);
});

const mountApp = () =>
  render(<App store={store} api={createApi({ fetch: server, token: () => store.meta.token })} now={() => T0} />);

test("an Outreach account gets this screen and nothing of the app, and never syncs (FR-USR-39, FR-VIS-03)", async () => {
  await store.setMeta({
    token: "tok",
    user: { id: "omar", name: "Omar", role: "outreach", active: true },
  });
  navigate("/items");
  mountApp();
  expect(await screen.findByText("12 available · Back room")).toBeInTheDocument();
  expect(screen.queryByRole("navigation")).toBeNull();
  expect(screen.queryByRole("link", { name: /Scan|Settings|Holds|Inventory/ })).toBeNull();
  expect(calls.filter((c) => c.startsWith("/sync"))).toEqual([]);
});

test("a device that was Staff forgets its copy of the inventory when it signs in as Outreach (FR-USR-42)", async () => {
  await store.bootstrap({ item: { a: { name: "Staff radio" } } }, 7, "log-one");
  await store.setMeta({
    hold_handles: { h1: "Mouse" },
    pending_handles: { h2: "Bird" },
  });
  await store.record({
    entity_type: "item",
    entity_id: "a",
    type: "note_added",
    actor_id: "omar",
    payload: {},
  });
  await store.setMeta({
    token: "tok",
    user: { id: "omar", name: "Omar", role: "outreach", active: true },
  });
  expect(store.holdsData).toBe(true);

  mountApp();
  await waitFor(() => expect(store.holdsData).toBe(false));
  expect(store.items).toEqual({});
  expect(store.pending).toEqual([]);
  expect(store.meta.hold_handles).toBeUndefined();
  expect(store.meta.pending_handles).toBeUndefined();
  expect(store.meta.cursor).toBeUndefined();
  // Still signed in, on the same device.
  expect(store.meta.token).toBe("tok");

  // And it is gone from the disk, not just from memory.
  const again = await Store.open(await openDb("test", factory), () => T0);
  expect(again.items).toEqual({});
  expect(again.pending).toEqual([]);
});

test("signing out returns to the sign-in page", async () => {
  await store.setMeta({
    token: "tok",
    user: { id: "omar", name: "Omar", role: "outreach", active: true },
  });
  mountApp();
  await user.click(await screen.findByRole("button", { name: "Sign out" }));
  expect(await screen.findByLabelText("Email")).toBeInTheDocument();
  expect(store.meta.token).toBeUndefined();
});
