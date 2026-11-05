# Cost Analysis — No-Code CHT Configuration

Prepared for Medic. Three scales: the current pilot build, a traffic spike, and an illustrative multi-deployment production scale. Figures are deliberately conservative — built from worst-case-leaning assumptions, not the most favorable numbers the architecture could produce — so they represent a realistic ceiling to plan against, not a best case.

**Assumptions stated explicitly:**
- On-Demand pricing only — no Savings Plans, Reserved Instances, or Free Tier discounts.
- Region: US West (Oregon), `us-west-2`.
- Model: a Haiku-tier Claude model on Amazon Bedrock, escalating to a Sonnet-tier model whenever a drafted result fails validation and needs a repair pass.
- Guideline length: ~15,000 tokens per document (a full, detailed clinical guideline chapter, not a short excerpt) — a conservative, longer-than-typical estimate.
- Retry overhead: 30% of runs are assumed to need one schema-repair/escalation pass, adding roughly half again as many tokens to that run.
- Compute: both EC2 instances (one for the application/agent services, one for the test environment) running continuously, 24/7, with no scheduled shutdown — the conservative assumption, since an early pilot is often left running rather than actively managed.
- Encryption: a customer-managed KMS key backs the S3 storage, which carries its own minimum monthly cost independent of usage — easy to miss, included here.

---

## 1. Current Pilot-Scale Cost

Estimated for one clinical pathway, one deployment, a modest pilot volume of 20 configuration changes per month.

| Component | Usage (conservative estimate) | Monthly cost |
|---|---|---|
| Bedrock — Intake step | ~1,500 input / ~800 output tokens (ceiling: the request text and output fields at their schema maximum length) × 20 runs, +30% retry overhead | ~$0.20 |
| Bedrock — Drafting step | ~15,000 input / ~2,500 output tokens × 20 runs, +30% retry overhead | ~$0.95 |
| DynamoDB (on-demand) | ~600–800 requests/month | <$0.01 |
| Amazon S3 (storage) | Guidelines, snapshots, reports accumulating | ~$0.05 |
| AWS KMS (customer-managed key) | Flat monthly key fee + request charges | ~$1.50 |
| EC2 — application/agent instance | 730 hrs/month, continuous | ~$121.50 |
| EC2 — test environment instance | 730 hrs/month, continuous | ~$60.75 |
| **Total** | | **~$185/month** |

**The dominant cost is the always-on compute, not the AI.** The two EC2 instances running continuously account for roughly 98% of the monthly total; the Bedrock, storage, and database costs together are under $3/month even at this ceiling-level token estimate. Running the AI model more, or on a longer guideline, barely moves this number — the number that matters is whether the compute is left running continuously or only when actually needed.

**Note on EC2:** EC2 was used for the application and agent compute in this phase of the project because it was a specified platform requirement for this engagement, not because it was the most cost-effective option available. It is the right choice for a single, closely-managed deployment where straightforward operation matters more than minimizing idle cost. As usage grows, moving this compute to an option that scales down automatically when idle — rather than running continuously regardless of load — would reduce this cost further, likely substantially, without changing anything about what the solution does. This is expanded on in §3's "What needs to change as usage grows" below.

**Known gap:** these figures are derived from the actual Intake and Drafting components' real token usage patterns, not yet measured from a complete, automated end-to-end run, since the piece that connects every step together end to end is still being finished. Once it is, replace this estimate with real per-run token counts (Bedrock reports exact usage on every call) rather than carrying an estimate forward indefinitely.

---

## 2. Cost Under a Traffic Spike

A spike here means a burst of configuration-change requests arriving close together — for example, many pathways resubmitted at once after a clinical guideline update.

| Component | Behavior under a spike | Cost impact |
|---|---|---|
| Bedrock | Scales per request automatically, no pre-provisioning | 50 requests in an hour ≈ ~$2.50, trivial |
| DynamoDB (on-demand) | Scales automatically | Negligible, well under $0.01 for the burst |
| Amazon S3 | Scales automatically | Negligible |
| Test/validation environment | **Does not scale** — one isolated, fresh environment processes one change at a time by design, for safety | $0 additional cost, but a real queue |
| Application/agent instance | Fixed capacity for its size | $0 additional cost until the instance itself is saturated |

**The constraint in a spike is wait time, not spend.** If validating and testing one change takes several minutes and only one can run at a time, fifty requests arriving within an hour means the back half of that queue could wait well over an hour before its own validation even starts — with no corresponding increase in the AWS bill, since the instance is already being paid for whether it is busy or idle. A conservative plan should budget for this as a responsiveness risk to resolve (see §3's "What needs to change as usage grows" below), not assume it will simply be absorbed.

---

## 3. Illustrative Production Scale

No confirmed volume target exists yet for a multi-deployment rollout. For planning purposes, this illustration assumes **500 configuration changes per month across 10 ministry deployments** (~50/month per deployment) — a number to replace with a real figure once one is available, not a commitment.

### Cost if today's always-on compute model is carried forward unchanged

| Component | Monthly usage | Monthly cost |
|---|---|---|
| Bedrock (Intake + Drafting, with retry overhead, ceiling token usage) | 500 runs × ~$0.06/run | ~$30 |
| DynamoDB (on-demand) | ~15,000 requests/month | ~$0.25 |
| Amazon S3 | Guidelines, snapshots, reports across 10 deployments | ~$5 |
| AWS KMS | 10 customer-managed keys, one per deployment | ~$15 |
| EC2, both instances, continuous, **per deployment** | 730 hrs/month × combined ~$0.25/hr | ~$182.25/deployment |
| EC2 total across 10 deployments (each fully isolated) | | ~$1,822.50 |
| **Total** | | **~$1,873/month** |

**AI and data costs stay just over $50/month even at this scale — the always-on compute model is the entire cost story.** It accounts for roughly 97% of the total, and critically, it is the only line item that grows directly with the number of deployments rather than with how much they are actually used. A deployment handling 50 changes a month is, in practice, idle for the overwhelming majority of each billing period, yet is charged as if it ran continuously.

### What needs to change as usage grows — architecture, not just cost

1. **Move the always-on compute to a model that scales down when idle.** Continuous EC2 is a reasonable, deliberate choice for a single, closely-managed pilot deployment; it is not an efficient choice once there are multiple deployments each running well below capacity most of the time. A compute option that scales to near-zero between active requests would turn the largest line item above into one that tracks actual usage instead of wall-clock time.
2. **Add queuing in front of the validation/test environment before it becomes a bottleneck.** The requirement that each change gets a fresh, isolated validation environment is a safety property worth keeping exactly as-is; what should change is having more than one environment able to pick up the next item when the first is busy, so volume growth shows up as controlled, predictable wait time rather than an unbounded queue.
3. **Decide data isolation per deployment deliberately, before scaling to many of them.** Each deployment's guidance and approval history should stay separate from every other's. Isolating each deployment into its own account or boundary, as assumed in the table above, is the safer default — but it should be a considered decision, not an accident of how the first deployment happened to be built.
4. **Confirm model-service request limits ahead of a real rollout.** Any per-account limit on request or token volume should be checked and, if needed, increased before multiple deployments are running simultaneously — not discovered during one.

### Summary

**At this illustrative scale, AI and data costs remain modest — well under $50 a month.** The cost that actually matters is the always-on compute model, which is appropriate for a single pilot and increasingly inefficient the more deployments run on it simultaneously. Addressing that is a capacity-planning decision, not a question of whether the solution itself is affordable to run.

---

## Sources

1. Amazon Bedrock Pricing — https://aws.amazon.com/bedrock/pricing/ (confirm current token rates for the chosen model and region before relying on these figures)
2. Amazon EC2 On-Demand Pricing — https://aws.amazon.com/ec2/pricing/on-demand/
3. Amazon DynamoDB On-Demand Pricing — https://aws.amazon.com/dynamodb/pricing/on-demand/
4. Amazon S3 Pricing — https://aws.amazon.com/s3/pricing/
5. AWS KMS Pricing — https://aws.amazon.com/kms/pricing/
