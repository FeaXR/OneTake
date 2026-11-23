import { getLanguage, t } from '../shared/i18n/index.ts';
import type { FolderRule } from '../shared/naming.ts';
import { amPmAt, expandSubfolder, matchSubfolder, subfolderAmPm, subfolderFields, subfolderStart, usesAmPm, usesDateTime, type AmPmChoice, type AmPmText } from '../shared/subfolders.ts';
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

/** The name of `dir` inside the rule's folder, or null when it is the rule's folder itself (or elsewhere). */
function subfolderName(rule: FolderRule, dir: string): string | null {
  const parent = joinPath(rule.folder, '');
  if (dir === rule.folder || !dir.startsWith(parent)) return null;
  const name = dir.slice(parent.length);
  return name && !/[\\/]/.test(name) ? name : null;
}
const NEW = '\0new';
const NONE = '\0none';

/** One rule's place in the dialog: whether it is chosen, and where inside it the files go. */
interface Choice {
  rule: FolderRule;
  check: HTMLInputElement;
  /** The folder the files go to, or an error to show; null while not chosen. */
  result(): { dir: string } | { error: string } | null;
  /** {ampm} for the file names in that folder; null when they do not use it. */
  amPm(): 'am' | 'pm' | null;
}

/** What the dialog needs to know about a rule's file names. */
export interface RuleNaming {
  /** Whether file names in the rule's folder use {ampm}. */
  fileAmPm: boolean;
  /** What {ampm} becomes there (in file names and in the subfolder's name). */
  text: AmPmText;
}

export interface DestinationAnswer {
  dirs: string[];
  /** The rules ticked, remembered for the next file. */
  chosen: string[];
  /** {ampm} for the file names in each folder whose names use it. */
  amPm: Record<string, 'am' | 'pm'>;
}

export interface DestinationOptions {
  /** Adding one rule's folder later: no checkbox or note, and the dismiss button just cancels. */
  adding?: boolean;
  /** The dismiss button cancels instead of meaning "No folder" (asked again on export). */
  cancel?: boolean;
  /** Changing a folder that is in the list already: it, and the {ampm} its files use now. */
  current?: { dir: string; amPm: 'am' | 'pm' };
}

/**
 * Asks which folders the files of a newly opened WAV go to. Rules with a subfolder template get
 * a new folder named from the recording's start and the fields typed here, an existing one, or
 * none. Resolves to the folders (the first is the default), or null for "No folder": the files
 * then go next to the WAV as before.
 */
export function chooseDestinations(
  rules: readonly FolderRule[],
  naming: (rule: FolderRule) => RuleNaming,
  start: Date,
  lastChosen: readonly string[],
  opts: DestinationOptions = {},
): Promise<DestinationAnswer | null> {
  const adding = opts.adding || !!opts.current;
  return new Promise((resolve) => {
    let answer: DestinationAnswer | null = null;
    const m = openModal(opts.current ? t('dlg.dest.changeTitle') : t('dlg.dest.title'), { onClose: () => resolve(answer) });
    const error = h('div', { class: 'form-note err' });

    // Changing a listed folder: the start its name was made from, so editing it renames the folder.
    const currentRule = opts.current && rules.length === 1 ? rules[0] : null;
    const currentSub = currentRule && opts.current ? subfolderName(currentRule, opts.current.dir) : null;
    if (currentRule?.subfolder && currentSub) {
      start = subfolderStart(currentRule.subfolder.trim(), currentSub, naming(currentRule).text, start) ?? start;
    }
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

    const choices = rules.map((rule) => ruleChoice(rule, naming(rule), adding || lastChosen.includes(rule.id), when, update, updaters, opts.current));
    if (adding) choices.forEach((c) => (c.choice.check.hidden = true));
    // The start is asked for when a name is made from it, {ampm} in file names included.
    const anyDateTime = rules.some((r) => (r.subfolder && usesDateTime(r.subfolder)) || naming(r).fileAmPm);

    m.body.append(
      adding ? '' : h('div', { class: 'form-note' }, t('dlg.dest.note')),
      ...(anyDateTime
        ? [h('div', { class: 'form-grid dest-when' }, h('label', {}, t('dlg.dest.start')), h('div', { class: 'inline' }, dateInput, timeInput))]
        : []),
      h('div', { class: 'dest-list' }, ...choices.map((c) => c.el)),
      error,
    );
    const ok = () => {
      const dirs: string[] = [];
      const amPm: Record<string, 'am' | 'pm'> = {};
      for (const c of choices) {
        const r = c.choice.result();
        if (!r) continue;
        if ('error' in r) {
          error.textContent = `${folderName(c.choice.rule.folder)}: ${r.error}`;
          return;
        }
        if (!dirs.includes(r.dir)) dirs.push(r.dir);
        const choice = c.choice.amPm();
        if (choice) amPm[r.dir] = choice;
      }
      answer = dirs.length ? { dirs, chosen: choices.filter((c) => c.choice.check.checked).map((c) => c.choice.rule.id), amPm } : null;
      m.close();
    };
    const okBtn = h('button', { class: 'primary', onclick: ok }, t('btn.ok'));
    m.foot.append(h('button', { onclick: () => m.close() }, adding || opts.cancel ? t('btn.cancel') : t('dlg.dest.noFolder')), okBtn);
    m.body.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') ok();
    });
    update();
    queueMicrotask(() => okBtn.focus());
  });
}

/**
 * The checkbox for one rule; for a rule with a subfolder template, the subfolder choice and
 * fields; and before/after noon when the subfolder's name or the file names use it.
 */
function ruleChoice(
  rule: FolderRule,
  naming: RuleNaming,
  checked: boolean,
  when: () => Date,
  update: () => void,
  updaters: (() => void)[],
  current?: { dir: string; amPm: 'am' | 'pm' },
): { el: HTMLElement; choice: Choice } {
  const template = rule.subfolder?.trim() ?? '';
  const ampm = naming.text;
  const check = h('input', { type: 'checkbox', checked, onchange: update });
  const head = h('label', { class: 'dest-head', title: rule.folder }, check, h('span', { class: 'dest-name' }, folderName(rule.folder)), h('span', { class: 'form-note' }, pathText(rule.folder)));

  // {ampm} follows the start time (or the name of the folder chosen) until it is chosen here.
  let ampmTouched = !!current;
  const noneOption = h('option', { value: 'none' }, t('dlg.dest.ampmNone'));
  const ampmSelect = h('select', {
    onchange: () => {
      ampmTouched = true;
      update();
    },
  },
  h('option', { value: 'am' }, ampm.am),
  h('option', { value: 'pm' }, ampm.pm),
  noneOption);
  if (current) ampmSelect.value = current.amPm;
  const subAmPm = !!template && usesAmPm(template);
  const ampmLabel = h('label', {}, t('dlg.dest.ampm'));
  const ampmCell = h('div', {}, ampmSelect);
  const fileAmPm = (): 'am' | 'pm' | null => {
    if (!naming.fileAmPm) return null;
    const v = ampmSelect.value;
    return v === 'am' || v === 'pm' ? v : amPmAt(when());
  };

  if (!template) {
    const detail = h('div', { class: 'dest-detail' }, h('div', { class: 'form-grid' }, ampmLabel, ampmCell));
    noneOption.hidden = true;
    updaters.push(() => {
      detail.style.display = check.checked && naming.fileAmPm ? '' : 'none';
      if (!ampmTouched) ampmSelect.value = amPmAt(when());
    });
    return {
      el: h('div', { class: 'dest' }, head, detail),
      choice: { rule, check, result: () => (check.checked ? { dir: rule.folder } : null), amPm: fileAmPm },
    };
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
  const preview = h('div', { class: 'form-note dest-preview' });
  const ampmGrid = h('div', { class: 'form-grid' }, ampmLabel, ampmCell);
  const fieldGrid = h('div', { class: 'form-grid' }, ...fields.flatMap((f) => [h('label', {}, f), h('div', {}, inputs.get(f)!, lists.get(f)!)]));
  const detail = h('div', { class: 'dest-detail' },
    h('div', { class: 'form-grid' }, h('label', {}, t('dlg.dest.subfolder')), which),
    ampmGrid,
    fieldGrid,
    preview,
  );

  const values = () => Object.fromEntries(fields.map((f) => [f, inputs.get(f)!.value]));
  const newName = () => expandSubfolder(template, when(), values(), ampm, getLanguage(), ampmSelect.value as AmPmChoice);
  // Changing a listed folder: it is chosen to begin with (even before it exists on disk). A name
  // that follows the template fills in the fields, so editing them (or the start) renames it.
  const sub = current ? subfolderName(rule, current.dir) : null;
  const currentName = !current ? null : sub ?? NONE;
  const typed = sub ? matchSubfolder(template, sub, ampm) : null;
  if (sub && typed) {
    for (const f of fields) inputs.get(f)!.value = typed[f] ?? '';
    ampmSelect.value = subfolderAmPm(template, sub, ampm) ?? (subAmPm ? 'none' : current!.amPm);
  }
  // Before/after noon that agrees with the start keeps following it when the start is edited.
  if (current) ampmTouched = ampmSelect.value !== amPmAt(when());
  let existing: string[] = sub ? [sub] : [];
  const fillWhich = (keep: string) => {
    which.replaceChildren(
      h('option', { value: NEW }, typed ? t('dlg.dest.fromSettings') : t('dlg.dest.new')),
      ...existing.map((name) => h('option', { value: name }, name)),
      h('option', { value: NONE }, t('dlg.dest.none', { folder: folderName(rule.folder) })),
    );
    which.value = [...which.options].some((o) => o.value === keep) ? keep : NEW;
  };
  fillWhich(typed ? NEW : currentName ?? NEW);
  // Earlier folders can be chosen again, and the values typed for them are suggested.
  void window.studio.listFolders(rule.folder).then((names) => {
    const matches = names.map((name) => ({ name, values: matchSubfolder(template, name, ampm) })).filter((m) => m.values);
    existing = [...new Set([...matches.map((m) => m.name), ...existing])].sort().reverse();
    for (const f of fields) {
      const seen = [...new Set(matches.map((m) => m.values![f]).filter(Boolean))].sort();
      lists.get(f)!.replaceChildren(...seen.map((v) => h('option', { value: v })));
    }
    fillWhich(which.value || NEW);
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
    // "Neither" only leaves {ampm} out of a new folder's name.
    noneOption.hidden = !(isNew && subAmPm);
    if (!ampmTouched || (noneOption.hidden && ampmSelect.value === 'none')) {
      const named = !isNew && which.value !== NONE ? subfolderAmPm(template, which.value, ampm) : null;
      ampmSelect.value = named ?? amPmAt(when());
    }
    ampmGrid.style.display = (isNew && subAmPm) || naming.fileAmPm ? '' : 'none';
    fieldGrid.style.display = isNew && fields.length ? '' : 'none';
    const r = check.checked ? result() : null;
    // Shown from the rule's folder on; the full path is in the tooltip.
    const shown = r && 'dir' in r ? r.dir : joinPath(rule.folder, newName() || '…');
    preview.textContent = `→ ${[folderName(rule.folder), shown.slice(joinPath(rule.folder, '').length)].filter(Boolean).join(' / ')}`;
    preview.title = shown;
    preview.classList.toggle('err', !!r && 'error' in r);
  });
  return { el: h('div', { class: 'dest' }, head, detail), choice: { rule, check, result, amPm: fileAmPm } };
}
