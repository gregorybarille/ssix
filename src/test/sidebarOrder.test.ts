import { describe, expect, it } from "vitest";
import {
  arrangeSidebar,
  defaultSidebarOrder,
  dropSlot,
  moveDown,
  moveToSlot,
  moveUp,
  sameOrder,
} from "@/lib/sidebarOrder";

const views = [
  { id: "a", placement: "main" },
  { id: "b", placement: "main" },
  { id: "term", placement: "sessions" },
  { id: "c", placement: "footer" },
  { id: "d", placement: "footer" },
  { id: "set", placement: "titlebar" },
];
const order = { top: ["a", "b"], bottom: ["c", "d"] };

describe("defaultSidebarOrder", () => {
  it("leaves out the views that do not move", () => {
    expect(defaultSidebarOrder(views)).toEqual(order);
  });
});

describe("arrangeSidebar", () => {
  it("gives the default order when nothing is stored", () => {
    expect(arrangeSidebar(views, { top: [], bottom: [] })).toEqual(order);
  });

  it("keeps a stored order, across groups", () => {
    expect(arrangeSidebar(views, { top: ["c", "a"], bottom: ["b", "d"] })).toEqual({
      top: ["c", "a"],
      bottom: ["b", "d"],
    });
  });

  it("puts a view added later at the end of its own group", () => {
    const added = [...views, { id: "new-top", placement: "main" }, { id: "new-bottom", placement: "footer" }];
    expect(arrangeSidebar(added, { top: ["c", "b", "a"], bottom: ["d"] })).toEqual({
      top: ["c", "b", "a", "new-top"],
      bottom: ["d", "new-bottom"],
    });
  });

  it("drops an unknown id, a view that does not move, and a duplicate", () => {
    expect(
      arrangeSidebar(views, { top: ["gone", "term", "b", "set", "b"], bottom: ["b", "a", "c", "d"] }),
    ).toEqual({ top: ["b"], bottom: ["a", "c", "d"] });
  });
});

describe("moveUp and moveDown", () => {
  it("swap neighbours inside a group", () => {
    expect(moveUp(order, "b")).toEqual({ top: ["b", "a"], bottom: ["c", "d"] });
    expect(moveUp(order, "d")).toEqual({ top: ["a", "b"], bottom: ["d", "c"] });
    expect(moveDown(order, "a")).toEqual({ top: ["b", "a"], bottom: ["c", "d"] });
    expect(moveDown(order, "c")).toEqual({ top: ["a", "b"], bottom: ["d", "c"] });
  });

  it("cross between the groups, each undoing the other", () => {
    const up = moveUp(order, "c");
    expect(up).toEqual({ top: ["a", "b", "c"], bottom: ["d"] });
    expect(moveDown(up, "c")).toEqual(order);
    const down = moveDown(order, "b");
    expect(down).toEqual({ top: ["a"], bottom: ["b", "c", "d"] });
    expect(moveUp(down, "b")).toEqual(order);
  });

  it("return the same object at either end, or for a view not in the order", () => {
    expect(moveUp(order, "a")).toBe(order);
    expect(moveDown(order, "d")).toBe(order);
    expect(moveUp(order, "term")).toBe(order);
    expect(moveDown(order, "term")).toBe(order);
  });

  it("can empty a group, and fill it again", () => {
    const one = { top: ["a"], bottom: ["c"] };
    const emptied = moveDown(one, "a");
    expect(emptied).toEqual({ top: [], bottom: ["a", "c"] });
    expect(moveUp(emptied, "a")).toEqual(one);
    const bottomEmptied = moveUp(one, "c");
    expect(bottomEmptied).toEqual({ top: ["a", "c"], bottom: [] });
    expect(moveDown(bottomEmptied, "c")).toEqual(one);
  });
});

describe("moveToSlot", () => {
  it("moves inside a group, counting without the button itself", () => {
    expect(moveToSlot({ top: ["a", "b", "x"], bottom: [] }, "a", { group: "top", index: 2 })).toEqual({
      top: ["b", "x", "a"],
      bottom: [],
    });
  });

  it("moves between groups, into an empty one too", () => {
    expect(moveToSlot(order, "a", { group: "bottom", index: 1 })).toEqual({
      top: ["b"],
      bottom: ["c", "a", "d"],
    });
    expect(moveToSlot({ top: ["a"], bottom: [] }, "a", { group: "bottom", index: 0 })).toEqual({
      top: [],
      bottom: ["a"],
    });
  });

  it("returns the same object when the button lands where it was", () => {
    expect(moveToSlot(order, "a", { group: "top", index: 0 })).toBe(order);
    expect(moveToSlot(order, "d", { group: "bottom", index: 1 })).toBe(order);
  });

  it("keeps an index past the end inside the list", () => {
    expect(moveToSlot(order, "a", { group: "bottom", index: 99 }).bottom).toEqual(["c", "d", "a"]);
  });
});

describe("sameOrder", () => {
  it("compares both groups in order", () => {
    expect(sameOrder(order, { top: ["a", "b"], bottom: ["c", "d"] })).toBe(true);
    expect(sameOrder(order, { top: ["b", "a"], bottom: ["c", "d"] })).toBe(false);
    expect(sameOrder(order, { top: ["a", "b", "c"], bottom: ["d"] })).toBe(false);
  });
});

describe("dropSlot", () => {
  const top = { start: 0, end: 100, centres: [20, 70] };
  const bottom = { start: 300, end: 400, centres: [320, 370] };

  it("counts the buttons above the pointer", () => {
    expect(dropSlot(5, top, bottom)).toEqual({ group: "top", index: 0 });
    expect(dropSlot(40, top, bottom)).toEqual({ group: "top", index: 1 });
    expect(dropSlot(90, top, bottom)).toEqual({ group: "top", index: 2 });
    expect(dropSlot(310, top, bottom)).toEqual({ group: "bottom", index: 0 });
    expect(dropSlot(395, top, bottom)).toEqual({ group: "bottom", index: 2 });
  });

  it("gives the space between the groups to the nearer one", () => {
    expect(dropSlot(199, top, bottom)).toEqual({ group: "top", index: 2 });
    expect(dropSlot(201, top, bottom)).toEqual({ group: "bottom", index: 0 });
  });

  it("treats past either end as the end", () => {
    expect(dropSlot(-50, top, bottom)).toEqual({ group: "top", index: 0 });
    expect(dropSlot(900, top, bottom)).toEqual({ group: "bottom", index: 2 });
  });

  it("finds a group with nothing left in it", () => {
    const emptyTop = { start: 0, end: 40, centres: [] };
    expect(dropSlot(10, emptyTop, bottom)).toEqual({ group: "top", index: 0 });
  });
});
