import { describe, expect, it } from "vitest";
import { parseOpenUi, type OpenUiNode } from "./openui";

/**
 * The web client's half of the contract: parse what the plugin allows, refuse
 * everything else. Each refusal is a case here because each one is a path back to the
 * code block instead of a half-drawn message.
 */
const SPEC = [
  'root = Stack([table, chart, code])',
  'table = Table({"columns": ["Bot", "Runs"], "rows": [["CEO", "3"]], "caption": "fleet"})',
  'chart = Chart({"kind": "bar", "labels": ["Mon", "Tue"], "values": [4, 7]})',
  'code = Code({"language": "bash", "code": "mercury bots status ceo"})',
].join("\n");

const parse = (spec: string) => parseOpenUi(spec);

describe("openui parser", () => {
  it("builds the tree the renderer draws", () => {
    const result = parse(SPEC);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stack = result.root as Extract<OpenUiNode, { type: "Stack" }>;
    expect(stack.children.map((child) => child.type)).toEqual(["Table", "Chart", "Snippet"]);

    const table = stack.children[0] as Extract<OpenUiNode, { type: "Table" }>;
    expect(table.columns).toEqual(["Bot", "Runs"]);
    expect(table.rows[0][1]).toBe("3");
    expect(table.caption).toBe("fleet");

    const chart = stack.children[1] as Extract<OpenUiNode, { type: "Chart" }>;
    expect(chart.values).toEqual([4, 7]);
  });

  it("defaults an absent variant to body", () => {
    const result = parse('root = Text({"text": "hello"})');
    expect(result.ok && result.root).toMatchObject({ type: "Paragraph", text: "hello", variant: "body" });
  });

  it("refuses a component outside the contract", () => {
    const result = parse('root = Form({"fields": []})');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain("Form");
  });

  it("refuses a prop that points at a URL", () => {
    const result = parse('root = Card({"title": "x", "href": "https://example.com"})');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain("href");
  });

  it("refuses a prop that does not exist on the component", () => {
    const result = parse('root = Card({"title": "x", "shadow": "2"})');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain("shadow");
  });

  it("refuses a dangling reference", () => {
    const result = parse("root = Stack([ghost])");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain("ghost");
  });

  it("refuses an orphan", () => {
    const result = parse(['root = Stack([a])', 'a = Text({"text": "ok"})', 'b = Text({"text": "hidden"})'].join("\n"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain('"b"');
  });

  it("refuses a cycle instead of recursing forever", () => {
    const result = parse(["root = Stack([a])", "a = Stack([root])"].join("\n"));
    expect(result.ok).toBe(false);
  });

  it("refuses a spec without root", () => {
    const result = parse('a = Text({"text": "x"})');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("root");
  });

  it("refuses numeric strings in chart values, because the chart multiplies them", () => {
    expect(parse('root = Chart({"kind": "bar", "labels": ["a"], "values": ["12"]})').ok).toBe(false);
    expect(parse('root = Chart({"kind": "bar", "labels": ["a"], "values": [1, null]})').ok).toBe(false);
    expect(parse('root = Chart({"kind": "bar", "labels": ["a"], "values": [1, 2]})').ok).toBe(true);
  });

  it("refuses a chart kind outside bar and line", () => {
    expect(parse('root = Chart({"kind": "pie", "labels": ["a"], "values": [1]})').ok).toBe(false);
  });

  it("refuses a snippet over the limit", () => {
    expect(parse(`root = Code({"code": "${"x".repeat(4001)}"})`).ok).toBe(false);
  });

  it("refuses props that are not one JSON object", () => {
    expect(parse("root = Text({text: 'x'})").ok).toBe(false);
  });

  it("refuses an empty spec rather than drawing a blank", () => {
    expect(parse("   ").ok).toBe(false);
  });

  it("keeps several statements of the same component apart", () => {
    const result = parse([
      "root = Stack([a, b])",
      'a = Text({"text": "one", "variant": "h2"})',
      'b = Text({"text": "two"})',
    ].join("\n"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stack = result.root as Extract<OpenUiNode, { type: "Stack" }>;
    expect(stack.children).toHaveLength(2);
  });
});
