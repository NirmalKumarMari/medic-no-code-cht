import fs from "node:fs/promises";
import { z } from "zod";
import {
  BaselineSnapshotSchema,
  ChangePlanSchema,
  EditChangeRequestSchema,
} from "./schema.js";
import {
  CHT_CONVENTIONS_PRIMER,
  PRIMER_HASH,
  PRIMER_VERSION,
} from "./primer.js";
import { fixture } from "./fixture.js";
await fs.mkdir("schemas", { recursive: true });
await fs.mkdir("examples", { recursive: true });
for (const [name, schema] of [
  ["baseline-snapshot", BaselineSnapshotSchema],
  ["change-plan", ChangePlanSchema],
  ["edit-change-request", EditChangeRequestSchema],
] as const)
  await fs.writeFile(
    `schemas/${name}.schema.json`,
    JSON.stringify(z.toJSONSchema(schema), null, 2) + "\n",
  );
await fs.writeFile("examples/cht-primer.txt", CHT_CONVENTIONS_PRIMER);
await fs.writeFile(
  "examples/primer-manifest.json",
  JSON.stringify({ version: PRIMER_VERSION, sha256: PRIMER_HASH }, null, 2) +
    "\n",
);
const f = fixture();
for (const [name, data] of [
  ["edit-request.fixture", f.request],
  ["baseline.fixture", f.baseline],
])
  await fs.writeFile(
    `examples/${name}.json`,
    JSON.stringify(data, null, 2) + "\n",
  );
