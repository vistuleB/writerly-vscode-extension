# Writerly VSCode Extension

Writerly is a markup language extension for VS Code that makes creating structured documents easier. This extension provides syntax highlighting, error reporting, and navigation tools for Writerly (`.wly` and `.writerly`) files.

## Features

### Open and Preview Files & Images

- Open any file under your cursor with the default application by using `Ctrl+Shift+O` (or `Cmd+Shift+O` on Mac)
- Hover over filenames to preview images directly inside of documents (supports PNG, JPG, SVG, and more)
- Get file suggestions when typing `src=` or `original=` attributes

### Navigate Your Documents

- Create links between sections using `>>MyRef` handles
- Jump to any link with `F12`
- Rename links everywhere with `F2`
- See warnings about unused links

### Smart Writing Help

- Get real-time feedback about your formatting
- See warnings for undefined references
- Auto-complete file paths when typing `src=` or `original=`

### Manage Files From the Editor

- Rename the file referenced under your cursor (and update every Writerly reference to it)
- Move the file under your cursor to another directory in the workspace (references are updated too)
- Create a new file from a template by placing your cursor on a not-yet-existing file path

## Available Commands

- `writerly.openUnderCursorWithDefault` - Open file under cursor with system default
- `writerly.openUnderCursorWithVSCode` - Open file under cursor with VS Code
- `writerly.openUnderCursorAsImageWithVSCode` - Open image under cursor with VS Code
- `writerly.openFileWithDefault` - Open current file with system default
- `writerly.renameFileUnderCursor` - Rename the file under the cursor and update references
- `writerly.moveFileUnderCursor` - Move the file under the cursor to another workspace directory
- `writerly.createFileUnderCursorFromTemplate` - Create the file under the cursor from a matching template
- `writerly.restart` - Restart the extension

## Creating Files From Templates

The `writerly.createFileUnderCursorFromTemplate` command lets you scaffold a new file directly from a path written in your document. Place the cursor on a file path that does **not** exist yet and run the command. The extension will:

1. Resolve the directory portion of the path to a unique directory in the workspace (it aborts if the directory is ambiguous or missing, or if a file with that name already exists).
2. Look up your configured template files directory (see below).
3. Collect every template file (recursively) sharing the same extension as the new file.
4. Pick the template whose name shares the longest suffix with the new file name.
5. Copy that template to the new location, while renaming it to the new file name.

### Configuring the template directory

The command requires the `writerly.templateFilesDirectory` setting, which points to a directory in your workspace that holds your template files. The value is matched against directories in your workspace and **must resolve to exactly one directory** (the command aborts otherwise). A leading `./` is allowed.

This setting is workspace-scoped — You can set it in the workspace's `.vscode/settings.json`:

```jsonc
{
  "writerly.templateFilesDirectory": "./templates"
}
```
