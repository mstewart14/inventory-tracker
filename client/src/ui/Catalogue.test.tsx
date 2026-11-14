import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { createApi } from "../lib/api";
import { API_BASE } from "../lib/server";
import { Catalogue } from "./Catalogue";

// The public catalogue: what anyone may read, and that nothing can be asked for on it (FR-VIS-04 to 07).
const T0 = 1_756_684_800_000;
const answer = (body: object, status = 200) => new Response(JSON.stringify({ ...body, server_time: T0 }), { status });
const PHOTO = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const listing = {
  group: { name: "The Society", contact: "desk@example.org" },
  items: [
    { name: "Socks", description: "", categories: ["Clothing"], photos: [] },
    { name: "Winter coat", description: "Warm, **size L**", categories: [], photos: [PHOTO] },
  ],
};

function mount(fetchFake: typeof fetch, onSignIn?: () => void) {
  const api = createApi({ fetch: fetchFake, now: () => T0 });
  return render(<Catalogue api={api} onSignIn={onSignIn} />);
}

const user = userEvent.setup();

test("anyone sees what is listed, and how to reach the society's staff (FR-VIS-04, FR-VIS-06)", async () => {
  const calls: string[] = [];
  mount(async (input, init) => {
    calls.push(`${init?.method ?? "GET"} ${String(input)}`);
    return answer(listing);
  });
  expect(await screen.findByRole("heading", { name: "The Society" })).toBeInTheDocument();
  expect(screen.getByText(/To ask for something, talk to our staff/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "desk@example.org" })).toHaveAttribute("href", "mailto:desk@example.org");
  expect(screen.getAllByRole("heading", { level: 2 }).map((x) => x.textContent)).toEqual(["Socks", "Winter coat"]);
  expect(screen.getByText("Clothing")).toBeInTheDocument();
  expect(screen.getByText("size L").tagName).toBe("STRONG");
  expect(screen.getByRole("img", { name: "Photo of Winter coat" })).toHaveAttribute(
    "src",
    `${API_BASE}/public/photos/${PHOTO}`,
  );
  // One read, with no credential, and nothing else.
  expect(calls).toEqual([`GET ${API_BASE}/public/catalogue`]);
});

test("nothing on the page asks for goods: no form, no button but staff sign-in (FR-VIS-07)", async () => {
  const onSignIn = vi.fn();
  mount(async () => answer(listing), onSignIn);
  await screen.findByRole("heading", { name: "The Society" });
  expect(document.querySelector("form")).toBeNull();
  const main = within(document.querySelector("main") ?? document.body);
  expect(main.queryAllByRole("button")).toEqual([]);
  await user.click(screen.getByRole("button", { name: "Staff sign in" }));
  expect(onSignIn).toHaveBeenCalled();
});

test("an empty catalogue says so, and still says how to reach the staff", async () => {
  mount(async () => answer({ ...listing, items: [] }));
  expect(await screen.findByText("Nothing is listed right now.")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "desk@example.org" })).toBeInTheDocument();
});

test("a long catalogue can be searched by name, category or description", async () => {
  const many = Array.from({ length: 9 }, (_, i) => ({
    name: `Blanket ${i}`,
    description: "",
    categories: [],
    photos: [],
  }));
  mount(async () => answer({ ...listing, items: [...many, ...listing.items] }));
  const search = await screen.findByRole("searchbox", { name: "Search what we have" });
  await user.type(search, "size coat");
  expect(screen.getAllByRole("heading", { level: 2 }).map((x) => x.textContent)).toEqual(["Winter coat"]);
  await user.clear(search);
  await user.type(search, "clothing");
  expect(screen.getAllByRole("heading", { level: 2 }).map((x) => x.textContent)).toEqual(["Socks"]);
  await user.clear(search);
  await user.type(search, "zzz");
  expect(screen.getByText("Nothing matches.")).toBeInTheDocument();
});

test("with no connection the page says it needs one", async () => {
  mount(async () => {
    throw new TypeError("Failed to fetch");
  });
  expect(await screen.findByRole("alert")).toHaveTextContent("No connection. This page needs one.");
});
