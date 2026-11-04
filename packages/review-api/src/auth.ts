import { CognitoJwtVerifier } from "aws-jwt-verify";
import type { FastifyRequest } from "fastify";
import { roles, type HumanContext } from "@vera/workflow-data";
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export interface Principal {
  subject: string;
  groups: HumanContext["groups"];
  tenants: string[];
}
export type Authenticate = (request: FastifyRequest) => Promise<Principal>;
export function cognitoAuthenticator(
  userPoolId: string,
  clientId: string,
  memberships: Record<string, string[]>,
): Authenticate {
  const verifier = CognitoJwtVerifier.create({
    userPoolId,
    clientId,
    tokenUse: "access",
  });
  return async (request) => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer "))
      throw new HttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
    let payload;
    try {
      payload = await verifier.verify(header.slice(7));
    } catch {
      throw new HttpError(
        401,
        "UNAUTHENTICATED",
        "Your session is invalid or expired. Sign in again.",
      );
    }
    const groups = (payload["cognito:groups"] ?? []).filter(
      (g): g is (typeof roles)[number] =>
        roles.includes(g as (typeof roles)[number]),
    );
    const tenants = memberships[payload.sub] ?? [];
    if (!groups.length || !tenants.length)
      throw new HttpError(
        403,
        "FORBIDDEN",
        "Your account has no configured Vera access.",
      );
    return { subject: payload.sub, groups, tenants };
  };
}
