// TEMPORARY sign-in for hackathon demos, used only when REVIEW_AUTH_MODE=password.
// It gives each demo person their own identity and role without Cognito. Sessions
// live in memory, so restarting the server signs everyone out. Not for real use.
// To remove it, follow "Temporary password sign-in" in this package's README.
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";
import { roles } from "@vera/workflow-data";
import { HttpError, type Authenticate, type Principal } from "./auth.js";

const derive = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  length: number,
) => Promise<Buffer>;
const KEY_LENGTH = 32;
const SESSION_MS = 8 * 60 * 60 * 1000;

const accountsSchema = z
  .array(
    z.object({
      email: z.string().email(),
      passwordHash: z.string().regex(/^[0-9a-f]{32}\$[0-9a-f]{64}$/),
      groups: z.array(z.enum(roles)).min(1),
      tenants: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/)).min(1),
    }),
  )
  .min(1);
export const signInSchema = z.object({
  email: z.string().trim().max(254),
  password: z.string().max(256),
});
export type DemoAccount = z.infer<typeof accountsSchema>[number];

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = await derive(password, salt, KEY_LENGTH);
  return `${salt.toString("hex")}$${key.toString("hex")}`;
}
async function matches(password: string, stored: string) {
  const [salt, key] = stored.split("$");
  const actual = await derive(password, Buffer.from(salt, "hex"), KEY_LENGTH);
  return timingSafeEqual(actual, Buffer.from(key, "hex"));
}

export class DemoSignIn {
  private readonly accounts: Map<string, DemoAccount>;
  private readonly sessions = new Map<string, { principal: Principal; expires: number }>();
  // Compared against for unknown emails, so they take as long as wrong passwords.
  private readonly decoy = hashPassword(randomBytes(16).toString("hex"));

  constructor(
    accounts: unknown,
    private readonly now: () => number = Date.now,
  ) {
    this.accounts = new Map(
      accountsSchema.parse(accounts).map((a) => [a.email.toLowerCase(), a]),
    );
  }

  signIn = async (email: string, password: string): Promise<string> => {
    const account = this.accounts.get(email.toLowerCase());
    const correct = await matches(password, account?.passwordHash ?? (await this.decoy));
    if (!account || !correct)
      throw new HttpError(401, "INVALID_SIGN_IN", "Check your email and password.");
    for (const [token, session] of this.sessions)
      if (session.expires <= this.now()) this.sessions.delete(token);
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, {
      principal: {
        subject: account.email.toLowerCase().replace(/[^a-z0-9_.-]/g, "-"),
        groups: account.groups,
        tenants: account.tenants,
      },
      expires: this.now() + SESSION_MS,
    });
    return token;
  };

  authenticate: Authenticate = async (request) => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer "))
      throw new HttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
    const session = this.sessions.get(header.slice(7));
    if (!session || session.expires <= this.now())
      throw new HttpError(401, "UNAUTHENTICATED", "Your session has expired. Sign in again.");
    return session.principal;
  };
}
