# Writerly VSCode Extension

Writerly is a markup language extension for VS Code that makes creating structured documents easier. This extension provides syntax highlighting, error reporting, and navigation tools for Writerly (`.wly`) files.

## Features

### Open and Preview Files & Images

- Open any file under your cursor with the default application by using `Ctrl+Shift+O` (or `Cmd+Shift+O` on Mac)
- Hover over resolved image filenames to preview supported image files
- Get file path suggestions in supported path-bearing attributes and Markdown links

### Navigate Your Documents

- Create links between sections using `>>MyRef` handle usages
- Define handles with `handle=MyRef` attributes or in text with `MyRef##<<`
- Jump to any link with `F12`
- Rename links everywhere with `F2`
- See warnings about unused handle definitions
- Inspect the current file's Writerly document tree from the status bar or the `Writerly: Inspect Document Tree` command

### Smart Writing Help

- Get diagnostics for indentation, tabs in initial whitespace, tag syntax, empty tags, and code block structure
- See diagnostics for undefined handles, duplicate handle definitions, and invalid handle names
- Auto-complete file paths in supported path contexts

### Manage Files From the Editor

- Rename the file referenced under your cursor and update matching path text in Writerly files
- Move the file under your cursor to another directory in the workspace and update matching path text in Writerly files
- Move multiple selected file references at once when they share the same source directory
- Use `F2` / Rename Symbol on the filename part of a file path to rename the referenced file
- Use `F2` / Rename Symbol on the directory part of a file path to move the referenced file
- Create a new file from a template by placing your cursor on a not-yet-existing file path

## Handles

Handle definitions are indexed across the active Writerly file set. A handle can
be defined as an attribute line after a tag:

```writerly
|> section
    handle=MyRef
```

It can also be defined inline in text:

```writerly
MyRef##<<
```

Handle usages use `>>`:

```writerly
See >>MyRef
```

`F12` goes to a single unambiguous definition. `F2` renames matching definitions
and usages in the same document tree. Undefined usages, duplicate definitions,
invalid names, and optionally unused definitions are reported as diagnostics.

## Writerly Document Trees

For editor features, the extension groups `.wly` files into document trees using
the same directory shape as Writerly assembly.

Two different Writerly files belong to the same extension document tree when
there is some directory that contains both files as part of its `.wly` subtree:

- The directory must contain at least one direct `.wly` file.
- Both files must be `.wly` descendants of that directory.
- `__parent.wly` is not required for document-tree membership. It affects the
  assembled structure by making descendant files appear nested under that parent
  file.
- A single `.wly` file also has its own document scope.

Path segments starting with `#` are treated as commented-out islands inside the
same document tree:

- Duplicate handles conflict only within the same island.
- Go to definition uses the nearest accessible island, meaning the current
  island or an ancestor island.
- Definitions found only in other `#` islands are reported as inaccessible.
- Handle rename still applies across the whole document tree.

## Available Commands

- `writerly.openUnderCursorWithDefault` - Open file under cursor with system default
- `writerly.openUnderCursorWithVSCode` - Open file under cursor with VS Code
- `writerly.openUnderCursorAsImageWithVSCode` - Open image under cursor with VS Code
- `writerly.openFileWithDefault` - Open current file with system default
- `writerly.renameFileUnderCursor` - Rename the file under the cursor and update references
- `writerly.moveFileUnderCursor` - Move the file or same-directory multi-cursor files under selection to another workspace directory
- `writerly.createFileUnderCursorFromTemplate` - Create a file from a matching template
- `writerly.restart` - Restart the extension

## Creating Files From Templates

The `writerly.createFileUnderCursorFromTemplate` command, shown as **Writerly: Create File From Template**, lets you scaffold a new file directly from a path written in your document. Place the cursor on a file path that does **not** exist yet and run the command. The extension will:

1. Resolve the directory portion of the path to a unique directory in the workspace (it aborts if the directory is ambiguous or missing, or if a file with that name already exists). Bare directory paths are suffix-matched. Paths beginning with `./` are resolved relative to the workspace folder containing the active Writerly document.
2. Look up your configured template files directory (see below).
3. Collect every template file (recursively) sharing the same extension as the new file.
4. Pick the template whose name shares the longest suffix with the new file name.
5. Copy that template to the new location, while renaming it to the new file name.

### Configuring the template directory

The command requires the `writerly.templateFilesDirectory` setting, which points to a directory in your workspace that holds your template files. Bare paths are matched against directory suffixes in the workspace and **must resolve to exactly one directory** (the command aborts otherwise). A leading `./` makes the path relative to the workspace folder containing the active Writerly document.

This setting is workspace-scoped — You can set it in the workspace's `.vscode/settings.json`:

```jsonc
{
  "writerly.templateFilesDirectory": "./templates"
}
```

## Path Resolution

Under-cursor open, hover, rename, move, and create-from-template commands
resolve path text against files or directories in the workspace.

- File operations use the path text under the cursor to find matching files in
  the workspace.
- If exactly one file matches, that file is used.
- If multiple files match, Writerly resolves the target by choosing the unique
  closest match relative to the active document's nearest Writerly container.
- If multiple matches tie as closest, the operation aborts and reports the
  matching paths.
- Hover requires one unique matching file. If the path is missing or ambiguous,
  no hover is shown.
- Directory prompts for create-from-template use the same container-distance
  disambiguation rule.
- Move destination directories also ignore same-named directories that are
  closer to another topmost Writerly root.
- Bare directory paths are suffix-matched anywhere in the workspace.
- Directory paths beginning with `./` are resolved relative to the workspace
  folder containing the active Writerly document.

Reference updates after file rename/move use matching text replacement in
Writerly files:

- all active Writerly files in the workspace are scanned
- candidate matches are literal matches of the old reference string
- if a candidate's closest resolved file is different from the original target,
  that candidate is left unchanged
- if a candidate ties between multiple closest matches, the whole rename/move
  operation aborts before applying edits
- if a candidate resolves closest to the same original target, it is rewritten
- each changed document is updated with a full-document text edit
- replacements are not parser-aware and are not limited to specific attributes

## File Path Completion

Path completion is offered in:

- Writerly attribute values whose attribute name ends with `src`
- these exact attribute names: `original`, `href`, `srcset`, `poster`, `data`,
  `background`, `icon`, `favicon`, `image`, `logo`, `thumbnail`, `preview`,
  `cover`, `file`, `path`, `url`, `uri`, `source`, `use`
- Markdown link and image paths in text lines, such as
  `[label](path/to/file.txt)` and `![alt](path/to/image.png)`

All workspace files are indexed, excluding hidden folders, `node_modules`, and
build output folders. Supported image files show a preview in the completion
documentation popup.

## Diagnostics And Language Behavior

The extension reports diagnostics for:

- indentation that is too deep, too low, or not a multiple of four spaces
- tabs in initial whitespace
- empty tags
- invalid tag names
- code block openings inside code blocks
- unclosed code blocks
- spaces in code block info annotations
- invalid handle names
- undefined handle usages
- duplicate handle definitions in the same hash island
- unused handle definitions, when enabled

Language configuration:

- `!!` is the line comment marker.
- Pressing Enter after a `|>` line auto-indents the next line.
- `{}`, `[]`, `()`, and `""` are configured as auto-closing/surrounding pairs.
- Folding is indentation-based.

## File Association Settings

Writerly contributes `.wly` as its language extension. To make `.wly` open as
another language in user or workspace settings, use VS Code file associations:

```jsonc
{
  "files.associations": {
    "*.wly": "plaintext"
  }
}
```

To force `.wly` back to Writerly in a workspace where another association wins:

```jsonc
{
  "files.associations": {
    "*.wly": "writerly"
  }
}
```

## Other Settings

Unused handle warnings are enabled by default:

```jsonc
{
  "writerly.enableUnusedHandleWarnings": true
}
```

Set it to `false` to keep handle diagnostics enabled while suppressing unused
definition warnings.
