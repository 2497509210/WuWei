import type { Item, ItemPatch } from "../api/client";

export type ItemDraft = { name: string; aliases: string; quantity: number; notes: string };
export type DraftField = keyof ItemDraft;
export const draftFieldLabels: Record<DraftField, string> = { name: "名称", aliases: "别名", quantity: "数量", notes: "备注" };
export type FieldConflict = { field: DraftField; mine: string | number; latest: string | number; choice: "mine" | "latest" | null };
const fields: DraftField[] = ["name", "aliases", "quantity", "notes"];

export function itemDraft(item: Item): ItemDraft {
  return { name: item.name, aliases: item.aliases.join("、"), quantity: item.quantity, notes: item.notes ?? "" };
}

function values(draft: ItemDraft) {
  return { ...draft, name: draft.name.trim(), aliases: Array.from(new Set(draft.aliases.split(/[、,，\n]/).map(value => value.trim()).filter(Boolean))) };
}

/** Compare the values the server accepts, so whitespace and duplicate aliases are not edits. */
export function changedItemFields(baseline: ItemDraft, draft: ItemDraft): Omit<ItemPatch, "expected_version"> {
  const before = values(baseline), after = values(draft);
  return Object.fromEntries(fields.filter(field => JSON.stringify(before[field]) !== JSON.stringify(after[field])).map(field => [field, after[field]]));
}

export function mergeItemDraft(baseline: ItemDraft, mine: ItemDraft, latest: ItemDraft): { draft: ItemDraft; conflicts: FieldConflict[] } {
  const before = values(baseline), local = values(mine), remote = values(latest);
  let draft = { ...latest };
  const conflicts: FieldConflict[] = [];
  for (const field of fields) {
    const changedHere = JSON.stringify(local[field]) !== JSON.stringify(before[field]);
    const changedThere = JSON.stringify(remote[field]) !== JSON.stringify(before[field]);
    const equal = JSON.stringify(local[field]) === JSON.stringify(remote[field]);
    if (changedHere && !equal) draft = { ...draft, [field]: mine[field] };
    if (changedHere && changedThere && !equal) conflicts.push({ field, mine: mine[field], latest: latest[field], choice: null });
  }
  return { draft, conflicts };
}
