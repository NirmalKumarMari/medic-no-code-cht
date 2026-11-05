# Isolated pipeline preview

- Preview: https://d3kk07plry56g2.cloudfront.net/vera-preview/
- Original demo: https://d3kk07plry56g2.cloudfront.net/absproxy/5173/
- Completed native CHT release: https://d3kk07plry56g2.cloudfront.net/vera-preview/?run=3dc2280e-9b3c-4e3b-b1bb-83e2614ddae7
- Completed synthetic edit: https://d3kk07plry56g2.cloudfront.net/vera-preview/?run=747e06f3-91f2-40a5-bea3-4fffc42f71da
- Uploaded PDF awaiting content review: https://d3kk07plry56g2.cloudfront.net/vera-preview/?run=f65aae65-2596-4bc9-9e1c-529c9f92b961

Start as **Program officer**, select a synthetic or public guideline, and submit. At `content_review`, switch to **Clinician reviewer** and open the snapshot. At `deploy_review`, switch to **Release reviewer** to see tests, artifact digest and any flags. New releases offer a compiled CHT project ZIP and a versioned JSON decision package. Demo personas simulate reviewers for synthetic tests.

The original demo keeps its own URL, tables, bucket and services. The preview runs separate systemd services under `/workshop/vera-preview` with its own queue, state machine, storage and IAM permissions. The new `/vera-preview/api/*` CloudFront behavior disables API caching. The EC2 worker invokes Bedrock directly. The preview uses demo personas and both decisions resume Step Functions waits through the callback dispatcher.

Synthetic new-pathway and wording-edit executions passed both gates and downloaded verified packages. The PDF source was retrieved byte-for-byte and its workflow reached the clinician gate. New builds compile CHT configuration and run the Medic test harness inside a pinned, offline container. The preview also checks branch coverage and supplied golden cases. The release ends with the downloadable project. A hosted CHT instance would be required for upload, phone sync, and rollback.
