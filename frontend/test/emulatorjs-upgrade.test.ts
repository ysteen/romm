import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const player = read("../src/views/Player/EmulatorJS/Player.vue");
const script = player.match(
  /<script setup lang="ts">([\s\S]*?)<\/script>/,
)?.[1];
if (!script) throw new Error("Player script not found");
const source = ts.createSourceFile("Player.ts", script, ts.ScriptTarget.Latest);

function assignment(name: string): ts.Expression {
  for (const statement of source.statements) {
    if (
      ts.isExpressionStatement(statement) &&
      ts.isBinaryExpression(statement.expression) &&
      statement.expression.left.getText(source) === name
    ) {
      return statement.expression.right;
    }
  }
  throw new Error(`Player assignment not found: ${name}`);
}

// Execute the real startup block without mounting a ROM or writing save data.
const start = assignment("window.EJS_onGameStart");
if (!ts.isArrowFunction(start) || !ts.isBlock(start.body)) {
  throw new Error("Player startup handler not found");
}
const injection = start.body.statements.find(
  (node) =>
    ts.isExpressionStatement(node) && ts.isVoidExpression(node.expression),
);
if (
  !injection ||
  !ts.isExpressionStatement(injection) ||
  !ts.isVoidExpression(injection.expression)
) {
  throw new Error("Save/state injection block not found");
}
const injectionCode = injection.expression.expression.getText(source);

describe("EmulatorJS 5.2 save integration", () => {
  for (const directory of [false, true]) {
    for (const save of [false, true]) {
      for (const state of [false, true]) {
        it(`directory=${directory}, save=${save}, state=${state}`, async () => {
          const props = {
            save: save ? { id: 1 } : null,
            state: state ? { id: 2 } : null,
          };
          const loadSave = vi.fn().mockResolvedValue(undefined);
          const loadState = vi.fn().mockResolvedValue(undefined);
          const emulator = { settings: { vsync: "enabled" } };
          await runInNewContext(injectionCode, {
            props,
            usesDirectorySaveBundle: directory,
            waitForGameManager: async () => true,
            loadSave,
            loadState,
            STATE_APPLY_SETTLE_MS: 500,
            setTimeout: (callback: () => void) => callback(),
            window: { EJS_emulator: emulator },
          });
          expect(loadState).toHaveBeenCalledTimes(state ? 1 : 0);
          expect(loadSave).toHaveBeenCalledTimes(
            save && !state && !directory ? 1 : 0,
          );
          if (state) expect(loadState).toHaveBeenCalledWith(props.state);
          if (save && !state && !directory)
            expect(loadSave).toHaveBeenCalledWith(props.save);
          expect(emulator.settings).toEqual({
            vsync: "enabled",
            "save-state-location": "browser",
          });
        });
      }
    }
  }

  it.each([false, true])(
    "restores directory bundles before boot: %s",
    (directory) => {
      const downloadPath = "/api/saves/123/content";
      const files = runInNewContext(
        assignment("window.EJS_externalFiles").getText(source),
        {
          usesDirectorySaveBundle: directory,
          props: { save: { download_path: downloadPath }, state: { id: 2 } },
        },
      );
      expect(files).toEqual(directory ? { "/data/saves/": downloadPath } : {});
    },
  );
});

describe("EmulatorJS runtime cache revision", () => {
  const loader = read("../../custom-emulatorjs/data/loader.js");
  const resolver = loader.slice(0, loader.indexOf("async function loadScript"));
  function resolve(path: string, paths: Record<string, string> = {}) {
    return runInNewContext(
      `${resolver}\nresolvePath(${JSON.stringify(path)})`,
      {
        URL,
        document: {
          baseURI: "http://localhost:8081/rom/17/ejs",
          currentScript: {
            src: "http://localhost:8081/assets/emulatorjs/data/loader.js?v=test-revision",
          },
        },
        window: { EJS_pathtodata: "/assets/emulatorjs/data" },
        EJS_paths: paths,
      },
    );
  }

  it("versions local runtime modules", () => {
    expect(resolve("emulator.js")).toBe(
      "http://localhost:8081/assets/emulatorjs/data/src/emulator.js?v=test-revision",
    );
  });

  it("does not rewrite external or unrelated same-origin paths", () => {
    for (const path of [
      "https://cdn.example.test/custom.js?v=original",
      "http://localhost:8081/custom.js?v=original",
    ]) {
      expect(resolve("emulator.js", { "emulator.js": path })).toBe(path);
    }
  });

  it("keeps all player entries aligned with the GameManager import", () => {
    const emulator = read("../../custom-emulatorjs/data/src/emulator.js");
    const revision = emulator.match(/GameManager\.js\?v=([^"']+)/)?.[1];
    expect(revision).toBeTruthy();
    for (const entry of [
      "../src/console/views/Play.vue",
      "../src/v2/views/Player/EmulatorJS.vue",
      "../src/views/Player/EmulatorJS/Base.vue",
    ]) {
      expect(read(entry).match(/ROMM_RUNTIME_REVISION = "([^"]+)"/)?.[1]).toBe(
        revision,
      );
    }
  });
});
