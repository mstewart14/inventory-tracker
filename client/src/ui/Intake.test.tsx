import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import * as act from "../lib/actions";
import * as inv from "../lib/inventory";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { unsaved } from "../lib/unsaved";
import { openStore } from "./codeTestKit";
import { ItemPage } from "./ItemPage";
import { alice, renderInShell, seedUsers } from "./moveTestKit";

// Where an item came from, and who may see it (FR-INT-01, FR-VIS-01).
let store: Store;

beforeEach(async () => {
  store = await openStore();
  await seedUsers(store, [alice]);
});

afterEach(() => unsaved.cancel());

const user = userEvent.setup();
const fact = (label: string) => (screen.getByText(label).nextElementSibling as HTMLElement).textContent;

test("an item is staff only with no source until someone says otherwise (FR-INT-02, FR-VIS-01)", async () => {
  const coat = await act.createItem(store, { name: "Winter coat" });
  const it = inv.item(store.state, coat)!;
  expect(inv.visibilityOf(store.state, it)).toBe("staff");
  expect(inv.sourceOf(store.state, it)).toBeNull();
  navigate(`/items/${coat}`);
  renderInShell(<ItemPage store={store} id={coat} />);
  expect(fact("Visible to")).toBe("Staff only");
  expect(fact("Source")).toBe("—");
});

test("the item form sets the source, suggesting ones already used, and who may see it (FR-INT-03, FR-VIS-08)", async () => {
  await act.createItem(store, { name: "Tent", source: "Church drive" });
  const coat = await act.createItem(store, { name: "Winter coat" });
  navigate(`/items/${coat}`);
  renderInShell(<ItemPage store={store} id={coat} />);
  await user.click(screen.getByRole("button", { name: "Edit" }));

  const source = screen.getByLabelText("Source (optional)");
  expect([...document.querySelectorAll("#item-sources option")].map((o) => o.getAttribute("value"))).toEqual([
    "Church drive",
  ]);
  await user.type(source, "Outdoor store");
  await user.selectOptions(screen.getByLabelText("Visible to"), "Public");
  await user.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() =>
    expect(inv.item(store.state, coat)).toMatchObject({ source: "Outdoor store", visibility: "public" }),
  );
  expect(fact("Visible to")).toBe("Public");
  expect(fact("Source")).toBe("Outdoor store");

  // Back to staff only is stored as nothing, not as a fourth value.
  await user.click(screen.getByRole("button", { name: "Edit" }));
  await user.selectOptions(screen.getByLabelText("Visible to"), "Staff only");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(inv.item(store.state, coat)!.visibility).toBeNull());
});

test("a unit takes its generic's source and visibility (FR-INT-06, FR-VIS-13)", async () => {
  const tents = await act.createGeneric(store, { name: "Tent", source: "Scout group", visibility: "outreach" });
  const unit = await act.addUnit(store, tents);
  const it = inv.item(store.state, unit)!;
  expect(inv.visibilityOf(store.state, it)).toBe("outreach");
  expect(inv.sourceOf(store.state, it)).toBe("Scout group");
});

test("turning one item into several keeps where it came from and who may see it", async () => {
  const coat = await act.createItem(store, { name: "Coat", source: "Church drive", visibility: "public" });
  const generic = await act.makeGeneric(store, coat);
  expect(inv.item(store.state, generic)).toMatchObject({ source: "Church drive", visibility: "public" });
});
