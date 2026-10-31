# Reusable Linux/WSL test browser

The isolated Headless Chrome binary and locally extracted libraries live in
`../.cache/romm-headless-browser`, outside the checkout and `/tmp`. The revision
follows the Playwright package installed under `frontend/node_modules`.
Set `ROMM_BROWSER_CACHE` to override the cache location.

```sh
node scripts/headless-browser.mjs setup
node scripts/headless-browser.mjs check
node scripts/headless-browser.mjs smoke
```

`setup` reuses an available matching binary and working libraries. When needed,
it downloads Chrome and extracts missing Ubuntu/Debian library packages into
the cache. It does not install system packages. `check` only inspects files and
library dependencies. `smoke` opens a temporary browser, checks interaction, and
closes it.

Use the managed helper in a Node test:

```js
import { withHeadlessBrowser } from "./headless-browser.mjs";

await withHeadlessBrowser(async (browser) => {
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:8081");
  // Exercise the page while this callback is active.
});
```

`launchHeadlessBrowser` is also available for harnesses with their own
`try/finally`; always call `browser.close()` in `finally`. Both helpers close
their isolated browser on SIGINT/SIGTERM. They use temporary browser profiles,
never the user's normal Chrome profile. Only executable files and libraries
persist. Chrome runs without its sandbox inside this isolated test setup.

Keep the browser closed during builds and unrelated work. Test RomM on port
8081, and bound emulator/build parallelism to the WSL memory available.
