/**
 * The import's IPC shapes against the ts-rs bindings, as `typesParity.test.ts`
 * does for the persisted models. These only travel over IPC, and the two
 * sides agree exactly because every optional field is an explicit `null`,
 * so a plain assignment in each direction is enough: tsc fails on any drift
 * (`npx tsc --noEmit`, `npm run build`).
 */
import { describe, it, expect } from "vitest";
import type { ImportCredentialPlan as GenCredentialPlan } from "@/types/generated/ImportCredentialPlan";
import type { ImportItem as GenItem } from "@/types/generated/ImportItem";
import type { ImportNotice as GenNotice } from "@/types/generated/ImportNotice";
import type { ImportPreview as GenPreview } from "@/types/generated/ImportPreview";
import type { ImportResult as GenResult } from "@/types/generated/ImportResult";
import type { ImportSkip as GenSkip } from "@/types/generated/ImportSkip";
import type { ImportSkipCategory as GenSkipCategory } from "@/types/generated/ImportSkipCategory";
import type {
  ImportCredentialPlan,
  ImportItem,
  ImportNotice,
  ImportPreview,
  ImportResult,
  ImportSkip,
  ImportSkipCategory,
} from "@/types";

const credential: GenCredentialPlan = {
  role: "Credential",
  name: "n",
  username: "u",
  private_key_path: null,
  exists: false,
};
const item: GenItem = {
  key: "k",
  name: "n",
  type: "direct",
  target: "u@h:22",
  credentials: [credential],
  proxy_command: null,
  notes: [],
  source: "config:1",
};
const category: GenSkipCategory = "name_clash";
const skip: GenSkip = { name: "n", category, reason: "r", source: "config:1" };
const notice: GenNotice = { message: "m", source: "config:1" };
const preview: GenPreview = {
  path: "p",
  files: ["p"],
  items: [item],
  skipped: [skip],
  notices: [notice],
};
const result: GenResult = { connections: ["n"], credentials: [] };

// Hand-written to generated: every field the frontend reads exists on the wire.
const handCredential: ImportCredentialPlan = credential;
const handItem: ImportItem = { ...item, type: "direct" };
const handCategory: ImportSkipCategory = category;
const handSkip: ImportSkip = skip;
const handNotice: ImportNotice = notice;
const handPreview: ImportPreview = { ...preview, items: [handItem] };
const handResult: ImportResult = result;

// Generated to hand-written: no generated field is missing from index.ts.
const backItem: GenItem = handItem;
const backPreview: GenPreview = handPreview;
const backCredential: GenCredentialPlan = handCredential;
const backCategory: GenSkipCategory = handCategory;
const backSkip: GenSkip = handSkip;
const backNotice: GenNotice = handNotice;
const backResult: GenResult = handResult;

describe("import IPC types", () => {
  it("match the generated bindings field for field", () => {
    const pairs: [object, object][] = [
      [backCredential, credential],
      [backItem, item],
      [backSkip, skip],
      [backNotice, notice],
      [backPreview, preview],
      [backResult, result],
    ];
    for (const [hand, generated] of pairs) {
      expect(Object.keys(hand).sort()).toEqual(Object.keys(generated).sort());
    }
    expect(backCategory).toBe(category);
  });
});
