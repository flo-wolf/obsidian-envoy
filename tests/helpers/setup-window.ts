// Obsidian runs plugins in a browser window; the tests run in Node. Plugin code
// uses window.setTimeout and friends (for popout windows), so give Node a window.
if (typeof globalThis.window === "undefined") {
  Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true });
}

// Obsidian's global createFragment, enough for descriptions: text and line breaks.
if (typeof (globalThis as { createFragment?: unknown }).createFragment === "undefined") {
  Object.defineProperty(globalThis, "createFragment", {
    configurable: true,
    value: (build?: (fragment: unknown) => void) => {
      const parts: string[] = [];
      const fragment = {
        createEl: (tag: string, options?: { text?: string }) => {
          parts.push(tag === "br" ? "\n" : options?.text ?? "");
          return {};
        },
        appendText: (text: string) => {
          parts.push(text);
        },
        get textContent() {
          return parts.join("");
        },
      };
      build?.(fragment);
      return fragment;
    },
  });
}
