/**
 * The order of the sidebar's two reorderable groups. Pure, so what a drag or a
 * menu does to the order can be tested without a sidebar. Only the ids are
 * stored: `arrangeSidebar` turns what is in settings into what can be shown.
 */

export type SidebarGroup = "top" | "bottom";

export interface SidebarOrder {
  top: readonly string[];
  bottom: readonly string[];
}

/** A place in a group, counted without the button being moved. */
export interface SidebarSlot {
  group: SidebarGroup;
  index: number;
}

/** Where a view starts, and whether it can move at all. */
const GROUP_OF_PLACEMENT: Partial<Record<string, SidebarGroup>> = {
  main: "top",
  footer: "bottom",
};

interface PlacedView {
  id: string;
  placement: string;
}

export function defaultSidebarOrder(views: readonly PlacedView[]): SidebarOrder {
  const inGroup = (group: SidebarGroup) =>
    views.filter((view) => GROUP_OF_PLACEMENT[view.placement] === group).map((view) => view.id);
  return { top: inGroup("top"), bottom: inGroup("bottom") };
}

/**
 * What is stored, made safe to show: an id that names no movable view (one from
 * a newer build, or a hand edit) or that came earlier is dropped, and a view the
 * stored order has never heard of goes at the end of its own group.
 */
export function arrangeSidebar(views: readonly PlacedView[], stored: SidebarOrder): SidebarOrder {
  const defaults = defaultSidebarOrder(views);
  const movable = new Set([...defaults.top, ...defaults.bottom]);
  const seen = new Set<string>();
  const keep = (ids: readonly string[]) =>
    ids.filter((id) => {
      if (!movable.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  const top = keep(stored.top);
  const bottom = keep(stored.bottom);
  return {
    top: [...top, ...defaults.top.filter((id) => !seen.has(id))],
    bottom: [...bottom, ...defaults.bottom.filter((id) => !seen.has(id))],
  };
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

export function sameOrder(a: SidebarOrder, b: SidebarOrder): boolean {
  return sameList(a.top, b.top) && sameList(a.bottom, b.bottom);
}

function swapped(list: readonly string[], i: number, j: number): string[] {
  const next = [...list];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

/**
 * One place up, with the two groups read as one list: the first of the bottom
 * group becomes the last of the top. At the very top the order comes back as
 * the same object, which is how a menu knows to disable the item.
 */
export function moveUp(order: SidebarOrder, id: string): SidebarOrder {
  const { top, bottom } = order;
  const inTop = top.indexOf(id);
  if (inTop > 0) return { top: swapped(top, inTop, inTop - 1), bottom };
  const inBottom = bottom.indexOf(id);
  if (inBottom > 0) return { top, bottom: swapped(bottom, inBottom, inBottom - 1) };
  if (inBottom === 0) return { top: [...top, id], bottom: bottom.slice(1) };
  return order;
}

/** One place down; see `moveUp`. */
export function moveDown(order: SidebarOrder, id: string): SidebarOrder {
  const { top, bottom } = order;
  const inBottom = bottom.indexOf(id);
  if (inBottom >= 0 && inBottom < bottom.length - 1) {
    return { top, bottom: swapped(bottom, inBottom, inBottom + 1) };
  }
  const inTop = top.indexOf(id);
  if (inTop >= 0 && inTop < top.length - 1) {
    return { top: swapped(top, inTop, inTop + 1), bottom };
  }
  if (inTop >= 0) return { top: top.slice(0, -1), bottom: [id, ...bottom] };
  return order;
}

/** Put a button in a slot. Letting go where it already was changes nothing. */
export function moveToSlot(order: SidebarOrder, id: string, slot: SidebarSlot): SidebarOrder {
  const without = (list: readonly string[]) => list.filter((other) => other !== id);
  const next = { top: without(order.top), bottom: without(order.bottom) };
  const list = next[slot.group];
  const index = Math.min(Math.max(slot.index, 0), list.length);
  const moved = {
    ...next,
    [slot.group]: [...list.slice(0, index), id, ...list.slice(index)],
  };
  return sameOrder(order, moved) ? order : moved;
}

/** Where a group sits on screen, and the middle of each button still in it. */
export interface GroupGeometry {
  start: number;
  end: number;
  centres: readonly number[];
}

/**
 * The slot under a height on screen. The space between the groups belongs to
 * whichever is nearer, so the terminals button and the empty stretch of the
 * sidebar are no dead zone.
 */
export function dropSlot(y: number, top: GroupGeometry, bottom: GroupGeometry): SidebarSlot {
  const group: SidebarGroup = y < (top.end + bottom.start) / 2 ? "top" : "bottom";
  const { centres } = group === "top" ? top : bottom;
  return { group, index: centres.filter((centre) => centre < y).length };
}
