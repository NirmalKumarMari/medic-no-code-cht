const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const harnessPath = process.env.VERA_HARNESS ?? '/opt/vera/node_modules/cht-conf-test-harness';
const requireHarness = createRequire(require.resolve(harnessPath));
const resolver = requireHarness.resolve('puppeteer-chromium-resolver');
const puppeteer = createRequire(resolver)('puppeteer-core');
require.cache[resolver] = { exports: async () => ({
  puppeteer, executablePath: process.env.VERA_CHROMIUM ?? '/usr/bin/chromium',
}) };
const Harness = require(harnessPath);
const { assessment, followUp, inputs } = require(path.resolve('VERA-BUILD.json'));
const tests = require(path.resolve('vera-harness-cases.json'));
(async () => {
  const harness = new Harness({ directory: process.cwd(), headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking'], logFormErrors: false });
  try {
    await harness.start();
    for (const [i, test] of tests.entries()) {
      await harness.clear();
      await harness.setNow("2025-01-01");
      const answers = Object.entries(inputs).map(([id, input]) => {
        const raw = test.inputs[id];
        const normalized = raw === true ? 'yes' : raw === false ? 'no' : String(raw);
        return input.choices ? input.choices[normalized] : normalized;
      });
      const result = await harness.fillForm(assessment, answers);
      assert.equal(result.errors.length, 0, `Case ${i + 1}: ${JSON.stringify(result.errors)}`);
      assert.equal(result.report?.fields?.vera_action, test.action, `Case ${i + 1}: action mismatch`);
      if (test.followUp) {
        await harness.flush(test.followUp.dueInDays);
        const tasks = await harness.getTasks();
        assert.equal(tasks.length, 1, `Case ${i + 1}: expected one follow-up task`);
        assert.equal(tasks[0].emission.actions[0]?.form, followUp, `Case ${i + 1}: follow-up form mismatch`);
      } else {
        assert.equal((await harness.getTasks()).length, 0, `Case ${i + 1}: unexpected follow-up task`);
      }
      if (test.rule) assert.equal(result.report?.fields?.vera_rule, test.rule, `Case ${i + 1}: rule mismatch`);
    }
  } finally {
    await harness.stop();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
