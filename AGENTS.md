# Project build convention

- The finished Obsidian plugin bundle lives in `dist/obsidian-plugin/envoy/`.
- `npm run build` generates the intermediate root `main.js`. After building, copy `main.js`, `manifest.json`, and `styles.css` into the bundle directory above.
- When reporting a completed build, link to the `dist/obsidian-plugin/envoy/` bundle, not the intermediate root `main.js`.
