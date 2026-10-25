type Child = Node | string | null | undefined | false;
type Attrs = Record<string, unknown>;

/**
 * Tiny element builder. `class` sets className, `onxxx` adds listeners, `html` sets innerHTML
 * (used only for the static icon strings), everything else becomes a property or attribute.
 */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = String(value);
    else if (key === 'html') el.innerHTML = String(value);
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value as EventListener);
    else if (key in el) (el as unknown as Record<string, unknown>)[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  append(el, children);
  return el;
}

/**
 * A path for a .folder-path box. The box is right-to-left so a long path is cut at its start
 * and its end stays visible; the marks keep the slashes in place (otherwise "/home/x" shows
 * as "home/x/").
 */
export const pathText = (path: string): string => `\u200e${path}\u200e`;

export function append(el: Element, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
}
