import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(join(__dirname, "static", "manifest.json"), "utf8"),
);

const entry = manifest.entrypoints.browser;
const cssFiles = entry.assets.css ?? [];
const jsFiles = entry.assets.js ?? [];

const tokenFile = join(__dirname, ".github-token");
const githubToken = existsSync(tokenFile)
  ? readFileSync(tokenFile, "utf8").trim()
  : "";

if (!githubToken) {
  console.warn(
    "Warning: no .github-token file found — GitHub sync will be disabled.",
  );
}

const pageData = {
  base: "",
  locale: "en",
  user: null,
  publicUser: { id: null, name: "User", imageUrl: null },
  settings: null,
};

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Keybr — Typing Practice</title>
${cssFiles.map((f) => `<link rel="stylesheet" href="${f}" />`).join("\n")}
<script>var __PAGE_DATA__ = ${JSON.stringify(pageData)};</script>
<script>var __GITHUB_TOKEN__ = ${JSON.stringify(githubToken)};</script>
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
console.log("GitHub sync:", githubToken ? "enabled" : "disabled (no token)");
