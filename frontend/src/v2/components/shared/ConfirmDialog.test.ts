import { flushPromises, mount } from "@vue/test-utils";
import mitt from "mitt";
import { describe, expect, it, vi } from "vitest";
import type { Events } from "@/types/emitter";
import ConfirmDialog from "@/v2/components/shared/ConfirmDialog.vue";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

describe("ConfirmDialog safe initial focus", () => {
  it("focuses Cancel rather than the dialog header and resolves cancellation", async () => {
    const emitter = mitt<Events>();
    const resolved = vi.fn();
    emitter.on("confirmResolved", resolved);
    const wrapper = mount(ConfirmDialog, {
      attachTo: document.body,
      global: { provide: { emitter } },
    });
    try {
      emitter.emit("showConfirm", {
        id: 19,
        title: "Load state",
        body: "Replace current progress?",
        confirmText: "Load",
        cancelText: "Cancel",
        tone: "danger",
      });
      await flushPromises();
      const cancel = document.querySelector<HTMLButtonElement>(
        '[role="dialog"] button[autofocus]',
      );
      expect(cancel?.textContent).toContain("Cancel");
      expect(document.activeElement).toBe(cancel);
      cancel?.click();
      await flushPromises();
      expect(resolved).toHaveBeenCalledExactlyOnceWith({
        id: 19,
        confirmed: false,
      });
    } finally {
      wrapper.unmount();
    }
  });
});
