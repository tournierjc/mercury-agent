/**
 * OpenUI Lang v1, as `mercury-plugin-openui/CONTRACT.md` defines it.
 *
 * The client half is narrow on purpose: parse what the contract allows and refuse
 * everything else, so `OpenUiBlock` can draw a spec without ever asking whether a
 * component is safe. Anything refused falls back to the fenced code block — a message
 * is never lost, it is just not drawn.
 *
 * Kept in step with the server-side validator (`openui-contract`): same components,
 * same props, same limits, same refusals.
 */

export type OpenUiNode =
  | { type: "Stack"; children: OpenUiNode[] }
  | { type: "Paragraph"; text: string; variant: string; muted: boolean }
  | { type: "Card"; title?: string; body?: string; tone: string }
  | { type: "KeyValue"; label: string; value: string; highlight: boolean }
  | { type: "Table"; columns: string[]; rows: string[][]; caption?: string }
  | { type: "Bullets"; items: string[]; ordered: boolean }
  | { type: "Stat"; value: string; label: string; delta?: string; tone: string }
  | { type: "Snippet"; code: string; language: string; title?: string }
  | { type: "Chart"; kind: "bar" | "line"; labels: string[]; values: number[]; title?: string; unit?: string };

export type OpenUiResult =
  | { ok: true; root: OpenUiNode }
  | { ok: false; errors: string[] };

export const OPENUI_FENCE = "openui";

const MAX_NODES = 60;
const MAX_STRING = 1200;
const MAX_CODE = 4000;
const MAX_ITEMS = 60;

const ID = /^[a-z][a-z0-9_]{0,23}$/;
const STATEMENT = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Z][A-Za-z0-9]*)\s*\(([\s\S]*)\)$/;

const LAYOUT = new Set(["Stack"]);
const COMPONENTS = new Set(["Stack", "Text", "Card", "KeyValue", "Table", "List", "Stat", "Code", "Chart"]);

/** Props that would make a client fetch, execute or embed something. Refused whole-spec. */
const FORBIDDEN = new Set([
  "href", "url", "uri", "src", "srcset", "html", "innerhtml", "script", "style",
  "onclick", "onload", "onerror", "action", "formaction", "image", "img", "svg",
  "iframe", "embed", "object", "data", "background", "class", "classname",
]);

const ALLOWED_PROPS: Record<string, string[]> = {
  Text: ["text", "variant", "muted"],
  Card: ["title", "body", "tone"],
  KeyValue: ["label", "value", "highlight"],
  Table: ["columns", "rows", "caption"],
  List: ["items", "ordered"],
  Stat: ["label", "value", "delta", "tone"],
  Code: ["code", "language", "title"],
  Chart: ["kind", "labels", "values", "title", "unit"],
};

const TONES = new Set(["neutral", "ok", "warn", "danger"]);
const VARIANTS = new Set(["body", "h1", "h2", "h3", "mono"]);

interface Node {
  id: string;
  component: string;
  children: string[];
  props: Record<string, unknown>;
}

function parseIds(raw: string): string[] | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(",").map((part) => part.trim());
}

function isStringArray(value: unknown, max = MAX_STRING): value is string[] {
  return Array.isArray(value) && value.length <= MAX_ITEMS && value.every((item) => typeof item === "string" && item.length <= max);
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.length <= MAX_ITEMS && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

function isStringMatrix(value: unknown): value is string[][] {
  return Array.isArray(value) && value.length <= MAX_ITEMS && value.every((row) => isStringArray(row));
}

function checkProps(id: string, component: string, props: Record<string, unknown>, line: number): string[] {
  const errors: string[] = [];
  const allowed = ALLOWED_PROPS[component] ?? [];
  for (const [key, value] of Object.entries(props)) {
    if (FORBIDDEN.has(key.toLowerCase())) {
      errors.push(`line ${line}: "${key}" is never allowed`);
      continue;
    }
    if (!allowed.includes(key)) {
      errors.push(`line ${line}: "${key}" is not a ${component} prop`);
      continue;
    }
    // One branch per prop shape, each ending the iteration: a chain of `else if` here
    // once let a valid array fall through to "must be a string".
    if (key === "rows") {
      if (!isStringMatrix(value)) errors.push(`line ${line}: "rows" must be a list of rows of strings`);
      continue;
    }
    if (key === "columns" || key === "labels" || key === "items") {
      if (!isStringArray(value)) errors.push(`line ${line}: "${key}" must be a list of strings`);
      continue;
    }
    if (key === "values") {
      // A numeric string is refused on purpose: the chart multiplies these.
      if (!isNumberArray(value)) errors.push(`line ${line}: "values" must be a list of numbers`);
      continue;
    }
    if (key === "highlight" || key === "ordered" || key === "muted") {
      if (typeof value !== "boolean") errors.push(`line ${line}: "${key}" must be true or false`);
      continue;
    }
    if (key === "kind") {
      if (value !== "bar" && value !== "line") errors.push(`line ${line}: "kind" must be bar or line`);
      continue;
    }
    if (key === "tone") {
      if (!TONES.has(String(value))) errors.push(`line ${line}: "tone" must be neutral, ok, warn or danger`);
      continue;
    }
    if (key === "variant") {
      if (!VARIANTS.has(String(value))) errors.push(`line ${line}: "variant" must be body, h1, h2, h3 or mono`);
      continue;
    }
    if (key === "code") {
      if (typeof value !== "string" || value.length > MAX_CODE) errors.push(`line ${line}: "code" is over ${MAX_CODE} characters`);
      continue;
    }
    if (typeof value !== "string") errors.push(`line ${line}: "${key}" must be a string`);
    else if (value.length > MAX_STRING) errors.push(`line ${line}: "${key}" is over ${MAX_STRING} characters`);
  }
  return errors;
}

function hasCycle(nodes: Map<string, Node>, id: string, path: Set<string>, done: Set<string>): boolean {
  if (path.has(id)) return true;
  if (done.has(id)) return false;
  const node = nodes.get(id);
  if (!node) return false;
  path.add(id);
  for (const child of node.children) if (hasCycle(nodes, child, path, done)) return true;
  path.delete(id);
  done.add(id);
  return false;
}

function build(nodes: Map<string, Node>, id: string, seen: Set<string>): OpenUiNode | null {
  if (seen.has(id)) return null;
  const node = nodes.get(id);
  if (!node) return null;
  const props = node.props;
  const str = (key: string): string | undefined => (typeof props[key] === "string" ? (props[key] as string) : undefined);
  const flag = (key: string): boolean => props[key] === true;

  switch (node.component) {
    case "Stack":
      return { type: "Stack", children: node.children.map((child) => build(nodes, child, new Set(seen))).filter((x): x is OpenUiNode => x !== null) };
    case "Text":
      return { type: "Paragraph", text: str("text") ?? "", variant: str("variant") ?? "body", muted: flag("muted") };
    case "Card":
      return { type: "Card", title: str("title"), body: str("body"), tone: str("tone") ?? "neutral" };
    case "KeyValue":
      return { type: "KeyValue", label: str("label") ?? "", value: str("value") ?? "", highlight: flag("highlight") };
    case "Table":
      return { type: "Table", columns: (props.columns as string[]) ?? [], rows: (props.rows as string[][]) ?? [], caption: str("caption") };
    case "List":
      return { type: "Bullets", items: (props.items as string[]) ?? [], ordered: flag("ordered") };
    case "Stat":
      return { type: "Stat", value: str("value") ?? "", label: str("label") ?? "", delta: str("delta"), tone: str("tone") ?? "neutral" };
    case "Code":
      return { type: "Snippet", code: str("code") ?? "", language: str("language") ?? "text", title: str("title") };
    case "Chart":
      return {
        type: "Chart",
        kind: (str("kind") as "bar" | "line") ?? "bar",
        labels: (props.labels as string[]) ?? [],
        values: (props.values as number[]) ?? [],
        title: str("title"),
        unit: str("unit"),
      };
    default:
      return null;
  }
}

/** Parse a spec into a tree the renderer may draw, or explain why it may not. */
export function parseOpenUi(spec: string): OpenUiResult {
  const errors: string[] = [];
  if (!spec.trim()) return { ok: false, errors: ["the spec is empty"] };
  if (spec.length > 32768) return { ok: false, errors: ["the spec is over 32 kB"] };

  const nodes = new Map<string, Node>();
  spec.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line || line.startsWith("//") || line.startsWith("#")) return;
    const number = index + 1;
    const match = STATEMENT.exec(line);
    if (!match) {
      errors.push(`line ${number}: expected \`id = Component(args)\``);
      return;
    }
    const [, id, component, rawArgs] = match;
    if (!ID.test(id)) {
      errors.push(`line ${number}: "${id}" is not an id`);
      return;
    }
    if (nodes.has(id)) {
      errors.push(`line ${number}: "${id}" is defined twice`);
      return;
    }
    if (!COMPONENTS.has(component)) {
      errors.push(`line ${number}: "${component}" is not in the contract`);
      return;
    }
    if (LAYOUT.has(component)) {
      const children = parseIds(rawArgs);
      if (!children || children.length === 0 || !children.every((child) => ID.test(child))) {
        errors.push(`line ${number}: "${component}" takes a list of child ids`);
        return;
      }
      nodes.set(id, { id, component, children, props: {} });
      return;
    }
    let props: Record<string, unknown>;
    try {
      const parsed = JSON.parse(rawArgs.trim());
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      props = parsed as Record<string, unknown>;
    } catch {
      errors.push(`line ${number}: the props are not one JSON object`);
      return;
    }
    errors.push(...checkProps(id, component, props, number));
    nodes.set(id, { id, component, children: [], props });
  });

  if (errors.length === 0) {
    if (!nodes.has("root")) errors.push("a spec needs a root");
    for (const node of nodes.values()) {
      for (const child of node.children) {
        if (!nodes.has(child)) errors.push(`"${node.id}" points at "${child}", which is not defined`);
      }
    }
    const referenced = new Set([...nodes.values()].flatMap((node) => node.children));
    for (const node of nodes.values()) {
      if (node.id !== "root" && !referenced.has(node.id)) errors.push(`"${node.id}" is never referenced`);
    }
    if (nodes.size > MAX_NODES) errors.push(`${nodes.size} components, the limit is ${MAX_NODES}`);
    if (errors.length === 0 && hasCycle(nodes, "root", new Set(), new Set())) errors.push("the children form a cycle");
  }

  if (errors.length > 0) return { ok: false, errors };
  const root = build(nodes, "root", new Set());
  return root ? { ok: true, root } : { ok: false, errors: ["the tree could not be built"] };
}
