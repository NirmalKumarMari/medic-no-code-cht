import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { strToU8, zipSync } from 'fflate';

const run = promisify(execFile);
const zip = files => zipSync(Object.fromEntries(Object.entries(files).map(([path, value]) =>
  [path, typeof value === 'string' ? strToU8(value) : value])), { mtime: new Date(1980, 0, 1) });
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const spreadsheet = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const pkg = 'http://schemas.openxmlformats.org/package/2006';

function workbook(sheets) {
  const entries = Object.entries(sheets);
  const sheetFiles = entries.map((_, i) => `worksheets/sheet${i + 1}.xml`);
  return zip({
    '[Content_Types].xml': `<Types xmlns="${pkg}/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheetFiles.map(file => `<Override PartName="/xl/${file}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`,
    '_rels/.rels': `<Relationships xmlns="${pkg}/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${pkg}/relationships">${sheetFiles.map((file, i) => `<Relationship Id="rId${i + 1}" Type="${rel}/worksheet" Target="${file}"/>`).join('')}</Relationships>`,
    'xl/workbook.xml': `<workbook xmlns="${spreadsheet}" xmlns:r="${rel}"><sheets>${entries.map(([name], i) => `<sheet name="${name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    ...Object.fromEntries(entries.map(([, rows], i) => [`xl/${sheetFiles[i]}`,
      `<worksheet xmlns="${spreadsheet}"><sheetData>${rows.map((row, n) => `<row r="${n + 1}">${row.map((value, col) => `<c r="${String.fromCharCode(65 + col)}${n + 1}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`])),
  });
}

const quote = value => {
  const text = String(value);
  return text.includes("'") ? `concat(${text.split("'").map(part => `'${part}'`).join(`, "'", `)})` : `'${text}'`;
};
const field = name => '${' + name + '}';
function condition(expr, names) {
  if ('otherwise' in expr) return 'true()';
  if ('all' in expr) return `(${expr.all.map(part => condition(part, names)).join(' and ')})`;
  if ('any' in expr) return `(${expr.any.map(part => condition(part, names)).join(' or ')})`;
  if ('not' in expr) return `not(${condition(expr.not, names)})`;
  const input = names.get(expr.input);
  if (!input) throw Error('Native CHT rule refers to an unknown input');
  const ref = field(input.name);
  if ('eq' in expr) {
    const value = typeof expr.eq === 'boolean' ? expr.eq ? 'yes' : 'no' : String(expr.eq);
    const encoded = input.choices ? input.choices.get(value) : value;
    return encoded === undefined ? 'false()' : `(${ref} != '' and ${ref} = ${quote(encoded)})`;
  }
  return `(number(${ref}) ${'gte' in expr ? `>= ${expr.gte}` : `< ${expr.lt}`})`;
}

export function chtSources(model) {
  const suffix = Buffer.from(model.pathway.id).toString('hex').slice(0, 24);
  const assessment = `vera_${suffix}_assessment`;
  const followUp = `vera_${suffix}_follow_up`;
  const surveyHeader = ['type', 'name', 'label', 'required', 'calculation'];
  const survey = [surveyHeader, ['hidden', 'patient_id', '']];
  const choices = [['list_name', 'name', 'label']];
  const names = new Map();
  for (const [index, input] of model.inputs.entries()) {
    const name = `answer_${index + 1}`;
    const list = `choices_${index + 1}`;
    const values = input.type === 'yes_no' ? ['yes', 'no'] : input.type === 'select_one' ? input.choices : undefined;
    const codes = values && new Map(values.map((value, i) => [value, `option_${i + 1}`]));
    names.set(input.id, { name, choices: codes });
    if (codes) for (const [label, code] of codes) choices.push([list, code, label]);
    survey.push([codes ? `select_one ${list}` : input.type, name, input.label, 'yes']);
  }
  const selectedRule = model.rules.reduceRight((next, rule, i) =>
    `if(${condition(rule.when, names)}, 'rule_${i + 1}', ${next})`, "''");
  const action = model.rules.reduceRight((next, rule, i) =>
    `if(${field('vera_rule')} = 'rule_${i + 1}', ${quote(rule.then.action)}, ${next})`, "''");
  survey.push(['calculate', 'vera_rule', '', '', selectedRule], ['calculate', 'vera_action', '', '', action],
    ['note', 'vera_result', `Recommended action: ${field('vera_action')}`]);
  const tasks = model.rules.flatMap((rule, i) => rule.followUp ? [
    `{
      name: '${assessment}_${i + 1}',
      title: 'Vera follow-up',
      appliesTo: 'reports',
      appliesIf: (contact, report) => report.form === '${assessment}' && report.fields?.vera_rule === 'rule_${i + 1}',
      events: [{ days: ${rule.followUp.dueInDays}, start: 0, end: ${rule.followUp.openForDays} }],
      actions: [{ type: 'report', form: '${followUp}' }]
    }`,
  ] : []);
  const settings = (title, id) => [['form_title', 'form_id', 'version'], [title, id, model.snapshotHash?.slice(0, 16) ?? '1']];
  const properties = title => JSON.stringify({ title, context: { person: true, place: false } });
  const files = {
    [`forms/app/${assessment}.xlsx`]: workbook({ survey, choices, settings: settings(model.pathway.title, assessment) }),
    [`forms/app/${assessment}.properties.json`]: properties(model.pathway.title),
    'package.json': JSON.stringify({ private: true, devDependencies: { 'cht-conf': '6.6.1' } }),
    '.eslintrc': JSON.stringify({ env: { node: true, es2022: true }, parserOptions: { ecmaVersion: 2022 } }),
    'translations/messages-en.properties': 'vera.follow_up=Vera follow-up\n',
    'tasks.js': `module.exports = [${tasks.join(',\n')}];\n`,
    'contact-summary.templated.js': 'module.exports = { fields: [], cards: [], context: {} };\n',
    'targets.js': 'module.exports = [];\n',
    'app_settings/base_settings.json': '{}\n',
    'app_settings/forms.json': '{}\n',
    'app_settings/schedules.json': '[]\n',
    'VERA-BUILD.json': JSON.stringify({ snapshotHash: model.snapshotHash, assessment, followUp: tasks.length ? followUp : null,
      inputs: Object.fromEntries([...names].map(([key, item]) => [key, { field: item.name, choices: item.choices && Object.fromEntries(item.choices) }])),
      rules: Object.fromEntries(model.rules.map((rule, i) => [`rule_${i + 1}`, rule.id])) }, null, 2),
  };
  if (tasks.length) {
    files[`forms/app/${followUp}.xlsx`] = workbook({
      survey: [surveyHeader, ['hidden', 'patient_id', ''], ['hidden', 'task_id', ''], ['text', 'follow_up_notes', 'Follow-up notes', 'yes']],
      settings: settings('Vera follow-up', followUp),
    });
    files[`forms/app/${followUp}.properties.json`] = properties('Vera follow-up');
  }
  return files;
}

export async function compileChtProject(model, toolchain, sandbox) {
  const files = chtSources(model);
  const scratch = await mkdtemp(join(tmpdir(), 'vera-cht-'));
  const source = sandbox ? join(scratch, 'input') : scratch;
  const cwd = sandbox ? join(scratch, 'output') : scratch;
  try {
    await mkdir(join(source, 'forms/app'), { recursive: true });
    await mkdir(join(source, 'app_settings'));
    await mkdir(join(source, 'translations'));
    for (const [path, bytes] of Object.entries(files)) await writeFile(join(source, path), bytes);
    if (sandbox) {
      await mkdir(cwd);
      await writeFile(join(source, 'vera-harness-cases.json'), JSON.stringify(sandbox.cases));
      const runner = fileURLToPath(new URL('./preview-cht-harness.cjs', import.meta.url));
      const name = `vera-cht-${randomUUID()}`;
      try {
        await run('/usr/bin/docker', ['run', '--rm', '--name', name, '--pull', 'never',
          '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
          '--user', `${process.getuid()}:${process.getgid()}`, '--pids-limit', '256', '--memory', '1g',
          '--env', 'HOME=/tmp', '--workdir', '/out',
          '--mount', `type=bind,src=${source},dst=/in,readonly`,
          '--mount', `type=bind,src=${cwd},dst=/out`,
          '--mount', `type=bind,src=${runner},dst=/runner.cjs,readonly`,
          '--entrypoint', '/bin/sh', sandbox.image, '-ec',
          'cp -R /in/. /out && cht --no-check convert-app-forms && cht --no-check compile-app-settings && node /runner.cjs',
        ], { timeout: 75_000 });
      } finally {
        await run('/usr/bin/docker', ['rm', '-f', name], { timeout: 5_000 }).catch(() => {});
      }
    } else {
      const env = { PATH: [join(toolchain, 'python/bin'), dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(delimiter), HOME: cwd };
      const cht = join(toolchain, 'node_modules/.bin/cht');
      for (const action of ['convert-app-forms', 'compile-app-settings']) {
        await run(cht, ['--no-check', action], { cwd, env, timeout: 35_000 });
      }
    }
    for (const path of await readdir(join(cwd, 'forms/app'))) {
      if (path.endsWith('.xml')) files[`forms/app/${path}`] = await readFile(join(cwd, 'forms/app', path));
    }
    for (const path of Object.keys(files).filter(path => path.endsWith('.xlsx'))) {
      if (!files[path.replace(/\.xlsx$/, '.xml')]) throw Error('CHT Conf did not produce an XForm');
    }
    files['app_settings.json'] = await readFile(join(cwd, 'app_settings.json'));
    if (sandbox) files['VERA-HARNESS.json'] = JSON.stringify({ passed: true, testCases: sandbox.cases.length, image: sandbox.image });
    return zip(files);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
