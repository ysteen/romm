export function createAramStorage(storage: Storage, userId: number): Storage {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error("ARAM requires a user-specific storage namespace");
  }
  const prefix = `romm:aram:user:${userId}:`;
  function keys(): string[] {
    const result: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(prefix)) result.push(key.slice(prefix.length));
    }
    return result;
  }
  return {
    get length() {
      return keys().length;
    },
    key: (index: number) => keys()[index] ?? null,
    getItem: (key: string) => storage.getItem(prefix + key),
    setItem: (key: string, value: string) =>
      storage.setItem(prefix + key, value),
    removeItem: (key: string) => storage.removeItem(prefix + key),
    clear: () => {
      for (const key of keys()) storage.removeItem(prefix + key);
    },
  };
}

export function prepareAramSettings(
  storage: Storage,
  preferences: { theme: "light" | "dark"; language: string; touch: boolean },
): void {
  const raw = storage.getItem("aram.settings");
  let settings: Record<string, unknown> = {};
  if (raw) {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid ARAM settings");
    }
    settings = parsed as Record<string, unknown>;
  }
  storage.setItem(
    "aram.settings",
    JSON.stringify({
      ...settings,
      analytics_enabled: false,
      theme_mode: preferences.theme,
      language: preferences.language.startsWith("ko") ? "ko" : "en",
      ...(settings.show_virtual_keypad === undefined
        ? { show_virtual_keypad: preferences.touch }
        : {}),
    }),
  );
}
