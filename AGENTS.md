# Project build convention

- The finished Obsidian plugin bundle lives in `dist/obsidian-plugin/courier/`.
- `npm run build` generates the intermediate root `main.js`. After building, copy `main.js`, `manifest.json`, and `styles.css` into the bundle directory above.
- When reporting a completed build, link to the `dist/obsidian-plugin/courier/` bundle, not the intermediate root `main.js`.
