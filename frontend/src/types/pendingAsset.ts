export type PendingAssetKind = "save" | "state";

export interface PendingAsset {
  /** One row per capture, so two offline sessions cannot overwrite each other. */
  id: string;
  kind: PendingAssetKind;
  /** The account that captured it, stamped on write. */
  userId?: number | null;
  romId: number;
  /** Named at capture time, so a rom the server no longer has can still be announced. */
  romName: string;
  /** The rom's file stem, which names the files a retry uploads. */
  fsNameNoExt?: string;
  cover?: string | null;
  bytes: ArrayBuffer;
  screenshotBytes?: ArrayBuffer | undefined;
  /** Saves only: the slot the session was writing to. */
  slot?: string | undefined;
  emulator?: string;
  /** Saves only: the device the session was playing on. */
  deviceId?: string | undefined;
  capturedAt: number;
}
