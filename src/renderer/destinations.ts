import { getLanguage, t } from '../shared/i18n/index.ts';
import type { FolderRule } from '../shared/naming.ts';
import { amPmAt, DEFAULT_AMPM, expandSubfolder, matchSubfolder, subfolderFields, usesAmPm, usesDateTime, type AmPmChoice, type AmPmText } from '../shared/subfolders.ts';
import { filenameProblem } from '../shared/validate.ts';
import { openModal } from './dialogs.ts';
import { h, pathText } from './dom.ts';

const folderName = (dir: string) => dir.replace(/[\\/]+$/, '').replace(/^.*[\\/]/, '') || dir;
/** Joins with the separator the folder already uses. */
const joinPath = (dir: string, name: string) => {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return `${dir.replace(/[\\/]+$/, '')}${sep}${name}`;
};
const pad2 = (v: number) => String(v).padStart(2, '0');
const NEW = '\0new';
const NONE = '\0none';

/** One rule's place in the dialog: whether it is chosen, and where inside it the files go. */
interface Choice {
  rule: FolderRule;
  check: HTMLInputElement;
  /** The folder the files go to, or an error to show; null while not chosen. */
  result(): { dir: string } | { error: string } | null;
}

/**
 * Asks which folders the files of a newly opened WAV go to. Rules with a subfolder template get
 * a new folder named from the recording's start and the fields typed here, an existing one, or
 * none. Resolves to the folders (the first is the default), or null for "No folder": the files
 * then go next to the WAV as before.
 */
export function chooseDestinations(
  rules: readonly FolderRule[],
  start: Date,
  lastChosen: readonly string[],
  /** Adding one rule's folder later: no checkbox or note, and the dismiss button just cancels. */
  opts: { adding?: boolean } = {},
): Promise<{ dirs: string[]; chosen: string[] } | null> {
  return new Promise((resolve) => {
    let answer: { dirs: string[]; chosen: string[] } | null = null;
    const m = openModal(t('dlg.dest.title'), { onClose: () => resolve(answer) });
    const error = h('div', { class: 'form-note err' });

    // The recording's start, editable in case the file's time is off (a copied file, for example).
    const dateInput = h('input', { type: 'date', value: `${start.getFullYear()}-${pad2(start.getMonth() + 1)}-${pad2(start.getDate())}` });
    const timeInput = h('input', { type: 'time', value: `${pad2(start.getHours())}:${pad2(start.getMinutes())}` });
    const when = () => {
      const [y, mo, d] = dateInput.value.split('-').map(Number);
      const [hh, mi] = timeInput.value.split(':').map(Number);
      const date = new Date(y, mo - 1, d, hh || 0, mi || 0);
      return Number.isNaN(date.getTime()) ? start : date;
    };
    const updaters: (() => void)[] = [];
    const update = () => {
      error.textContent = '';
      updaters.forEach((u) => u());
    };
    dateInput.oninput = update;
    timeInput.oninput = update;

    const choices = rules.map((rule) => ruleChoice(rule, opts.adding || lastChosen.includes(rule.id), when, update, updaters));
    if (opts.adding) choices.forEach((c) => (c.choice.check.hidden = true));
    const anyDateTime = rules.some((r) => r.subfolder && usesDateTime(r.subfolder));

    m.body.append(
      opts.adding ? '' : h('div', { class: 'form-note' }, t('dlg.dest.note')),
      ...(anyDateTime
        ? [h('div', { class: 'form-grid dest-when' }, h('label', {}, t('dlg.dest.start')), h('div', { class: 'inline' }, dateInput, timeInput))]
        : []),
      h('div', { class: 'dest-list' }, ...choices.map((c) => c.el)),
      error,
    );
    const ok = () => {
      const dirs: string[] = [];
      for (const c of choices) {
        const r = c.choice.result();
        if (!r) continue;
        if ('error' in r) {
          error.textContent = `${folderName(c.choice.rule.folder)}: ${r.error}`;
          return;
        }
        if (!dirs.includes(r.dir)) dirs.push(r.dir);
      }
      answer = dirs.length ? { dirs, chosen: choices.filter((c) => c.choice.check.checked).map((c) => c.choice.rule.id) } : null;
      m.close();
    };
    const okBtn = h('button', { class: 'primary', onclick: ok }, t('btn.ok'));
    m.foot.append(h('button', { onclick: () => m.close() }, opts.adding ? t('btn.cancel') : t('dlg.dest.noFolder')), okBtn);
    m.body.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') ok();
    });
    update();
    queueMicrotask(() => okBtn.focus());
  });
}

/** The checkbox for one rule, and for a rule with a subfolder template, the subfolder choice and fields. */
function ruleChoice(
  rule: FolderRule,
  checked: boolean,
  when: () => Date,
  update: () => void,
  updaters: (() => void)[],
): { el: HTMLElement; choice: Choice } {
  const template = rule.subfolder?.trim() ?? '';
  const ampm: AmPmText = { am: rule.am || DEFAULT_AMPM.am, pm: rule.pm || DEFAULT_AMPM.pm };
  const check = h('input', { type: 'checkbox', checked, onchange: update });
  const head = h('label', { class: 'dest-head', title: rule.folder }, check, h('span', { class: 'dest-name' }, folderName(rule.folder)), h('span', { class: 'form-note' }, pathText(rule.folder)));
  if (!template) {
    return { el: h('div', { class: 'dest' }, head), choice: { rule, check, result: () => (check.checked ? { dir: rule.folder } : null) } };
  }

  const fields = subfolderFields(template);
  const inputs = new Map<string, HTMLInputElement>();
  const lists = new Map<string, HTMLDataListElement>();
  const listId = (f: string) => `dest-${rule.id}-${fields.indexOf(f)}`;
  for (const f of fields) {
    lists.set(f, h('datalist', { id: listId(f) }));
    const input = h('input', { type: 'text', spellcheck: false, oninput: update });
    input.setAttribute('list', listId(f)); // read-only as a property
    inputs.set(f, input);
  }
  const which = h('select', { onchange: update });
  // {ampm} follows the start time until it is chosen here.
  let ampmTouched = false;
  const ampmSelect = h('select', {
    onchange: () => {
      ampmTouched = true;
      update();
    },
  },
  h('option', { value: 'am' }, ampm.am),
  h('option', { value: 'pm' }, ampm.pm),
  h('option', { value: 'none' }, t('dlg.dest.ampmNone')));
  const ampmRow = usesAmPm(template) ? [h('label', {}, t('dlg.dest.ampm')), h('div', {}, ampmSelect)] : [];
  const preview = h('div', { class: 'form-note dest-preview' });
  const fieldGrid = h('div', { class: 'form-grid' }, ...ampmRow, ...fields.flatMap((f) => [h('label', {}, f), h('div', {}, inputs.get(f)!, lists.get(f)!)]));
  const detail = h('div', { class: 'dest-detail' },
    h('div', { class: 'form-grid' }, h('label', {}, t('dlg.dest.subfolder')), which),
    fieldGrid,
    preview,
  );

  const values = () => Object.fromEntries(fields.map((f) => [f, inputs.get(f)!.value]));
  const newName = () => expandSubfolder(template, when(), values(), ampm, getLanguage(), ampmSelect.value as AmPmChoice);
  let existing: string[] = [];
  const fillWhich = () => {
    const keep = which.value || NEW;
    which.replaceChildren(
      h('option', { value: NEW }, t('dlg.dest.new')),
      ...existing.map((name) => h('option', { value: name }, name)),
      h('option', { value: NONE }, t('dlg.dest.none', { folder: folderName(rule.folder) })),
    );
    which.value = [...which.options].some((o) => o.value === keep) ? keep : NEW;
  };
  fillWhich();
  // Earlier folders can be chosen again, and the values typed for them are suggested.
  void window.studio.listFolders(rule.folder).then((names) => {
    const matches = names.map((name) => ({ name, values: matchSubfolder(template, name, ampm) })).filter((m) => m.values);
    existing = matches.map((m) => m.name).sort().reverse();
    for (const f of fields) {
      const seen = [...new Set(matches.map((m) => m.values![f]).filter(Boolean))].sort();
      lists.get(f)!.replaceChildren(...seen.map((v) => h('option', { value: v })));
    }
    fillWhich();
    update();
  });

  const result = (): { dir: string } | { error: string } | null => {
    if (!check.checked) return null;
    if (which.value === NONE) return { dir: rule.folder };
    if (which.value !== NEW) return { dir: joinPath(rule.folder, which.value) };
    const empty = fields.find((f) => !inputs.get(f)!.value.trim());
    if (empty) return { error: t('dlg.dest.fieldRequired', { field: empty }) };
    const name = newName();
    const problem = filenameProblem(name);
    return problem ? { error: t(problem.key, problem.params) } : { dir: joinPath(rule.folder, name) };
  };
  updaters.push(() => {
    detail.style.display = check.checked ? '' : 'none';
    const isNew = which.value === NEW;
    if (!ampmTouched) ampmSelect.value = amPmAt(when());
    fieldGrid.style.display = isNew && (fields.length || ampmRow.length) ? '' : 'none';
    const r = check.checked ? result() : null;
    // Shown from the rule's folder on; the full path is in the tooltip.
    const shown = r && 'dir' in r ? r.dir : joinPath(rule.folder, newName() || '…');
    preview.textContent = `→ ${[folderName(rule.folder), shown.slice(joinPath(rule.folder, '').length)].filter(Boolean).join(' / ')}`;
    preview.title = shown;
    preview.classList.toggle('err', !!r && 'error' in r);
  });
  return { el: h('div', { class: 'dest' }, head, detail), choice: { rule, check, result } };
}
