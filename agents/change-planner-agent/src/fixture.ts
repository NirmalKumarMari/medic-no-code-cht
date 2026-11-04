import {
  computeSnapshotHash,
  sha256,
  type LogicModel,
  type SnapshotBundle,
} from "./logicModel.js";
import {
  CHT_CONVENTIONS_PRIMER,
  PRIMER_HASH,
  PRIMER_VERSION,
} from "./primer.js";
import type { BaselineSnapshot } from "./schema.js";
export function fixture() {
  const text =
    "SYNTHETIC GUIDELINE FOR TESTS ONLY. Section follow-up: schedule a follow-up in two days and keep its task open for seven days. This is not clinical guidance.";
  const quote =
    "schedule a follow-up in two days and keep its task open for seven days.";
  const logic: LogicModel = {
    schemaVersion: "logic-model/v1",
    snapshotId: "baseline-1",
    pathway: "Synthetic follow-up",
    guideline: { name: "Synthetic testing guideline", version: "1" },
    inputs: [
      { id: "danger_sign", type: "yes_no", label: "Any danger sign?" },
      { id: "notes", type: "text", label: "Notes" },
    ],
    rules: [
      {
        id: "referral",
        when: { input: "danger_sign", eq: "yes" },
        then: { action: "refer_urgently" },
        followUp: { dueInDays: 3, openForDays: 7 },
        source: { section: "follow-up", page: 1 },
      },
      {
        id: "default",
        when: { otherwise: true },
        then: { action: "home_care_advice" },
        source: { section: "fixture-existing", page: 1 },
      },
    ],
    flags: [],
  };
  const guidelineRef = {
    bucket: "fixture-only",
    key: "docs/guideline.txt",
    versionId: "synthetic-v1",
    sha256: sha256(text),
    contentType: "text/plain",
  };
  const hashInputs: SnapshotBundle = {
    schemaVersion: "logic-model/v1",
    baselineRevision: "synthetic-root",
    spec: JSON.parse(JSON.stringify(logic)),
    evidenceVersions: [
      {
        sourceId: "synthetic-guideline",
        version: "1",
        sha256: sha256(text),
        sourceS3Ref: guidelineRef,
      },
    ],
    retrievalEvidenceRefs: [],
    goldenCaseVersion: "synthetic-cases-v1",
    compilerVersion: "fixture-only",
    toolchainImageDigest: "sha256:" + "a".repeat(64),
  };
  const source = {
    sourceId: "cht-conventions-primer",
    version: PRIMER_VERSION,
    sourceHash: PRIMER_HASH,
    sourceS3Ref: {
      bucket: "fixture-only",
      key: "docs/primer.txt",
      versionId: "synthetic-v1",
      sha256: PRIMER_HASH,
      contentType: "text/plain",
    },
    provenanceRef: {
      bucket: "fixture-only",
      key: "docs/primer-provenance.json",
      versionId: "synthetic-v1",
      sha256: "b".repeat(64),
      contentType: "application/json",
    },
  };
  const plannerContext = {
    text: CHT_CONVENTIONS_PRIMER,
    source,
    contextHash: sha256(
      JSON.stringify({
        mode: "change_planner",
        source,
        text: CHT_CONVENTIONS_PRIMER,
      }),
    ),
    evidenceRef: {
      bucket: "fixture-only",
      key: "reports/demo-edit-1/context/baseline-1/request-1.json",
      versionId: "synthetic-v1",
      sha256: "c".repeat(64),
      contentType: "application/json",
    },
  };
  const baseline: BaselineSnapshot = {
    logicModel: logic,
    snapshotHash: computeSnapshotHash(hashInputs),
    hashInputs,
    plannerContext,
    guideline: {
      sourceId: "synthetic-guideline",
      version: "1",
      sha256: sha256(text),
      text,
    },
  };
  const request = {
    changeId: "demo-edit-1",
    requestKind: "plain_language_edit" as const,
    pathway: logic.pathway,
    guideline: logic.guideline,
    editText:
      "Change referral follow-up due time from 3 days to 2 days; keep the seven day window.",
    submittedBy: {
      role: "program_officer" as const,
      userId: "synthetic-author",
    },
    baselineSnapshotHash: baseline.snapshotHash,
  };
  const proposal = {
    proposedLogicModel: {
      ...structuredClone(logic),
      rules: [
        {
          ...structuredClone(logic.rules[0]!),
          followUp: { dueInDays: 2, openForDays: 7 },
        },
        structuredClone(logic.rules[1]!),
      ],
    },
    citationQuotes: [{ ruleId: "referral", quote }],
    rationale: "Change only the explicitly requested due time.",
    flags: [],
  };
  return { baseline, request, proposal };
}
