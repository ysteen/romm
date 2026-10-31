import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const player = readFileSync(
  resolve("src/views/Player/EmulatorJS/Player.vue"),
  "utf8",
);
const script = player.match(
  /<script setup lang="ts">([\s\S]*?)<\/script>/,
)?.[1];
if (!script) throw new Error("Player script not found");
const source = ts.createSourceFile("Player.ts", script, ts.ScriptTarget.Latest);
const fn = source.statements.find(
  (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === "syncPendingSave",
);
if (!fn) throw new Error("Missing multiplayer save synchronization");
const code = ts.transpile(fn.getText(source), {
  target: ts.ScriptTarget.ES2022,
});

function setup(
  writeSave = vi.fn().mockResolvedValue({ id: 1 }),
  saveWrite = Promise.resolve(),
) {
  const bytes = new Uint8Array([7, 9, 11]);
  const context = {
    window: { EJS_emulator: { gameManager: { getSaveFile: () => bytes } } },
    stateBusy: false,
    saveLoading: false,
    saveWrite,
    writeSave,
    saveTracker: { hasChanges: () => true },
    toArrayBuffer: (data: Uint8Array) => data.slice().buffer,
    romsStore: { update: vi.fn() },
    romRef: { value: { id: 7 } },
    uninstallAutoSaveSync: vi.fn(),
  };
  const sync = runInNewContext(
    code + "\nsyncPendingSave",
    context,
  ) as () => Promise<void>;
  return { sync, context };
}

describe("multiplayer save handoff", () => {
  it("waits for the active write and preserves periodic saving", async () => {
    let finish!: () => void;
    const active = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const { sync, context } = setup(undefined, active);
    const pending = sync();
    await Promise.resolve();
    expect(context.writeSave).not.toHaveBeenCalled();
    finish();
    await pending;
    expect(context.writeSave).toHaveBeenCalledOnce();
    const uploaded = context.writeSave.mock.calls[0][0] as {
      saveFile: ArrayBuffer;
    };
    expect(new Uint8Array(uploaded.saveFile)).toEqual(
      new Uint8Array([7, 9, 11]),
    );
    expect(context.romsStore.update).toHaveBeenCalledOnce();
    expect(context.uninstallAutoSaveSync).not.toHaveBeenCalled();
  });
  it("rejects held or failed uploads without disabling autosave", async () => {
    for (const writeSave of [
      vi.fn().mockResolvedValue(null),
      vi.fn().mockRejectedValue(new Error("offline")),
    ]) {
      const { sync, context } = setup(writeSave);
      await expect(sync()).rejects.toThrow();
      expect(context.romsStore.update).not.toHaveBeenCalled();
      expect(context.uninstallAutoSaveSync).not.toHaveBeenCalled();
    }
  });
  it("waits for an in-progress restore to finish before a room may open", async () => {
    const { sync, context } = setup();
    context.saveLoading = true;
    await expect(sync()).rejects.toThrow("still loading");
    expect(context.writeSave).not.toHaveBeenCalled();
  });
});
