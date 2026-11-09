import { Failure, requireValue } from './errors.js';

export class JsonNumber {
  constructor(public readonly raw: string) {}
}
export type Value = null | boolean | string | number | JsonNumber | Value[] | { [key: string]: Value };
export type ObjectValue = { [key: string]: Value };
const quoted = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
const jsonRuntime = JSON as typeof JSON & { rawJSON(text: string): unknown };

export function parse(text: string): Value {
  try {
    const stack: (Set<string> | null)[] = [];
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '"') {
        quoted.lastIndex = i;
        const token = quoted.exec(text);
        requireValue(token, 'invalid_json');
        i = quoted.lastIndex - 1;
        let next = i + 1;
        while (/\s/.test(text[next] ?? '') && next < text.length) next++;
        if (text[next] === ':') {
          const keys = stack.at(-1);
          const key: string = JSON.parse(token[0]);
          requireValue(keys && !keys.has(key), 'duplicate_json_key', { field: key, offset: i + 1, expected: 'unique_object_key' });
          keys.add(key);
        }
      } else if (c === '{' || c === '[') stack.push(c === '{' ? new Set() : null);
      else if (c === '}' || c === ']') stack.pop();
    }
    return JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) => {
      if (typeof value !== 'number') return value;
      requireValue(context?.source, 'lossless_json_runtime_required');
      return new JsonNumber(context.source);
    }) as Value;
  } catch (error) {
    if (error instanceof Failure) throw error;
    const position = /position (\d+)/.exec(error instanceof Error ? error.message : '');
    throw new Failure('invalid_json', { ...(position ? { offset: Number(position[1]) } : {}), expected: 'one_complete_json_value' });
  }
}

export function encode(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item instanceof JsonNumber ? jsonRuntime.rawJSON(item.raw) : item);
}

export function object(value: Value | undefined): ObjectValue {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof JsonNumber), 'object_required');
  return value;
}

export function text(value: Value | undefined): string {
  requireValue(typeof value === 'string', 'string_required');
  return value;
}

export function integer(value: Value | undefined): number {
  const n = value instanceof JsonNumber ? Number(value.raw) : value;
  requireValue(typeof n === 'number' && Number.isSafeInteger(n) && n >= 0, 'safe_integer_required');
  return n;
}

export function exact(value: ObjectValue, keys: string[]): void {
  requireValue(Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), 'unsupported_or_missing_fields');
}

export function identifier(value: Value | undefined): string {
  const id = text(value);
  requireValue(/^[A-Za-z0-9_-]{1,100}$/.test(id), 'invalid_identifier');
  return id;
}

export function decision(input: string, tools: Value): ObjectValue {
  requireValue(Buffer.byteLength(input) <= 1024 * 1024, 'body_too_large');
  const d = object(parse(input));
  if (d.type === 'final') {
    exact(d, ['type', 'text']);
    text(d.text);
  } else {
    exact(d, ['type', 'call_id', 'name', 'arguments']);
    requireValue(d.type === 'tool_call', 'unsupported_decision_type');
    identifier(d.call_id);
    requireValue(/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(text(d.name)), 'invalid_tool_name');
    object(d.arguments);
    requireValue(Array.isArray(tools) && tools.some(t => object(t).name === d.name), 'unknown_tool');
  }
  return d;
}
