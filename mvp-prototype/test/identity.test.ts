import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUuid } from "@vera/review-model/data/identity";

test("request identities work without the secure-context randomUUID API", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
  const getRandomValues = globalThis.crypto.getRandomValues.bind(
    globalThis.crypto,
  );
  try {
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { getRandomValues },
    });
    const values = Array.from({ length: 100 }, () => randomUuid());
    for (const value of values)
      assert.match(
        value,
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
      );
    assert.equal(new Set(values).size, values.length);
  } finally {
    Object.defineProperty(globalThis, "crypto", descriptor);
  }
});
