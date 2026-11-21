/**
 * Turning a key name like "Enter" or "ctrl+a" into the CDP key events a real
 * keyboard would produce.
 */

const MODIFIER_BITS: Record<string, number> = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, shift: 8 };

const KEYS: Record<string, { key: string; code: string; vk: number }> = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13 },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  Space: { key: ' ', code: 'Space', vk: 32 },
  a: { key: 'a', code: 'KeyA', vk: 65 },
};

/** Keys by name whatever their case, and the names people also use for them. */
const NAMED: Record<string, { key: string; code: string; vk: number }> = {
  ...Object.fromEntries(Object.entries(KEYS).filter(([name]) => name.length > 1).map(([name, def]) => [name.toLowerCase(), def])),
  esc: KEYS.Escape, return: KEYS.Enter,
};

const keyNamed = (name: string): { key: string; code: string; vk: number } | undefined => KEYS[name] ?? NAMED[name.toLowerCase()];

type KeyEvent =Record<string, unknown> & { type: 'keyDown' | 'rawKeyDown' | 'keyUp' };

/** The down and up events for one key combination, in order. */
/** A key Fanfold can press: one it knows by name, or a single character, after any modifiers it knows. */
export function knownKey(combo: string): boolean {
  const parts = combo.split('+');
  const key = parts.pop() ?? '';
  if (parts.some((m) => MODIFIER_BITS[m.toLowerCase()] === undefined)) return false;
  return !!keyNamed(key) || [...key].length === 1;
}

export function keyEvents(combo: string): [KeyEvent, KeyEvent] {
  const parts = combo.split('+');
  const key = parts.pop() as string;
  const modifiers = parts.reduce((acc, m) => acc | (MODIFIER_BITS[m.toLowerCase()] ?? 0), 0);
  const def = keyNamed(key) ?? { key, code: `Key${key.toUpperCase()}`, vk: key.toUpperCase().charCodeAt(0) };
  /*
   * No nativeVirtualKeyCode. With one, Chrome on a Mac hands any key the page
   * leaves alone (Escape, Enter in a lone field, Cmd+A) back to its menus, and
   * in a headless Chrome, in any tab but the first, that never ends: 130% of a
   * core until the tab closes, and DevTools stops answering. Without it no
   * key Fanfold presses reaches the browser's own shortcuts (Cmd+W, a paste).
   */
  const base = {
    modifiers,
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.vk,
  };
  // What the shortcut means as an editing command, which a page gets without the menus.
  const command = modifiers === MODIFIER_BITS.meta && def.key.toLowerCase() === 'a' ? ['selectAll'] : undefined;
  // A single printable character with no modifiers needs text, or the page
  // sees the keypress but receives no input.
  const text = modifiers === 0 && def.key.length === 1 ? def.key : undefined;
  return [
    { ...base, type: text ? 'keyDown' : 'rawKeyDown', ...(text ? { text } : {}), ...(command ? { commands: command } : {}) },
    { ...base, type: 'keyUp' },
  ];
}
