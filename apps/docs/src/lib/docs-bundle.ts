import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { docOgImagePathFromId, docPathFromId, getDocsEntries, type DocsEntry } from "@/lib/docs";
import { resolveDocsFigure, type DocsFigureName } from "@/lib/docs-figures";
import { docsWebPath } from "@/lib/docs-paths";
import { stripSearchIntentTags } from "@/lib/docs-search";
import {
  DEFAULT_DOCS_SITE,
  MONOREPO_ROOT,
  absolutizeMarkdownLinks,
  createDocsVirtualFiles,
  type DocsVirtualFile,
  type DocsVirtualFileSystem,
  renderLlmsFullText,
  renderLlmsText,
} from "@/lib/docs-vfs";

export { absolutizeMarkdownLinks, renderLlmsFullText, renderLlmsText };

const rawDocModules = import.meta.glob<string>("/src/content/docs/**/*.mdx", {
  eager: true,
  import: "default",
  query: "?raw",
});

export type BundledDoc = {
  id: string;
  path: string;
  markdownPath: string;
  title: string;
  description: string;
  figure: {
    name: DocsFigureName;
    src: string;
    alt: string;
    backgroundColor: string;
  };
  ogImage: string;
  source: string;
  markdown: string;
  searchMarkdown: string;
};

export type SshTerminalConfig = {
  promptHost: string;
  banner: string;
  title: string;
  hint: string;
};

export const sshTerminalConfig: SshTerminalConfig = {
  promptHost: "docs.rigkit.dev",
  banner: [
    " ____  _       _    _ _   ",
    "|  _ \\(_) __ _| | _(_) |_ ",
    "| |_) | |/ _` | |/ / | __|",
    "|  _ <| | (_| |   <| | |_ ",
    "|_| \\_\\_|\\__, |_|\\_\\_|\\__|",
    "         |___/            ",
  ].join("\n"),
  title: "Rigkit Docs shell",
  hint: [
    "Rigkit runs declarative dev environments from a TypeScript config.",
    "Prepare setup once, cache it, and create named workspaces for agents,",
    "developers, CI jobs, or tests.",
    "",
    "Web docs: https://www.rigkit.dev/docs",
    "LLM index: https://www.rigkit.dev/docs/llms.txt",
    "Full LLM context: https://www.rigkit.dev/docs/llms-full.txt",
    "",
    "Inside SSH: cat /README.md, cat /llms.txt, cat /api/docs.json",
    "Try: ls /docs, ls /monorepo, cat /monorepo/package.json, search <query>, context --json <query>.",
    "Tab completes commands and paths. Type help for commands.",
  ].join("\n"),
};

const codebaseDecoder = new TextDecoder("utf-8", { fatal: true });
let codebaseFilesCache: DocsVirtualFile[] | undefined;

export function getBundledCodebaseFiles(): DocsVirtualFile[] {
  if (codebaseFilesCache) return codebaseFilesCache;

  const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: process.cwd(),
    encoding: "utf8",
  }).trim();
  const listed = execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    maxBuffer: 16 * 1024 * 1024,
  });
  const relativePaths = listed
    .toString("utf8")
    .split("\0")
    .filter((path) => path.length > 0);

  codebaseFilesCache = relativePaths.flatMap((relativePath) => {
    const absolutePath = nodePath.join(repoRoot, relativePath);
    const body = readTrackedTextFile(absolutePath);
    if (body === undefined) return [];

    return [
      {
        path: `${MONOREPO_ROOT}/${relativePath.replace(/\\/g, "/")}`,
        body,
      },
    ];
  });

  return codebaseFilesCache;
}

function readTrackedTextFile(absolutePath: string) {
  const bytes = readFileSync(absolutePath);
  if (bytes.includes(0)) return undefined;

  try {
    return codebaseDecoder.decode(bytes);
  } catch {
    return undefined;
  }
}

function idFromGlobKey(key: string) {
  return key
    .replace(/^\/src\/content\/docs\//, "")
    .replace(/\.mdx$/, "");
}

const rawById = new Map<string, string>();
const overviewCardsMarkdown = [
  `- [Quickstart](${docsWebPath("/guides/quickstart")}): Install Rigkit and create your first workspace.`,
  `- [Concepts](${docsWebPath("/concepts/mental-model")}): Learn the workflow, cache, provider, and workspace model.`,
  `- [Writing configs](${docsWebPath("/guides/workflows")}): Compose tasks, operations, and fragments.`,
  `- [Providers](${docsWebPath("/providers/overview")}): Connect Rigkit workflows to built-in and custom providers.`,
].join("\n");

for (const [key, source] of Object.entries(rawDocModules)) {
  const id = idFromGlobKey(key);
  rawById.set(id, source);

  if (id.endsWith("/index")) {
    rawById.set(id.replace(/\/index$/, ""), source);
  }
}

function stripFrontmatter(source: string) {
  return source.replace(/^---\s*[\s\S]*?\s*---\s*/, "").trim();
}

function attrValue(attrs: string, name: string) {
  const match = attrs.match(new RegExp(`${name}="([^"]+)"`));
  return match?.[1];
}

function renderImageMarkdown(attrs: string) {
  const src = attrValue(attrs, "src");
  if (!src) return "";

  const alt = attrValue(attrs, "alt") ?? "";
  return `![${alt}](${src})`;
}

// The site renders these diagrams as static SVG components. The markdown
// bundle gets the equivalent Mermaid source so text readers keep the graph.
const conceptsFlowDiagramMarkdown = `\`\`\`mermaid
flowchart TD
  Config["rigkit/index.ts"] --> Plan["rig plan"]
  Config --> Apply["rig apply"]
  Apply --> Cache["Cached workflow context"]
  Cache --> Workspace["rig create <workspace>"]
  Workspace --> Run["rig run <workspace> <operation>"]
  Run --> Agent["Agent"]
  Run --> Developer["Developer"]
  Run --> CI["CI or tests"]
\`\`\``;

const workflowGraphDiagramMarkdown = `\`\`\`mermaid
flowchart LR
  Base["base image"] --> Tooling["install tooling"]
  Tooling --> Repo["setup repo"]
  Tooling --> Database["provision database"]
  Repo --> Join["final context"]
  Database --> Join
  Join --> Workspace["workspace.create"]
  Workspace --> Ops["open, ssh, test, status"]
\`\`\``;

export function toPlainMarkdown(
  source: string,
  options: { preserveSearchIntents?: boolean } = {},
) {
  let body = stripFrontmatter(source)
    .replace(/<img\s+([^>]*)\/?>/g, (_match, attrs: string) => renderImageMarkdown(attrs))
    .replace(/<OverviewCards\s*\/>/g, overviewCardsMarkdown)
    .replace(/<ConceptsFlowDiagram\s*\/>/g, conceptsFlowDiagramMarkdown)
    .replace(/<WorkflowGraphDiagram\s*\/>/g, workflowGraphDiagramMarkdown)
    .replace(/<CodeGroup>\s*/g, "")
    .replace(/\s*<\/CodeGroup>/g, "")
    .replace(/<CardGroup[^>]*>\s*/g, "")
    .replace(/\s*<\/CardGroup>/g, "")
    .replace(
      /<Card\s+([^>]*)>([\s\S]*?)<\/Card>/g,
      (_match, attrs: string, body: string) => {
        const title = attrValue(attrs, "title") ?? "Guide";
        const href = attrValue(attrs, "href");
        const heading = href ? `### [${title}](${href})` : `### ${title}`;
        return `${heading}\n\n${body.trim()}\n`;
      },
    )
    .replace(/<a\s+class="cursor-install-link"\s+href="([^"]+)">([^<]+)<\/a>/g, "[$2]($1)")
    .replace(/^[ \t]+(#{1,6}\s+)/gm, "$1");

  if (!options.preserveSearchIntents) {
    body = stripSearchIntentTags(body);
  }

  body = body.trim();

  return `${body}\n`;
}

function toBundledDoc(entry: DocsEntry): BundledDoc {
  const source = rawById.get(entry.id);
  if (!source) {
    throw new Error(`Missing raw docs source for ${entry.id}`);
  }

  const path = docPathFromId(entry.id);
  const figure = resolveDocsFigure(entry.data.figure, entry.data.title);
  return {
    id: entry.id,
    path,
    markdownPath: path === "/" ? "/index.md" : `${path}.md`,
    title: entry.data.title,
    description: entry.data.description,
    figure: {
      name: figure.name,
      src: figure.url,
      alt: figure.alt,
      backgroundColor: figure.backgroundColor,
    },
    ogImage: docOgImagePathFromId(entry.id),
    source,
    markdown: toPlainMarkdown(source),
    searchMarkdown: toPlainMarkdown(source, { preserveSearchIntents: true }),
  };
}

export async function getBundledDocs(): Promise<BundledDoc[]> {
  const entries = await getDocsEntries();
  return entries.map(toBundledDoc);
}

export async function getBundledDocsVirtualFiles(
  generatedAt = new Date().toISOString(),
): Promise<DocsVirtualFileSystem> {
  const docs = await getBundledDocs();
  return createDocsVirtualFiles(docs, {
    generatedAt,
    site: DEFAULT_DOCS_SITE,
    terminalConfig: sshTerminalConfig,
    codebaseFiles: getBundledCodebaseFiles(),
  });
}

export async function getBundledDocById(id: string): Promise<BundledDoc | undefined> {
  const docs = await getBundledDocs();
  return docs.find((doc) => doc.id === id || doc.id === `${id}/index`);
}

export function renderSitemapText(site: URL, docs: BundledDoc[]) {
  return `${docs.map((doc) => new URL(docsWebPath(doc.path), site).toString()).join("\n")}\n`;
}

export function renderSitemapXml(site: URL, docs: BundledDoc[]) {
  const updated = new Date().toISOString().slice(0, 10);
  const urls = docs
    .map(
      (doc) => `  <url>
    <loc>${new URL(docsWebPath(doc.path), site).toString()}</loc>
    <lastmod>${updated}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>${doc.path === "/" ? "1.0" : "0.8"}</priority>
  </url>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

function bashSingleQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function base64(value: string) {
  return Buffer.from(value, "utf8").toString("base64");
}

export function renderBashDocs(virtualFiles: DocsVirtualFileSystem) {
  const docs = virtualFiles.docs;
  const generatedAt = virtualFiles.generatedAt;
  const titles = docs.map((doc) => bashSingleQuote(doc.title)).join(" ");
  const descriptions = docs.map((doc) => bashSingleQuote(doc.description)).join(" ");
  const paths = docs.map((doc) => bashSingleQuote(doc.path)).join(" ");
  const files = virtualFiles.docFiles.map((file) => bashSingleQuote(file.path)).join(" ");
  const bodies = virtualFiles.docFiles
    .map((file) => bashSingleQuote(base64(file.body)))
    .join(" ");
  const machineFiles = virtualFiles.machineFiles
    .map((file) => bashSingleQuote(file.path))
    .join(" ");
  const machineBodies = virtualFiles.machineFiles
    .map((file) => bashSingleQuote(base64(file.body)))
    .join(" ");
  const codebaseFiles = virtualFiles.codebaseFiles
    .map((file) => bashSingleQuote(file.path))
    .join(" ");
  const codebaseBodies = virtualFiles.codebaseFiles
    .map((file) => bashSingleQuote(base64(file.body)))
    .join(" ");

  return [
    "#!/usr/bin/env bash",
    "set -u",
    "set -f",
    "",
    `DOC_GENERATED_AT=${bashSingleQuote(generatedAt)}`,
    `SSH_PROMPT_HOST=${bashSingleQuote(sshTerminalConfig.promptHost)}`,
    `SSH_BANNER=${bashSingleQuote(sshTerminalConfig.banner)}`,
    `SSH_TITLE=${bashSingleQuote(sshTerminalConfig.title)}`,
    `SSH_HINT=${bashSingleQuote(sshTerminalConfig.hint)}`,
    `DOC_TITLES=(${titles})`,
    `DOC_DESCRIPTIONS=(${descriptions})`,
    `DOC_PATHS=(${paths})`,
    `DOC_FILES=(${files})`,
    `DOC_BODIES=(${bodies})`,
    `MACHINE_FILES=(${machineFiles})`,
    `MACHINE_BODIES=(${machineBodies})`,
    `CODEBASE_FILES=(${codebaseFiles})`,
    `CODEBASE_BODIES=(${codebaseBodies})`,
    "COMMANDS=(help ls cd cat open search grep context tree version menu pwd clear exit quit logout)",
    'cwd="/"',
    "ssh_should_close=0",
    "children=()",
    "PARSED_WORDS=()",
    "SEARCH_FILES=()",
    "SEARCH_LINE_NUMBERS=()",
    "SEARCH_LINES=()",
    "CONTEXT_FILES=()",
    "",
    "decode_doc() {",
    "  if base64 -d </dev/null >/dev/null 2>&1; then",
    "    base64 -d",
    "  else",
    "    base64 -D",
    "  fi",
    "}",
    "",
    "json_escape() {",
    '  local value="$1"',
    '  value="${value//\\\\/\\\\\\\\}"',
    '  value="${value//\\"/\\\\\\"}"',
    "  value=\"${value//$'\\n'/\\\\n}\"",
    "  value=\"${value//$'\\r'/\\\\r}\"",
    "  value=\"${value//$'\\t'/\\\\t}\"",
    '  printf \'"%s"\' "$value"',
    "}",
    "",
    "join_words() {",
    "  local sep=\"\"",
    "  local word",
    '  for word in "$@"; do',
    '    printf "%s%s" "$sep" "$word"',
    '    sep=" "',
    "  done",
    "}",
    "",
    "lower() {",
    '  printf "%s" "${1,,}"',
    "}",
    "",
    "estimate_tokens() {",
    '  local count="${#1}"',
    "  local tokens=$((count / 4))",
    '  if [ "$tokens" -lt 1 ]; then tokens=1; fi',
    '  printf "%s\\n" "$tokens"',
    "}",
    "",
    "truncate_to_token_budget() {",
    '  local value="$1"',
    '  local budget="$2"',
    "  local character_budget=$((budget * 4))",
    '  if [ "$character_budget" -lt 120 ]; then character_budget=120; fi',
    '  if [ "${#value}" -le "$character_budget" ]; then printf "%s" "$value"; return; fi',
    '  printf "%s\\n\\n[truncated]" "${value:0:$character_budget}"',
    "}",
    "",
    "write_ssh_state() {",
    '  local status="${1:-0}"',
    '  local close="${2:-0}"',
    '  if [ -z "${FREESTYLE_DOCS_SSH_STATE_OUT:-}" ]; then return; fi',
    "  {",
    '    printf "cwd=%s\\n" "$cwd"',
    '    printf "exit_status=%s\\n" "$status"',
    '    printf "close=%s\\n" "$close"',
    '  } > "$FREESTYLE_DOCS_SSH_STATE_OUT"',
    "}",
    "",
    "print_prompt() {",
    '  printf "\\033[32m%s:%s$\\033[0m " "$SSH_PROMPT_HOST" "$cwd"',
    "}",
    "",
    "print_welcome() {",
    '  printf "\\033[34m%s\\033[0m\\n" "$SSH_BANNER"',
    '  printf "\\033[1m%s\\033[0m  \\033[32m%s\\033[0m\\n\\n" "$SSH_TITLE" "$SSH_PROMPT_HOST"',
    '  printf "%s\\n\\n" "$SSH_HINT"',
    "  print_prompt",
    "}",
    "",
    "print_help() {",
    "  cat <<'HELP'",
    "Commands:",
    "  ls [path]        list virtual files",
    "  cd [path]        change directory",
    "  cat <path>       print a virtual file",
    "  open <path>      alias for cat",
    "  search [--json] [--limit n] <query>",
    "                   search titles and markdown",
    "  grep [--json] [--limit n] <query> [path]",
    "                   search virtual file lines",
    "  context [--json] [--tokens n] [query-or-path]",
    "                   print docs context for an agent",
    "  tree [--json]    show all virtual files",
    "  version [--json] show runtime and docs bundle metadata",
    "  menu             show numbered docs pages",
    "  pwd              print current directory",
    "  clear            clear the terminal",
    "  exit             close the docs shell",
    "HELP",
    "}",
    "",
    "normalize_path() {",
    '  local base="$1"',
    '  local input="${2:-}"',
    "  local raw part sep",
    "  local parts=()",
    "  local output=()",
    '  if [ -z "$input" ]; then input="$base"; fi',
    '  case "$input" in',
    '    /*) raw="$input" ;;',
    '    *) if [ "$base" = "/" ]; then raw="/$input"; else raw="$base/$input"; fi ;;',
    "  esac",
    "  local old_ifs=\"$IFS\"",
    "  IFS='/'",
    "  read -r -a parts <<< \"$raw\"",
    "  IFS=\"$old_ifs\"",
    '  for part in "${parts[@]}"; do',
    '    case "$part" in',
    '      ""|".") ;;',
    '      "..") if [ "${#output[@]}" -gt 0 ]; then unset "output[$((${#output[@]} - 1))]"; fi ;;',
    '      *) output+=("$part") ;;',
    "    esac",
    "  done",
    '  if [ "${#output[@]}" -eq 0 ]; then printf "/\\n"; return; fi',
    "  printf '/'",
    "  sep=''",
    '  for part in "${output[@]}"; do printf "%s%s" "$sep" "$part"; sep="/"; done',
    "  printf '\\n'",
    "}",
    "",
    "each_file() {",
    "  local file",
    '  for file in "${DOC_FILES[@]}"; do printf "%s\\n" "$file"; done',
    '  for file in "${MACHINE_FILES[@]}"; do printf "%s\\n" "$file"; done',
    '  for file in "${CODEBASE_FILES[@]}"; do printf "%s\\n" "$file"; done',
    "}",
    "",
    "is_directory() {",
    '  local path="$1"',
    "  local file prefix",
    '  if [ "$path" = "/" ]; then return 0; fi',
    '  prefix="$path/"',
    "  while IFS= read -r file; do",
    '    case "$file" in "$prefix"*) return 0 ;; esac',
    "  done < <(each_file)",
    "  return 1",
    "}",
    "",
    "file_index_for_path() {",
    '  local path="$1"',
    "  local index_path markdown_path i",
    '  for i in "${!DOC_FILES[@]}"; do if [ "${DOC_FILES[$i]}" = "$path" ]; then printf "%s\\n" "$i"; return 0; fi; done',
    '  if is_directory "$path"; then',
    '    index_path="$path/index.md"',
    '    for i in "${!DOC_FILES[@]}"; do if [ "${DOC_FILES[$i]}" = "$index_path" ]; then printf "%s\\n" "$i"; return 0; fi; done',
    "  fi",
    '  case "$path" in',
    "    *.md) ;;",
    '    *) markdown_path="$path.md"; for i in "${!DOC_FILES[@]}"; do if [ "${DOC_FILES[$i]}" = "$markdown_path" ]; then printf "%s\\n" "$i"; return 0; fi; done ;;',
    "  esac",
    "  return 1",
    "}",
    "",
    "machine_file_index_for_path() {",
    '  local path="$1"',
    "  local i",
    '  for i in "${!MACHINE_FILES[@]}"; do if [ "${MACHINE_FILES[$i]}" = "$path" ]; then printf "%s\\n" "$i"; return 0; fi; done',
    "  return 1",
    "}",
    "",
    "codebase_file_index_for_path() {",
    '  local path="$1"',
    "  local i",
    '  for i in "${!CODEBASE_FILES[@]}"; do if [ "${CODEBASE_FILES[$i]}" = "$path" ]; then printf "%s\\n" "$i"; return 0; fi; done',
    "  return 1",
    "}",
    "",
    "canonical_file_path() {",
    '  local path="$1"',
    "  local index",
    '  if index="$(file_index_for_path "$path")"; then printf "%s\\n" "${DOC_FILES[$index]}"; return 0; fi',
    '  if index="$(machine_file_index_for_path "$path")"; then printf "%s\\n" "${MACHINE_FILES[$index]}"; return 0; fi',
    '  if index="$(codebase_file_index_for_path "$path")"; then printf "%s\\n" "${CODEBASE_FILES[$index]}"; return 0; fi',
    "  return 1",
    "}",
    "",
    "body_for_file() {",
    '  local path="$1"',
    "  local index",
    '  if index="$(file_index_for_path "$path")"; then printf "%s" "${DOC_BODIES[$index]}" | decode_doc; return 0; fi',
    '  if index="$(machine_file_index_for_path "$path")"; then printf "%s" "${MACHINE_BODIES[$index]}" | decode_doc; return 0; fi',
    '  if index="$(codebase_file_index_for_path "$path")"; then printf "%s" "${CODEBASE_BODIES[$index]}" | decode_doc; return 0; fi',
    "  return 1",
    "}",
    "",
    "add_child() {",
    '  local child="$1"',
    "  local existing",
    '  for existing in "${children[@]}"; do if [ "$existing" = "$child" ]; then return; fi; done',
    '  children+=("$child")',
    "}",
    "",
    "direct_child_name() {",
    '  local parent="$1"',
    '  local child="$2"',
    "  local prefix remainder",
    '  if [ "$parent" = "/" ]; then',
    '    remainder="${child#/}"',
    "  else",
    '    prefix="$parent/"',
    '    case "$child" in "$prefix"*) remainder="${child#"$prefix"}" ;; *) return 1 ;; esac',
    "  fi",
    '  if [ -z "$remainder" ]; then return 1; fi',
    '  case "$remainder" in */*) printf "%s/\\n" "${remainder%%/*}" ;; *) printf "%s\\n" "$remainder" ;; esac',
    "}",
    "",
    "list_dir() {",
    '  local base="$1"',
    '  local target="${2:-}"',
    "  local dir file child first=1",
    "  children=()",
    '  dir="$(normalize_path "$base" "$target")" || return 1',
    '  if ! is_directory "$dir"; then printf "%s: not a directory\\n" "$dir"; return 1; fi',
    "  while IFS= read -r file; do",
    '    child="$(direct_child_name "$dir" "$file")" || continue',
    '    add_child "$child"',
    "  done < <(each_file)",
    '  for child in "${children[@]}"; do',
    '    if [ "$first" -eq 1 ]; then first=0; else printf "  "; fi',
    '    printf "%s" "$child"',
    "  done",
    "  printf '\\n'",
    "}",
    "",
    "show_doc_by_index() {",
    '  local index="$1"',
    '  printf "%s" "${DOC_BODIES[$index]}" | decode_doc',
    "}",
    "",
    "show_doc_by_path() {",
    '  local target="$1"',
    "  local resolved canonical",
    '  resolved="$(normalize_path "$cwd" "$target")" || return 1',
    '  if canonical="$(canonical_file_path "$resolved")"; then body_for_file "$canonical"; return 0; fi',
    '  printf "%s: not a file\\n" "$resolved"',
    "  return 1",
    "}",
    "",
    "parse_words() {",
    '  local input="$1"',
    '  local current="" quote="" ch next i',
    "  PARSED_WORDS=()",
    '  for ((i = 0; i < ${#input}; i += 1)); do',
    '    ch="${input:i:1}"',
    '    if [ -z "$quote" ]; then',
    '      if [[ "$ch" =~ [[:space:]] ]]; then',
    '        if [ -n "$current" ]; then PARSED_WORDS+=("$current"); current=""; fi',
    '      elif [ "$ch" = "\'" ] || [ "$ch" = \'"\' ]; then',
    '        quote="$ch"',
    '      elif [ "$ch" = "\\\\" ]; then',
    '        if [ "$i" -lt "$((${#input} - 1))" ]; then i=$((i + 1)); next="${input:i:1}"; current+="$next"; else current+="\\\\"; fi',
    "      else",
    '        current+="$ch"',
    "      fi",
    "    else",
    '      if [ "$ch" = "$quote" ]; then',
    '        quote=""',
    '      elif [ "$ch" = "\\\\" ]; then',
    '        if [ "$i" -lt "$((${#input} - 1))" ]; then i=$((i + 1)); next="${input:i:1}"; current+="$next"; else current+="\\\\"; fi',
    "      else",
    '        current+="$ch"',
    "      fi",
    "    fi",
    "  done",
    '  if [ -n "$quote" ]; then printf "unterminated %s quote\\n" "$quote"; return 1; fi',
    '  if [ -n "$current" ]; then PARSED_WORDS+=("$current"); fi',
    "}",
    "",
    "parse_common_search_args() {",
    '  local limit_default="$1"',
    "  shift",
    "  local word",
    "  SEARCH_JSON=0",
    '  SEARCH_LIMIT="$limit_default"',
    "  SEARCH_QUERY_WORDS=()",
    '  while [ "$#" -gt 0 ]; do',
    '    word="$1"; shift',
    '    case "$word" in',
    "      --json) SEARCH_JSON=1 ;;",
    "      --limit|-n)",
    '        if [ "$#" -eq 0 ]; then printf "%s: missing value\\n" "$word"; return 1; fi',
    '        SEARCH_LIMIT="$1"; shift',
    '        case "$SEARCH_LIMIT" in ""|*[!0-9]*|0) printf "%s: expected positive integer\\n" "$SEARCH_LIMIT"; return 1 ;; esac',
    "        ;;",
    '      -*) printf "%s: unknown option\\n" "$word"; return 1 ;;',
    '      *) SEARCH_QUERY_WORDS+=("$word") ;;',
    "    esac",
    "  done",
    "}",
    "",
    "is_path_like() {",
    '  case "$1" in /*|./*|../*|*.md|*/*) return 0 ;; *) return 1 ;; esac',
    "}",
    "",
    "trim_left() {",
    '  local value="$1"',
    '  value="${value#"${value%%[![:space:]]*}"}"',
    '  printf "%s" "$value"',
    "}",
    "",
    "add_search_match() {",
    '  SEARCH_FILES+=("$1")',
    '  SEARCH_LINE_NUMBERS+=("$2")',
    '  SEARCH_LINES+=("$3")',
    "}",
    "",
    "search_docs_collect() {",
    '  local query="$1"',
    '  local limit="$2"',
    "  local i body title_path line line_number needle haystack",
    "  SEARCH_FILES=(); SEARCH_LINE_NUMBERS=(); SEARCH_LINES=()",
    '  needle="$(lower "$query")"',
    '  for i in "${!DOC_TITLES[@]}"; do',
    '    title_path="${DOC_TITLES[$i]} ${DOC_DESCRIPTIONS[$i]} ${DOC_PATHS[$i]} ${DOC_FILES[$i]}"',
    '    body="$(printf "%s" "${DOC_BODIES[$i]}" | decode_doc)"',
    '    haystack="$(lower "$title_path")"',
    '    if [[ "$haystack" == *"$needle"* ]]; then add_search_match "${DOC_FILES[$i]}" "0" "${DOC_TITLES[$i]} - ${DOC_DESCRIPTIONS[$i]}"; fi',
    "    line_number=0",
    '    while IFS= read -r line; do',
    "      line_number=$((line_number + 1))",
    '      haystack="$(lower "$line")"',
    '      if [[ "$haystack" == *"$needle"* ]]; then add_search_match "${DOC_FILES[$i]}" "$line_number" "$(trim_left "$line")"; fi',
    '      if [ "${#SEARCH_FILES[@]}" -ge "$limit" ]; then return; fi',
    '    done <<< "$body"',
    '    if [ "${#SEARCH_FILES[@]}" -ge "$limit" ]; then return; fi',
    "  done",
    "}",
    "",
    "files_under() {",
    '  local directory="$1"',
    "  local file",
    '  if [ "$directory" = "/" ]; then each_file; return; fi',
    '  while IFS= read -r file; do case "$file" in "$directory"/*) printf "%s\\n" "$file" ;; esac; done < <(each_file)',
    "}",
    "",
    "grep_docs_collect() {",
    '  local query="$1"',
    '  local scope="${2:-}"',
    '  local limit="$3"',
    '  local resolved="/"',
    "  local canonical file body line line_number needle haystack",
    "  local scoped_files=()",
    "  SEARCH_FILES=(); SEARCH_LINE_NUMBERS=(); SEARCH_LINES=()",
    '  needle="$(lower "$query")"',
    '  if [ -n "$scope" ]; then',
    '    resolved="$(normalize_path "$cwd" "$scope")" || return 1',
    '    if is_directory "$resolved"; then while IFS= read -r file; do scoped_files+=("$file"); done < <(files_under "$resolved")',
    '    elif canonical="$(canonical_file_path "$resolved")"; then scoped_files+=("$canonical")',
    '    else printf "%s: not a file or directory\\n" "$resolved"; return 1; fi',
    "  else",
    '    while IFS= read -r file; do scoped_files+=("$file"); done < <(files_under "/")',
    "  fi",
    '  for file in "${scoped_files[@]}"; do',
    '    body="$(body_for_file "$file")" || continue',
    "    line_number=0",
    '    while IFS= read -r line; do',
    "      line_number=$((line_number + 1))",
    '      haystack="$(lower "$line")"',
    '      if [[ "$haystack" == *"$needle"* ]]; then add_search_match "$file" "$line_number" "$(trim_left "$line")"; fi',
    '      if [ "${#SEARCH_FILES[@]}" -ge "$limit" ]; then return 0; fi',
    '    done <<< "$body"',
    "  done",
    "}",
    "",
    "print_search_matches() {",
    '  local include_title="${1:-1}"',
    "  local i",
    '  for i in "${!SEARCH_FILES[@]}"; do',
    '    if [ "${SEARCH_LINE_NUMBERS[$i]}" = "0" ]; then',
    '      if [ "$include_title" = "1" ]; then printf "%s: %s\\n" "${SEARCH_FILES[$i]}" "${SEARCH_LINES[$i]}"; fi',
    "    else",
    '      printf "%s:%s: %s\\n" "${SEARCH_FILES[$i]}" "${SEARCH_LINE_NUMBERS[$i]}" "${SEARCH_LINES[$i]}"',
    "    fi",
    "  done",
    "}",
    "",
    "print_search_json() {",
    "  local i",
    '  printf "{\\n  \\"matches\\": ["',
    '  for i in "${!SEARCH_FILES[@]}"; do',
    '    if [ "$i" -gt 0 ]; then printf ","; fi',
    '    printf "\\n    {\\n      \\"file\\": "; json_escape "${SEARCH_FILES[$i]}"',
    '    printf ",\\n      \\"lineNumber\\": %s,\\n      \\"line\\": " "${SEARCH_LINE_NUMBERS[$i]}"',
    '    json_escape "${SEARCH_LINES[$i]}"',
    '    printf "\\n    }"',
    "  done",
    '  printf "\\n  ]\\n}\\n"',
    "}",
    "",
    "search_command() {",
    "  local query",
    '  if ! parse_common_search_args 20 "$@"; then return 1; fi',
    '  query="$(join_words "${SEARCH_QUERY_WORDS[@]}")"',
    '  if [ -z "$query" ]; then printf "search: missing query\\n"; return 1; fi',
    '  search_docs_collect "$query" "$SEARCH_LIMIT"',
    '  if [ "$SEARCH_JSON" = "1" ]; then print_search_json; [ "${#SEARCH_FILES[@]}" -gt 0 ]; return; fi',
    '  if [ "${#SEARCH_FILES[@]}" -eq 0 ]; then printf "no matches\\n"; return 1; fi',
    "  print_search_matches 1",
    "}",
    "",
    "grep_command() {",
    '  local query scope=""',
    '  if ! parse_common_search_args 20 "$@"; then return 1; fi',
    '  if [ "${#SEARCH_QUERY_WORDS[@]}" -ge 2 ] && is_path_like "${SEARCH_QUERY_WORDS[$((${#SEARCH_QUERY_WORDS[@]} - 1))]}"; then',
    '    scope="${SEARCH_QUERY_WORDS[$((${#SEARCH_QUERY_WORDS[@]} - 1))]}"',
    '    unset "SEARCH_QUERY_WORDS[$((${#SEARCH_QUERY_WORDS[@]} - 1))]"',
    "  fi",
    '  query="$(join_words "${SEARCH_QUERY_WORDS[@]}")"',
    '  if [ -z "$query" ]; then printf "grep: missing query\\n"; return 1; fi',
    '  if ! grep_docs_collect "$query" "$scope" "$SEARCH_LIMIT"; then return 1; fi',
    '  if [ "$SEARCH_JSON" = "1" ]; then print_search_json; [ "${#SEARCH_FILES[@]}" -gt 0 ]; return; fi',
    '  if [ "${#SEARCH_FILES[@]}" -eq 0 ]; then printf "no matches\\n"; return 1; fi',
    "  print_search_matches 0",
    "}",
    "",
    "context_command() {",
    "  local token_budget=4000 limit=6 json=0 query word resolved file seen i body markdown estimated used=0",
    "  local query_words=() json_docs=() json_estimates=() json_bodies=()",
    "  CONTEXT_FILES=()",
    '  while [ "$#" -gt 0 ]; do',
    '    word="$1"; shift',
    '    case "$word" in',
    "      --json) json=1 ;;",
    "      --tokens)",
    '        if [ "$#" -eq 0 ]; then printf "%s\\n" "--tokens: missing value"; return 1; fi',
    '        token_budget="$1"; shift; case "$token_budget" in ""|*[!0-9]*|0) printf "%s: expected positive integer\\n" "$token_budget"; return 1 ;; esac ;;',
    "      --limit|-n)",
    '        if [ "$#" -eq 0 ]; then printf "%s: missing value\\n" "$word"; return 1; fi',
    '        limit="$1"; shift; case "$limit" in ""|*[!0-9]*|0) printf "%s: expected positive integer\\n" "$limit"; return 1 ;; esac ;;',
    '      -*) printf "%s: unknown option\\n" "$word"; return 1 ;;',
    '      *) query_words+=("$word") ;;',
    "    esac",
    "  done",
    '  query="$(join_words "${query_words[@]}")"',
    '  if [ -z "$query" ]; then',
    '    while IFS= read -r file; do CONTEXT_FILES+=("$file"); done < <(files_under "/docs")',
    "  else",
    '    resolved="$(normalize_path "$cwd" "$query")"',
    '    if is_directory "$resolved"; then while IFS= read -r file; do CONTEXT_FILES+=("$file"); done < <(files_under "$resolved")',
    '    elif i="$(file_index_for_path "$resolved")"; then CONTEXT_FILES+=("${DOC_FILES[$i]}")',
    "    else",
    '      search_docs_collect "$query" 200',
    '      for file in "${SEARCH_FILES[@]}"; do',
    "        seen=0",
    '        for existing in "${CONTEXT_FILES[@]}"; do if [ "$existing" = "$file" ]; then seen=1; fi; done',
    '        if [ "$seen" = "0" ]; then CONTEXT_FILES+=("$file"); fi',
    "      done",
    "    fi",
    "  fi",
    '  if [ "${#CONTEXT_FILES[@]}" -eq 0 ]; then',
    '    if [ "$json" = "1" ]; then printf "{\\n  \\"query\\": "; json_escape "$query"; printf ",\\n  \\"tokenBudget\\": %s,\\n  \\"estimatedTokens\\": 0,\\n  \\"docs\\": []\\n}\\n" "$token_budget"; else printf "context: no matching docs\\n"; fi',
    "    return 1",
    "  fi",
    '  for file in "${CONTEXT_FILES[@]}"; do',
    '    if [ "${#json_docs[@]}" -ge "$limit" ]; then break; fi',
    '    i="$(file_index_for_path "$file")" || continue',
    '    body="$(printf "%s" "${DOC_BODIES[$i]}" | decode_doc)"',
    '    estimated="$(estimate_tokens "$body")"',
    '    if [ "${#json_docs[@]}" -gt 0 ] && [ "$((used + estimated))" -gt "$token_budget" ]; then break; fi',
    '    if [ "$((used + estimated))" -gt "$token_budget" ]; then body="$(truncate_to_token_budget "$body" "$((token_budget - used))")"; estimated="$(estimate_tokens "$body")"; fi',
    "    used=$((used + estimated))",
    '    json_docs+=("$file")',
    '    json_estimates+=("$estimated")',
    '    json_bodies+=("$body")',
    '    if [ "$used" -ge "$token_budget" ]; then break; fi',
    "  done",
    '  if [ "$json" = "1" ]; then',
    '    printf "{\\n  \\"query\\": "; json_escape "$query"',
    '    printf ",\\n  \\"tokenBudget\\": %s,\\n  \\"estimatedTokens\\": %s,\\n  \\"docs\\": [" "$token_budget" "$used"',
    '    for i in "${!json_docs[@]}"; do',
    '      local file_path="${json_docs[$i]}" doc_index',
    '      doc_index="$(file_index_for_path "$file_path")"',
    '      body="${json_bodies[$i]}"',
    '      estimated="${json_estimates[$i]}"',
    '      if [ "$i" -gt 0 ]; then printf ","; fi',
    '      printf "\\n    {\\n      \\"file\\": "; json_escape "$file_path"',
    '      printf ",\\n      \\"title\\": "; json_escape "${DOC_TITLES[$doc_index]}"',
    '      printf ",\\n      \\"description\\": "; json_escape "${DOC_DESCRIPTIONS[$doc_index]}"',
    '      printf ",\\n      \\"markdown\\": "; json_escape "$body"',
    '      printf ",\\n      \\"estimatedTokens\\": %s\\n    }" "$estimated"',
    "    done",
    '    printf "\\n  ]\\n}\\n"',
    "    return 0",
    "  fi",
  '  printf "# Rigkit Docs Context\\nQuery: %s\\nEstimated tokens: %s\\n" "${query:-/}" "$used"',
    '  for context_index in "${!json_docs[@]}"; do',
    '    file="${json_docs[$context_index]}"',
    '    doc_index="$(file_index_for_path "$file")" || continue',
    '    markdown="${json_bodies[$context_index]}"',
    '    printf "\\n## %s - %s\\n%s\\n\\n%s\\n" "$file" "${DOC_TITLES[$doc_index]}" "${DOC_DESCRIPTIONS[$doc_index]}" "$markdown"',
    "  done",
    "}",
    "",
    "version_command() {",
    "  local json=0 word",
    '  for word in "$@"; do case "$word" in --json) json=1 ;; *) printf "%s: unknown option\\n" "$word"; return 1 ;; esac; done',
    '  if [ "$json" = "1" ]; then',
    '    printf "{\\n  \\"service\\": "; json_escape "${FREESTYLE_DOCS_SSH_SERVICE:-freestyle-docs-ssh}"',
    '    printf ",\\n  \\"binaryVersion\\": "; json_escape "${FREESTYLE_DOCS_SSH_BINARY_VERSION:-unknown}"',
    '    printf ",\\n  \\"gitSha\\": "; json_escape "${FREESTYLE_DOCS_SSH_GIT_SHA:-unknown}"',
    '    printf ",\\n  \\"docsSource\\": "; json_escape "${FREESTYLE_DOCS_SSH_SOURCE:-unknown}"',
    '    printf ",\\n  \\"docsGeneratedAt\\": "; json_escape "$DOC_GENERATED_AT"',
    '    printf ",\\n  \\"docsLoadedAtUnixSeconds\\": %s,\\n  \\"docCount\\": %s,\\n  \\"codebaseFileCount\\": %s\\n}\\n" "${FREESTYLE_DOCS_SSH_LOADED_AT_UNIX_SECONDS:-0}" "${#DOC_FILES[@]}" "${#CODEBASE_FILES[@]}"',
    "    return 0",
    "  fi",
    '  printf "freestyle-docs-ssh %s\\n" "${FREESTYLE_DOCS_SSH_BINARY_VERSION:-unknown}"',
    '  printf "gitSha: %s\\n" "${FREESTYLE_DOCS_SSH_GIT_SHA:-unknown}"',
    '  printf "docsSource: %s\\n" "${FREESTYLE_DOCS_SSH_SOURCE:-unknown}"',
    '  printf "docsGeneratedAt: %s\\n" "$DOC_GENERATED_AT"',
    '  printf "docsLoadedAtUnixSeconds: %s\\n" "${FREESTYLE_DOCS_SSH_LOADED_AT_UNIX_SECONDS:-0}"',
    '  printf "docCount: %s\\n" "${#DOC_FILES[@]}"',
    '  printf "codebaseFileCount: %s\\n" "${#CODEBASE_FILES[@]}"',
    "}",
    "",
    "print_tree() {",
    "  local file",
    "  printf '/\\n'",
    "  while IFS= read -r file; do",
    '    printf "  %s\\n" "${file#/}"',
    "  done < <(each_file)",
    "}",
    "",
    "print_tree_json() {",
    "  local i file path kind",
    '  printf "{\\n  \\"entries\\": [\\n    { \\"path\\": \\"/\\", \\"kind\\": \\"directory\\" }"',
    "  while IFS= read -r file; do",
    '    printf ",\\n    { \\"path\\": "; json_escape "$file"; printf ", \\"kind\\": \\"file\\" }"',
    "  done < <(each_file)",
    '  printf "\\n  ]\\n}\\n"',
    "}",
    "",
    "print_menu() {",
    "  local i",
  "  printf 'Rigkit Docs\\n===========\\n\\n'",
    '  for i in "${!DOC_TITLES[@]}"; do printf "%2d  %-24s %s\\n" "$((i + 1))" "${DOC_TITLES[$i]}" "${DOC_FILES[$i]}"; done',
    "}",
    "",
    "split_path_completion() {",
    '  local value="$1"',
    '  if [[ "$value" == */* ]]; then COMPLETION_PARENT="${value%/*}/"; COMPLETION_FRAGMENT="${value##*/}"; else COMPLETION_PARENT=""; COMPLETION_FRAGMENT="$value"; fi',
    "}",
    "",
    "path_completion_candidates() {",
    '  local arg="$1" include_files="$2" include_dirs="$3"',
    "  local parent fragment lookup_parent dir file child name",
    '  split_path_completion "$arg"',
    '  parent="$COMPLETION_PARENT"; fragment="$COMPLETION_FRAGMENT"; lookup_parent="$parent"',
    '  if [ -z "$lookup_parent" ]; then lookup_parent="."; fi',
    '  dir="$(normalize_path "$cwd" "$lookup_parent")" || return',
    '  if ! is_directory "$dir"; then return; fi',
    "  children=()",
    "  while IFS= read -r file; do",
    '    child="$(direct_child_name "$dir" "$file")" || continue',
    '    add_child "$child"',
    "  done < <(each_file)",
    '  for child in "${children[@]}"; do',
    '    name="${child%/}"',
    '    if [[ "$name" == "$fragment"* ]]; then',
    '      if [[ "$child" == */ ]]; then [ "$include_dirs" = "1" ] && printf "%s%s\\n" "$parent" "$child";',
    '      else [ "$include_files" = "1" ] && printf "%s%s \\n" "$parent" "$child"; fi',
    "    fi",
    "  done",
    "}",
    "",
    "common_prefix() {",
    '  local prefix="$1" candidate',
    "  shift",
    '  for candidate in "$@"; do while [[ "$candidate" != "$prefix"* ]]; do prefix="${prefix%?}"; done; done',
    '  printf "%s\\n" "$prefix"',
    "}",
    "",
    "emit_completion() {",
    '  local original="$1" line_prefix="$2"',
    "  shift 2",
    "  local candidates=(\"$@\") candidate prefix",
    '  if [ "${#candidates[@]}" -eq 0 ]; then return; fi',
    '  if [ "${#candidates[@]}" -eq 1 ]; then printf "line\\t%s%s\\n" "$line_prefix" "${candidates[0]}"; return; fi',
    '  prefix="$(common_prefix "${candidates[0]}" "${candidates[@]}")"',
    '  if [ "${#prefix}" -gt "${#original}" ]; then printf "line\\t%s%s\\n" "$line_prefix" "$prefix"; return; fi',
    '  for candidate in "${candidates[@]}"; do printf "suggestion\\t%s\\n" "${candidate%"${candidate##*[![:space:]]}"}"; done',
    "}",
    "",
    "complete_path() {",
    '  local line_prefix="$1" arg="$2" include_files="$3" include_dirs="$4"',
    "  local candidates=() candidate",
    '  while IFS= read -r candidate; do candidates+=("$candidate"); done < <(path_completion_candidates "$arg" "$include_files" "$include_dirs")',
    '  emit_completion "$arg" "$line_prefix" "${candidates[@]}"',
    "}",
    "",
    "complete_first_word() {",
    '  local word="$1" command candidate',
    "  local candidates=()",
    '  if [[ "$word" == *"/"* ]] || [[ "$word" == .* ]]; then complete_path "" "$word" 1 1; return; fi',
    '  for command in "${COMMANDS[@]}"; do [[ "$command" == "$word"* ]] && candidates+=("$command "); done',
    '  while IFS= read -r candidate; do candidates+=("$candidate"); done < <(path_completion_candidates "$word" 1 1)',
    '  emit_completion "$word" "" "${candidates[@]}"',
    "}",
    "",
    "complete_grep_path() {",
    '  local line_prefix="$1"',
    "  shift",
    "  local words=(\"$@\") path query_prefix",
    '  if [ "${#words[@]}" -lt 2 ]; then return; fi',
    '  path="${words[$((${#words[@]} - 1))]}"',
    '  unset "words[$((${#words[@]} - 1))]"',
    '  query_prefix="$line_prefix$(join_words "${words[@]}") "',
    '  complete_path "$query_prefix" "$path" 1 1',
    "}",
    "",
    "complete_line() {",
    '  local line="$1" command rest prefix arg',
    '  if [[ "$line" =~ ^[[:space:]] ]]; then return; fi',
    '  if [[ "$line" != *[[:space:]]* ]]; then complete_first_word "$line"; return; fi',
    '  command="${line%%[[:space:]]*}"',
    '  rest="${line#"$command"}"',
    '  prefix="$command"',
    '  while [[ "$rest" =~ ^[[:space:]] ]]; do prefix+="${rest:0:1}"; rest="${rest:1}"; done',
    '  arg="$rest"',
    '  case "$command" in',
    '    cd) complete_path "$prefix" "$arg" 0 1 ;;',
    '    ls|cat|open|context) complete_path "$prefix" "$arg" 1 1 ;;',
    '    grep) if parse_words "$arg"; then complete_grep_path "$prefix" "${PARSED_WORDS[@]}"; fi ;;',
    "  esac",
    "}",
    "",
    "run_command_words() {",
    '  local command="${1:-}" target resolved index',
    '  if [ "$#" -gt 0 ]; then shift; fi',
    '  case "$command" in',
    "    \"\") return 0 ;;",
    "    help|\"?\") print_help ;;",
    '    pwd) printf "%s\\n" "$cwd" ;;',
    '    ls) list_dir "$cwd" "$(join_words "$@")" ;;',
    "    cd)",
    '      target="$(join_words "$@")"; target="${target:-/}"',
    '      resolved="$(normalize_path "$cwd" "$target")" || return 1',
    '      if is_directory "$resolved"; then cwd="$resolved"; else printf "%s: not a directory\\n" "$resolved"; return 1; fi ;;',
    "    cat|open)",
    '      if [ "$#" -eq 0 ]; then printf "%s: missing path\\n" "$command"; return 1; else show_doc_by_path "$(join_words "$@")"; fi ;;',
    '    search) search_command "$@" ;;',
    '    grep) grep_command "$@" ;;',
    '    context) context_command "$@" ;;',
    "    tree)",
    '      if [ "${1:-}" = "--json" ]; then if [ "$#" -gt 1 ]; then printf "%s: unknown option\\n" "$2"; return 1; fi; print_tree_json',
    '      elif [ "$#" -gt 0 ]; then printf "%s: unknown option\\n" "$1"; return 1',
    "      else print_tree; fi ;;",
    '    version) version_command "$@" ;;',
    "    menu) print_menu ;;",
    "    clear) printf '\\033[2J\\033[H' ;;",
    '    exit|quit|logout) printf "bye\\n"; ssh_should_close=1 ;;',
    "    [0-9]*)",
    '      case "$command" in',
    '        *[!0-9]*) printf "%s: unknown command\\n" "$command"; return 127 ;;',
    '        *) index="$((command - 1))"; if [ "$index" -ge 0 ] && [ "$index" -lt "${#DOC_TITLES[@]}" ]; then show_doc_by_index "$index"; else printf "%s: no docs entry\\n" "$command"; return 1; fi ;;',
    "      esac ;;",
    '    *) printf "%s: unknown command\\nType help for commands.\\n" "$command"; return 127 ;;',
    "  esac",
    "}",
    "",
    "run_command_line() {",
    '  local line="$1"',
    '  if ! parse_words "$line"; then return 1; fi',
    '  run_command_words "${PARSED_WORDS[@]}"',
    "}",
    "",
    'case "${1:-}" in',
    "  __ssh_welcome)",
    '    cwd="${2:-/}"',
    "    print_welcome",
    "    exit 0 ;;",
    "  __ssh_prompt)",
    '    cwd="${2:-/}"',
    "    print_prompt",
    "    exit 0 ;;",
    "  __ssh_exec)",
    '    cwd="${2:-/}"',
    '    line="${3:-}"',
    '    if run_command_line "$line"; then status=0; else status=$?; fi',
    '    write_ssh_state "$status" "$ssh_should_close"',
    '    exit "$status" ;;',
    "  __ssh_complete)",
    '    cwd="${2:-/}"',
    '    complete_line "${3:-}"',
    "    exit 0 ;;",
    "esac",
    "",
    'if [ "$#" -gt 0 ]; then',
    '  run_command_words "$@"',
    '  exit "$?"',
    "fi",
    "",
    "print_menu",
    "printf '\\nType help for commands.\\n\\n'",
    "",
    "while true; do",
    "  print_prompt",
    "  IFS= read -r line || exit 0",
    '  run_command_line "$line" || true',
    '  if [ "$ssh_should_close" = "1" ]; then exit 0; fi',
    "done",
    "",
  ].join("\n");
}
