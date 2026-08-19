import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = process.cwd();
const dbPath = path.join(root, 'src', 'store', 'db.ts');
const typesPath = path.join(root, 'src', 'store', 'types.ts');

const configPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
if (!configPath) throw new Error('tsconfig.json not found');
const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
if (configFile.error) throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root);
const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
const checker = program.getTypeChecker();
const source = program.getSourceFile(dbPath);
if (!source) throw new Error('src/store/db.ts is not in the TypeScript program');

const hasExport = (node) => node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true;
const selected = source.statements.filter((statement) =>
  (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && hasExport(statement),
);
if (selected.length < 5) throw new Error(`refusing suspicious extraction: found only ${selected.length} exported type/interface declarations`);
const selectedSet = new Set(selected);
const selectedNames = selected.map((statement) => statement.name.text);

function topLevelStatement(node) {
  let cursor = node;
  while (cursor.parent && !ts.isSourceFile(cursor.parent)) cursor = cursor.parent;
  return cursor;
}

const usedImportSymbols = new Set();
const privateDependencies = new Set();
for (const declaration of selected) {
  const visit = (node) => {
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      for (const symbolDeclaration of symbol?.declarations ?? []) {
        if (symbolDeclaration.getSourceFile() !== source) continue;
        const top = topLevelStatement(symbolDeclaration);
        if (ts.isImportDeclaration(top)) {
          usedImportSymbols.add(symbol);
        } else if (!selectedSet.has(top)) {
          // Ignore names declared inside the moved declaration itself (property
          // names, type parameters, etc.). Their top-level ancestor is selected.
          privateDependencies.add(`${node.text} -> ${ts.SyntaxKind[top.kind]}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration);
}
if (privateDependencies.size > 0) {
  throw new Error(`moved Store contracts depend on private db.ts declarations: ${[...privateDependencies].sort().join(', ')}`);
}

function importLocalSymbols(statement) {
  const clause = statement.importClause;
  if (!clause) return [];
  const entries = [];
  if (clause.name) entries.push({ kind: 'default', local: clause.name, imported: null });
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) {
    entries.push({ kind: 'namespace', local: bindings.name, imported: null });
  } else if (bindings && ts.isNamedImports(bindings)) {
    for (const element of bindings.elements) {
      entries.push({ kind: 'named', local: element.name, imported: element.propertyName?.text ?? element.name.text });
    }
  }
  return entries;
}

const typeImports = [];
for (const statement of source.statements) {
  if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
  const used = importLocalSymbols(statement).filter((entry) => {
    const symbol = checker.getSymbolAtLocation(entry.local);
    return symbol !== undefined && usedImportSymbols.has(symbol);
  });
  if (used.length === 0) continue;
  const moduleText = statement.moduleSpecifier.getText(source);
  const defaultEntry = used.find((entry) => entry.kind === 'default');
  const namespaceEntry = used.find((entry) => entry.kind === 'namespace');
  const named = used.filter((entry) => entry.kind === 'named');
  if (namespaceEntry) {
    if (defaultEntry || named.length > 0) throw new Error(`unsupported mixed namespace import from ${moduleText}`);
    typeImports.push(`import type * as ${namespaceEntry.local.text} from ${moduleText};`);
    continue;
  }
  const pieces = [];
  if (defaultEntry) pieces.push(defaultEntry.local.text);
  if (named.length > 0) {
    const names = named.map((entry) => entry.imported === entry.local.text ? entry.local.text : `${entry.imported} as ${entry.local.text}`);
    pieces.push(`{ ${names.join(', ')} }`);
  }
  typeImports.push(`import type ${pieces.join(', ')} from ${moduleText};`);
}

const movedText = selected.map((statement) => source.text.slice(statement.getFullStart(), statement.getEnd()).trim()).join('\n\n');
const typesFile = `/**\n * Public persistence contracts.\n *\n * Extracted mechanically from db.ts so callers can depend on ledger/billing/\n * allocation shapes without importing the SQLite implementation. db.ts\n * re-exports every contract for backward compatibility. Keep runtime/query\n * behavior in db.ts or domain modules; keep transport/storage shapes here.\n */\n\n${typeImports.join('\n')}\n\n${movedText}\n`;

// Remove declarations from the ORIGINAL coordinate space in one forward pass.
// Do not reuse source offsets after shortening the text: doing so previously
// inserted the compatibility bridge inside a later declaration and produced a
// syntactically invalid db.ts even though the dependency analysis itself passed.
const removals = selected
  .map((declaration) => ({ start: declaration.getFullStart(), end: declaration.getEnd() }))
  .sort((a, b) => a.start - b.start);
let cursor = 0;
const pieces = [];
for (const removal of removals) {
  if (removal.start < cursor) throw new Error('overlapping Store declaration ranges');
  pieces.push(source.text.slice(cursor, removal.start));
  cursor = removal.end;
}
pieces.push(source.text.slice(cursor));
let dbText = pieces.join('');

// Reparse the REDUCED source, then insert at a coordinate that is valid for
// that source. This keeps the bridge adjacent to imports without offset math.
let reduced = ts.createSourceFile('db.ts', dbText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const reducedParseErrors = reduced.parseDiagnostics ?? [];
if (reducedParseErrors.length > 0) {
  throw new Error(`db.ts became unparsable after declaration removal: ${reducedParseErrors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('; ')}`);
}
const lastImport = [...reduced.statements].filter(ts.isImportDeclaration).at(-1);
if (!lastImport) throw new Error('reduced db.ts unexpectedly has no imports');
const bridge = `\nimport type { ${selectedNames.join(', ')} } from './types.ts';\nexport type { ${selectedNames.join(', ')} } from './types.ts';`;
dbText = dbText.slice(0, lastImport.getEnd()) + bridge + dbText.slice(lastImport.getEnd());
dbText = dbText.replace(/\n{4,}/g, '\n\n\n');

// Parse the final text before writing it. Syntax failure is a transformer bug,
// never something we should hand to tsc as a candidate refactor.
reduced = ts.createSourceFile('db.ts', dbText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const finalParseErrors = reduced.parseDiagnostics ?? [];
if (finalParseErrors.length > 0) {
  throw new Error(`final db.ts parse failure: ${finalParseErrors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('; ')}`);
}
const residual = reduced.statements.filter((statement) =>
  (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && hasExport(statement),
);
if (residual.length !== 0) throw new Error(`db.ts still owns exported contracts: ${residual.map((x) => x.name.text).join(', ')}`);

fs.writeFileSync(typesPath, typesFile, 'utf8');
fs.writeFileSync(dbPath, dbText, 'utf8');
console.log(`extracted ${selectedNames.length} Store contracts to src/store/types.ts`);
