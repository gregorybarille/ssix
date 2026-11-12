/**
 * Field-name parity between the Files view's hand-written types and their
 * ts-rs bindings, on the pattern of `typesParity.test.ts`. The samples are
 * typed against the generated shape, so tsc fails when Rust gains a field;
 * the assertions fail when `src/types/index.ts` lacks it.
 */
import { describe, it, expect } from "vitest";
import type { EditSaveOutcome as GenEditSaveOutcome } from "@/types/generated/EditSaveOutcome";
import type { EditSession as GenEditSession } from "@/types/generated/EditSession";
import type { EditStatus as GenEditStatus } from "@/types/generated/EditStatus";
import type { FileEntry as GenFileEntry } from "@/types/generated/FileEntry";
import type { FileKind as GenFileKind } from "@/types/generated/FileKind";
import type { FileListing as GenFileListing } from "@/types/generated/FileListing";
import type { SftpSessionInfo as GenSftpSessionInfo } from "@/types/generated/SftpSessionInfo";
import type { TransferEvent as GenTransferEvent } from "@/types/generated/TransferEvent";
import type {
  EditSaveOutcome,
  EditSession,
  EditStatus,
  FileEntry,
  FileKind,
  FileListing,
  SftpSessionInfo,
  TransferEvent,
} from "@/types";

const genEntry: GenFileEntry = {
  name: "",
  path: "",
  kind: "file",
  target_is_dir: false,
  size: 0,
  modified: 0,
  mode: 0,
};
const genListing: GenFileListing = {
  path: "",
  parent: null,
  entries: [],
  omitted: 0,
  truncated: false,
};
const genSession: GenSftpSessionInfo = { session_id: "", start_path: "", label: "" };
const genEdit: GenEditSession = {
  edit_id: "",
  name: "",
  remote_path: "",
  temp_path: "",
  size: 0,
};
const genStatus: GenEditStatus = { modified: false, missing: false };

const handEntry: FileEntry = { ...genEntry };
const handListing: FileListing = { ...genListing, entries: [] };
const handSession: SftpSessionInfo = { ...genSession };
const handEdit: EditSession = { ...genEdit };
const handStatus: EditStatus = { ...genStatus };

// Every variant both ways, so a variant or field on one side only fails tsc.
const kinds: GenFileKind[] = ["file", "dir", "symlink", "other"];
const handKinds: FileKind[] = kinds;

const genEvents: GenTransferEvent[] = [
  {
    type: "progress",
    id: "",
    bytes_done: 0,
    bytes_total: 0,
    files_done: 0,
    files_total: 0,
    current: "",
  },
  { type: "done", id: "", bytes: 0, files: 0, skipped: 0, notes: [], target: "" },
  { type: "cancelled", id: "" },
  { type: "conflict", id: "", target: "", target_is_dir: false },
  { type: "failed", id: "", error: "" },
];
const handEvents: TransferEvent[] = genEvents;
const backToGenEvents: GenTransferEvent[] = handEvents;

const genOutcomes: GenEditSaveOutcome[] = [
  { outcome: "saved", size: 0 },
  { outcome: "remote_changed", deleted: false, size: null, modified: null },
];
const handOutcomes: EditSaveOutcome[] = genOutcomes;
const backToGenOutcomes: GenEditSaveOutcome[] = handOutcomes;

describe("Files view types match the Rust bindings", () => {
  it.each([
    ["FileEntry", genEntry, handEntry],
    ["FileListing", genListing, handListing],
    ["SftpSessionInfo", genSession, handSession],
    ["EditSession", genEdit, handEdit],
    ["EditStatus", genStatus, handStatus],
  ])("%s has the same fields", (_name, generated, hand) => {
    expect(Object.keys(hand).sort()).toEqual(Object.keys(generated).sort());
  });

  it("agrees on every variant", () => {
    expect(handKinds).toHaveLength(4);
    expect(backToGenEvents.map((e) => e.type)).toEqual([
      "progress",
      "done",
      "cancelled",
      "conflict",
      "failed",
    ]);
    expect(backToGenOutcomes.map((o) => o.outcome)).toEqual(["saved", "remote_changed"]);
  });
});
