/**
 * Small event glue (explicitly allowed per the design doc's disallow list:
 * "Lambda stays allowed for small event glue only"). This is the one and
 * only way the state machine calls out to a worker container's HTTP
 * endpoint — Intake, Draft, LogicChecks, Compile, BuildTest, HistoryCheck,
 * and Deploy are all invoked the same way, through this function.
 *
 * On a non-2xx response this throws, so a Step Functions `Catch` can route
 * the failure — it never swallows a worker error.
 */
export interface InvokeWorkerEvent {
  workerUrl: string;
  body: unknown;
}

export async function handler(event: InvokeWorkerEvent): Promise<unknown> {
  const response = await fetch(event.workerUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event.body ?? {}),
  });

  const text = await response.text();
  let parsedBody: unknown;
  try {
    parsedBody = text ? JSON.parse(text) : {};
  } catch {
    parsedBody = text;
  }

  if (!response.ok) {
    const detail = typeof parsedBody === "string" ? parsedBody : JSON.stringify(parsedBody);
    throw new Error(`Worker at ${event.workerUrl} returned ${response.status}: ${detail}`);
  }

  return parsedBody;
}
