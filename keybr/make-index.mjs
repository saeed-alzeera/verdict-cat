import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(join(__dirname, "static", "manifest.json"), "utf8"),
);

const entry = manifest.entrypoints.browser;
const cssFiles = entry.assets.css ?? [];
const jsFiles = entry.assets.js ?? [];

const pageData = {
  base: "",
  locale: "en",
  user: null,
  publicUser: { id: null, name: "User", imageUrl: null },
  settings: null,
};

// Site defaults applied before the app bundle loads. Only seed values when the
// user has not chosen otherwise, so these act as defaults rather than forced
// overrides. Kept in the generated index.html so they survive every rebuild.
const defaultsScript = `<script>
(function () {
  try {
    // ----- Default color theme: dark -----
    var prefs = null;
    var m = document.cookie.match(/(?:^|;\\s*)prefs=([^;]*)/);
    if (m) { try { prefs = JSON.parse(decodeURIComponent(m[1])); } catch (e) {} }
    if (!prefs || !prefs.color) {
      prefs = { color: "dark", font: (prefs && prefs.font) || "open-sans" };
      document.cookie = "prefs=" + encodeURIComponent(JSON.stringify(prefs)) +
        ";path=/;max-age=" + (100 * 24 * 60 * 60) + ";samesite=Lax";
    }
    document.documentElement.setAttribute("data-color", prefs.color);
    document.documentElement.setAttribute("data-font", prefs.font || "open-sans");

    // ----- Default keyboard: Arabic (Saudi Arabia) 101 — also marks settings as
    // not-new so the introduction tour popup does not appear. -----
    if (localStorage.getItem("settings") == null) {
      localStorage.setItem("settings", JSON.stringify({
        "keyboard.language": "ar",
        "keyboard.layout": "ar-sa"
      }));
    }
  } catch (e) { /* ignore */ }
})();
</script>`;

const html = `<!DOCTYPE html>
<html lang="en" data-color="dark" data-font="open-sans">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Keybr — Typing Practice</title>
${cssFiles.map((f) => `<link rel="stylesheet" href="${f}" />`).join("\n")}
<script>var __PAGE_DATA__ = ${JSON.stringify(pageData)};</script>
${defaultsScript}
${jsFiles.map((f) => `<script defer src="${f}"></script>`).join("\n")}
</head>
<body>
<div id="keybr-root"></div>
</body>
</html>`;

writeFileSync(join(__dirname, "index.html"), html);
console.log("Generated keybr/index.html");
console.log("CSS:", cssFiles);
console.log("JS:", jsFiles);
