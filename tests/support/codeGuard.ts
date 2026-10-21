import { readdirSync, readFileSync } from "node:fs";
import { posix, resolve } from "node:path";

import { parseSync } from "vite";

/*
 * Reading the app's code as code, for the guards that hold a list to its one writer
 * (tests/followGuard.test.ts, tests/savedGuard.test.ts): every module under a folder, its syntax
 * tree, the names it exports, and the few ways an expression or an import is written. Each guard
 * keeps its own rules; this only reads. A comment or a word on screen is never code here.
 */

const root = process.cwd();

/** Every .ts and .tsx file under a folder, as paths relative to the project. */
export function sourcesUnder(dir: string): string[] {
  return readdirSync(resolve(root, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sourcesUnder(`${dir}/${entry.name}`) : /\.tsx?$/.test(entry.name) ? [`${dir}/${entry.name}`] : [],
  );
}

/** The code of the module at `file`, a path relative to the project. */
export const read = (file: string) => readFileSync(resolve(root, file), "utf8");

export type Node = { type: string; start: number; [key: string]: unknown };
export const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";

/** The syntax tree of `source`, the code of the module at `file`, as TypeScript or TSX by its ending. Throws when it does not parse. */
export function programOf(file: string, source: string) {
  const { program, errors } = parseSync(file, source, { lang: file.endsWith(".tsx") ? "tsx" : "ts" });
  if (errors.length > 0) throw new Error(`${file} did not parse: ${errors.map((error) => error.message).join("; ")}`);
  return program;
}

/** `node` without what TypeScript and brackets wrap an expression in: `(3)`, `3 as number`, `x!`, `a?.b`. */
export function bare(node: unknown): Node | undefined {
  let each = node;
  while (
    isNode(each) &&
    /^(?:ParenthesizedExpression|TSAsExpression|TSSatisfiesExpression|TSNonNullExpression|TSTypeAssertion|ChainExpression)$/.test(each.type)
  ) {
    each = each.expression;
  }
  return isNode(each) ? each : undefined;
}

/** The name a property or a member is reached by: `kind` in `{ kind }`, `{ "kind": … }`, `x.kind` and `x["kind"]`. */
export function nameOf(key: unknown): string | undefined {
  if (!isNode(key)) return undefined;
  if (key.type === "Identifier" || key.type === "PrivateIdentifier") return key.name as string;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  return undefined;
}

/** The project path of what `file` imports as `specifier`, when that is a file of the project's own. */
export function imported(file: string, specifier: string): string | undefined {
  return specifier.startsWith(".") ? posix.normalize(posix.join(posix.dirname(file), specifier)) : undefined;
}

/** Whether `path` is the module `module`, however the import wrote its ending. */
export const isModule = (path: string | undefined, module: string) => path !== undefined && path.replace(/\.tsx?$/, "") === module.replace(/\.tsx?$/, "");

/** The names a module exports, of values and of types alike, in order of name; `* from <module>` for all of another's. */
export function exportsOf(file: string, source: string): string[] {
  const program = programOf(file, source);
  const names: string[] = [];
  for (const node of program.body as unknown as Node[]) {
    if (node.type === "ExportDefaultDeclaration") names.push("default");
    if (node.type === "ExportAllDeclaration") names.push(nameOf(node.exported) ?? `* from ${String((node.source as Node).value)}`);
    if (node.type !== "ExportNamedDeclaration") continue;
    for (const specifier of (node.specifiers as Node[] | undefined) ?? []) names.push(nameOf(specifier.exported) ?? "?");
    const declared = node.declaration as Node | null;
    if (declared === null) continue;
    // A `const` may declare several; anything else that is exported has one name.
    const ids = declared.type === "VariableDeclaration" ? (declared.declarations as Node[]).map((each) => each.id) : [declared.id];
    for (const id of ids) names.push(nameOf(id) ?? "?");
  }
  return names.sort();
}
