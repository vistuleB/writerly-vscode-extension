# Writerly for VS Code

[Writerly](https://github.com/vistuleB/wly/tree/main/writerly) is a markup language for authoring structured documents with math support, inspired by [Elm-Markup](https://github.com/mdgriffith/elm-markup). It uses Python-style indentation instead of angle brackets. This extension adds language support for `.wly` files.

## Features

### Syntax support

- Syntax highlighting for `.wly` and `.writerly` files
- Real-time validation with error diagnostics (indentation, tag names, code blocks)

### File and image opening

Place your cursor on any file path in a `.wly` document:

- **`Ctrl+Shift+O`** (`Cmd+Shift+O` on Mac) — open with the system default application
- **Right-click** — open the file under cursor or the current file with the system default application
- **Hover** — see file size, image preview, and links to open with VS Code or as an image

Supported formats: `.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.webp`, `.bmp`, `.ico`

### Document navigation

Writerly uses a "handle" system for cross-referencing. An element with `handle=MyRef` defines a reference point; `>>MyRef` elsewhere links to it.

- **Go to Definition** (`F12`) — jump from a `>>` reference to its definition, even across files in a `__parent.wly` document tree
- **Rename** (`F2`) — rename a handle everywhere it appears in the document tree
- **Diagnostics** — warnings for undefined or ambiguous references
- **Quick fixes** — suggestions when multiple definitions exist

Unused handle warnings can be toggled in settings.

### Path autocomplete

When typing `src=` or `original=` attribute values, the extension suggests matching files with directory-aware navigation and image previews.

### WLY Explorer sidebar

Lists all `.wly` files in the workspace, organized by directory. The currently open file is highlighted automatically.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `writerly.enableUnusedHandleWarnings` | `true` | Show warnings for handle definitions that are never referenced |