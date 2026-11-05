// TEMPORARY: creates the demo accounts for REVIEW_AUTH_MODE=password. Writes two
// git-ignored files: server settings (password hashes only) and the passwords to
// share with the team. Run again to replace all of the passwords.
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { hashPassword } from "../src/demo-sign-in.js";

const tenant = process.argv[2] ?? process.env.REVIEW_DEMO_TENANT ?? "workshop-049197632966";
const people = [
  { email: "officer@vera.test", groups: ["program_officer"] },
  { email: "clinician@vera.test", groups: ["clinician"] },
  { email: "it@vera.test", groups: ["it_deploy"] },
];
const passwords: string[] = [];
const accounts = [];
for (const person of people) {
  const password = randomBytes(12).toString("base64url");
  passwords.push(`${person.email}  ${password}`);
  accounts.push({ ...person, tenants: [tenant], passwordHash: await hashPassword(password) });
}
const path = (name: string) => fileURLToPath(new URL(`../${name}`, import.meta.url));
await writeFile(
  path(".env.demo-sign-in"),
  `REVIEW_AUTH_MODE=password\nREVIEW_DEMO_ACCOUNTS='${JSON.stringify(accounts)}'\n`,
  { mode: 0o600 },
);
await writeFile(path(".env.demo-passwords"), `${passwords.join("\n")}\n`, { mode: 0o600 });
console.log(`Created ${people.length} demo accounts for ${tenant}.`);
console.log("Server settings: packages/review-api/.env.demo-sign-in");
console.log("Passwords:       packages/review-api/.env.demo-passwords");
