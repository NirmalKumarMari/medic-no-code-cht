import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { config } from "./config.js";
import type { StructuredSpec } from "./schema.js";

/**
 * The Intake Agent's ONLY side effect is an idempotent draft spec-store write.
 * Per the revised Agent Roster (design §7, ADR-011) it has NO retrieval / KB
 * tool — the guideline is not searched at intake. Nothing else is exposed, by
 * construction: there is no approve, compile, upload, or memory write here.
 */
export interface Tools {
  /**
   * Writes an idempotent DRAFT record — never an approval, never a config
   * file. Safe to call more than once with the same changeId; later calls
   * overwrite the draft, not an approved record (approvals are append-only and
   * written only by orchestrator code — see design doc section 9).
   */
  writeSpecDraft(spec: StructuredSpec): Promise<void>;
}

export function createDirectTools(): Tools {
  const s3 = new S3Client({ region: config.region });
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.region }));

  return {
    async writeSpecDraft(spec) {
      const key = `${config.storage.specsPrefix}${spec.changeId}.json`;

      await s3.send(
        new PutObjectCommand({
          Bucket: config.storage.specsBucket,
          Key: key,
          Body: JSON.stringify(spec, null, 2),
          ContentType: "application/json",
          ServerSideEncryption: "aws:kms",
        }),
      );

      await ddb.send(
        new PutCommand({
          TableName: config.storage.changesTable,
          Item: {
            changeId: spec.changeId,
            sk: "spec", // reserved SK; "v#<snapshotId>" rows are written later, by the drafting step
            requestKind: spec.requestKind,
            pathway: spec.pathway,
            specS3Key: key,
            submittedBy: spec.submittedBy,
            status: "spec_drafted",
          },
        }),
      );
    },
  };
}
