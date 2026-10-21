// Obsidian runs plugins in a browser window; the tests run in Node. Plugin code
// uses window.setTimeout and friends (for popout windows), so give Node a window.
if (typeof globalThis.window === "undefined") {
  Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true });
}
