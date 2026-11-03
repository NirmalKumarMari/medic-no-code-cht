import { readFile, writeFile } from "node:fs/promises";
import ts from "typescript";
import { sha256 } from "../src/artifacts.js";
// Pinned CHT commits; CDC page export is pinned by content digest in catalog.json.
const path = "config/default/tasks.js";
const url =
  "https://raw.githubusercontent.com/medic/cht-core/ac1d70cb8ea1f5b39c8d78c4ead03bd1814eddf9/" +
  path;
const response = await fetch(url);
if (!response.ok) throw Error("Download failed");
const raw = await response.text();
const file = ts.createSourceFile(
  path,
  raw,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
let array: ts.ArrayLiteralExpression | undefined;
for (const node of file.statements)
  if (
    ts.isExpressionStatement(node) &&
    ts.isBinaryExpression(node.expression) &&
    node.expression.left.getText(file) === "module.exports" &&
    ts.isArrayLiteralExpression(node.expression.right)
  )
    array = node.expression.right;
if (!array) throw Error("Expected task array");
const task = array.elements.find(
  (n) =>
    ts.isObjectLiteralExpression(n) &&
    n.properties.some(
      (p) =>
        ts.isPropertyAssignment(p) &&
        p.name.getText(file) === "name" &&
        p.initializer.getText(file) ===
          "'pnc.danger_sign_followup_baby.from_report'",
    ),
);
if (!task) throw Error("Task missing");
await writeFile(
  "examples/sources/cht-reference-task.js",
  task.getText(file) + "\n",
);
const entries = [
  {
    file: "cdc-hand-hygiene.txt",
    format: "txt",
    sourceType: "guideline",
    sourceId: "cdc-core-hand-hygiene",
    version: "2024-04-12",
    section: "5a. Hand Hygiene",
    path: "infection-control/hcp/core-practices/index.html#5a",
    url: "https://www.cdc.gov/infection-control/hcp/core-practices/index.html",
    extraction:
      "Complete 5a table row, including recommendations and comments. HTML tags removed; entities decoded.",
  },
  {
    file: "cht-tasks-introduction.md",
    format: "md",
    sourceType: "cht-docs",
    sourceId: "cht-tasks-introduction",
    version: "85ae1e6a27e127834b755b470143c3119d46102d",
    section: "Tasks introduction",
    path: "content/en/building/tasks/tasks-js.md",
    url: "https://raw.githubusercontent.com/medic/cht-docs/85ae1e6a27e127834b755b470143c3119d46102d/content/en/building/tasks/tasks-js.md",
    extraction:
      "Introduction after figure and before see-also shortcode. No table split.",
  },
  {
    file: "cht-reference-task.js",
    format: "js",
    sourceType: "reference-config",
    sourceId: "cht-pnc-task",
    version: "ac1d70cb8ea1f5b39c8d78c4ead03bd1814eddf9",
    section: "pnc.danger_sign_followup_baby.from_report",
    workflow: "pnc",
    path,
    url,
    extraction:
      "Complete task object via TypeScript AST; helper references resolve in original file and nools-extras.js. Reference only; not executable in isolation.",
  },
];
const catalog = [];
for (const e of entries) {
  const bytes = await readFile("examples/sources/" + e.file);
  catalog.push({
    ...e,
    sourceHash: sha256(bytes),
    reviewStatus: "pending-publication-review",
  });
}
await writeFile(
  "examples/sources/catalog.json",
  JSON.stringify(catalog, null, 2) + "\n",
);
