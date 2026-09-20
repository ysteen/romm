import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import {
  installBackMorph,
  pendingMorphName,
  useViewTransition,
} from "@/v2/composables/useViewTransition";

vi.mock("@/v2/composables/useReducedMotion", () => ({
  useReducedMotion: () => ({ enabled: { value: false } }),
}));

const original = Object.getOwnPropertyDescriptor(
  document,
  "startViewTransition",
);
const observed: { ready: Promise<void>; finished: Promise<void> }[] = [];

beforeEach(() => {
  observed.length = 0;
  Object.defineProperty(document, "startViewTransition", {
    configurable: true,
    value: (update: () => Promise<void>) => {
      const ready = Promise.reject<void>(
        new DOMException(
          "Transition was skipped. New ViewTransition started",
          "AbortError",
        ),
      );
      vi.spyOn(ready, "catch");
      const finished = Promise.resolve().then(update);
      const transition = { ready, finished };
      observed.push(transition);
      return transition;
    },
  });
});

afterEach(() => {
  if (original)
    Object.defineProperty(document, "startViewTransition", original);
  else Reflect.deleteProperty(document, "startViewTransition");
  vi.restoreAllMocks();
});

describe("superseded view transitions", () => {
  it("handles a skipped forward animation and still cleans up the cover", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const navigate = vi.fn().mockResolvedValue(undefined);
    try {
      useViewTransition().morphTransition(
        { el, name: "rom-cover-17" },
        navigate,
      );
      expect(observed[0].ready.catch).toHaveBeenCalledOnce();
      await observed[0].finished;
      expect(navigate).toHaveBeenCalledOnce();
      expect(el.style.viewTransitionName).toBe("");
    } finally {
      el.remove();
    }
  });

  it("handles a skipped ARAM exit animation without blocking navigation", async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/rom/:rom/aram", name: "aram", component: {} },
        { path: "/rom/:rom", name: "rom", component: {} },
      ],
    });
    await router.push("/rom/17/aram");
    const remove = installBackMorph(router);
    try {
      await router.push("/rom/17");
      expect(observed[0].ready.catch).toHaveBeenCalledOnce();
      await observed[0].finished;
      expect(router.currentRoute.value.name).toBe("rom");
      expect(pendingMorphName.value).toBeNull();
    } finally {
      remove();
    }
  });
});
