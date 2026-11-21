import { readFileSync, writeFileSync } from "node:fs";

const paths = {
  STYLES: "styles.css",
  PARSER: "parser.js",
  UI: "ui.js",
  VOICE_COMMAND: "voice-command.js"
};
const read = path => readFileSync(new URL("./src/" + path, import.meta.url), "utf8");
const license = readFileSync(new URL("./LICENSE", import.meta.url), "utf8").trimEnd();
const page = read("page.html")
  .replace("APP_LICENSE", () => license)
  .replace(/\/\* (STYLES|PARSER|UI|VOICE_COMMAND) \*\//g, (_, key) => read(paths[key]).trimEnd());
writeFileSync(new URL("./index.html", import.meta.url), page);
