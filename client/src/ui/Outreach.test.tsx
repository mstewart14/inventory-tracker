import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, test, vi } from "vitest";
import { App } from "../App";
import { createApi } from "../lib/api";
import { openDb } from "../lib/db";
import { navigate } from "../lib/router";
import { API_BASE } from "../lib/server";
import { Store } from "../lib/store";
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

const user = userEvent.setup();

function mount(fetchFake: typeof fetch, onSignOut = vi.fn()) {
  const api = createApi({
    fetch: fetchFake,
    token: () => "tok",
    now: () => T0,
  });
  render(<Outreach api={api} name="Omar" onSignOut={onSignOut} />);
  return onSignOut;
}

test("each item says how many are available and where it is kept (FR-VIS-09)", async () => {
  const calls: string[] = [];
  mount(async (input, init) => {
    calls.push(`${init?.method ?? "GET"} ${String(input)}`);
    return answer(listing);
  });
  expect(await screen.findByRole("heading", { name: "The Society" })).toBeInTheDocument();
  expect(screen.getByText("Signed in as Omar, Outreach.")).toBeInTheDocument();
  expect(screen.getAllByRole("heading", { level: 2 }).map((x) => x.textContent)).toEqual(["Socks", "Winter coat"]);
  expect(screen.getByText("12 available · Back room")).toBeInTheDocument();
  expect(screen.getByText("2 available · Back room, Front desk")).toBeInTheDocument();
  expect(screen.getByText("size L").tagName).toBe("STRONG");
  expect(calls).toEqual([`GET ${API_BASE}/outreach/items`]);
});

test("nothing available says so", async () => {
  mount(async () => answer({ ...listing, items: [] }));
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

test("Sign out is the only button", async () => {
  const onSignOut = mount(async () => answer(listing));
  await screen.findByRole("heading", { name: "The Society" });
  expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Sign out"]);
  await user.click(screen.getByRole("button", { name: "Sign out" }));
  expect(onSignOut).toHaveBeenCalled();
});

// --- in the app --------------------------------------------------------------------------

let store: Store;
let calls: string[];
let factory: IDBFactory;

const server = async (input: string | URL | Request): Promise<Response> => {
  const path = new URL(String(input), "http://x").pathname;
  calls.push(path);
  if (path === "/outreach/items") return answer(listing);
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
