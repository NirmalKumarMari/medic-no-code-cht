# Current AWS storage verification

The primary review runtime is deployed on the existing workshop EC2 instance with HTTPS through the workshop proxy. The current demo uses one shared program-officer account without sign-in; Cognito is retained as an optional mode (`REVIEW_AUTH_MODE=cognito`). Its default storage is real DynamoDB and versioned SSE-KMS S3. Local storage remains an explicitly selected development/test mode. The integration is maintained on `combined(db+ui)`.

- Review URL: https://d3kk07plry56g2.cloudfront.net/absproxy/5173/
- EC2: i-04f06fd9fd07305b3; systemd services vera-review-worker and vera-review-gateway.
- Bucket: breakingbarriersstorage-artifacts82dd59a1-ow9zxcaqqtgq.
- Existing DynamoDB tables: vera-workflow-Changes, Approvals, Audit, Tokens.
- CloudFormation: BreakingBarriersStorage and VeraReviewAccess created.
- A real Cognito officer saved a draft from the browser and it appeared in the AWS-backed list. A separate API save was verified directly in DynamoDB and S3, including actual VersionId, SSE-KMS and enabled versioning.
- A synthetic PDF uploaded through the authenticated API and downloaded byte-for-byte unchanged; it has an actual S3 VersionId. The automated browser file chooser needs the Chrome extension's file-URL permission, so browser-level PDF upload is not claimed verified.
- Full suite: 157 tests passed.

## Requirement coverage and remaining gaps

| Area | Current status |
|---|---|
| Demo access and tenant/role checks | Shared server-owned demo account; individual Cognito login optional. Demo mode cannot submit workflow decisions. |
| Form fields, saved drafts, reload, revisions | AWS-backed; browser save and cloud read verified. |
| Original guideline PDFs and versions | S3/DynamoDB backend and UI implemented; original byte download verified via API. |
| Actual content-review decisions | Existing hash-bound repository integrated and covered by integration tests; no real Step Functions approval wait exists yet. |
| Change history | Read API/UI implemented in source; deployed and observed in the shared demo; real pipeline records still need acceptance verification. |
| Deploy-review UI and flag acknowledgements | Repository acknowledgement support added; full UI integration remains unfinished. |
| Start requests, workflow promotion, hand-edit revision forwarding | Requires the actual orchestrator/worker integration; no fake execution IDs or task tokens created. |
| Escalation resolution and rollback controls | Not yet implemented in the review UI. |
| Complete review-ui-approvals requirements spec | Not complete. Do not describe the entire spec as finished. |

No old local demo records were silently imported as clinical workflow records. Cognito synthetic test login details are held outside the repository under ~/.aws/vera-workshop/review-test-users.json. Runtime IAM uses a scoped worker role and the EC2 instance credential provider; no long-lived AWS keys are deployed to EC2 or exposed to the browser.

A failed first storage-stack attempt had a tag-case collision. It was removed; its newly created unused KMS key was scheduled for cancellable deletion after seven days. Existing workflow tables/data were unchanged.

## Shared demo hosting

The app route `/absproxy/5173/` proxies directly through nginx to the review gateway on loopback port 5173, bypassing the workshop editor login for this route only. The editor itself keeps its password. CloudFront cached redirects were invalidated. The demo principal is `demo-program-officer`, with only `program_officer` access in `REVIEW_DEMO_TENANT` (default `workshop-049197632966`). Anyone with the app URL shares that workspace and can save drafts/PDFs; use public or synthetic content. DynamoDB, versioned S3, KMS and Guardrail remain enabled. Verified unauthenticated app/session, existing draft list and PDF metadata loads after deployment.
