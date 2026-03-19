# Writerly for VS Code

Writerly is a markup language extension for VS Code that makes creating structured documents easier. It supports math formatting and helps you navigate between `.wly` files using simple references called "handles."

## Features 

### Open Files & Images
- Quickly open any file under your cursor with `Ctrl+Shift+O` (or `Cmd+Shift+O` on Mac)
- View images directly in documents (supports PNG, JPG, SVG, and more)
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

## Available Commands
- `writerly.openUnderCursorWithDefault` - Open file under cursor with system default
- `writerly.openUnderCursorWithVSCode` - Open file under cursor with VS Code
- `writerly.openUnderCursorAsImageWithVSCode` - Open image under cursor with VS Code
- `writerly.openFileWithDefault` - Open current file with system default
- `writerly.restart` - Restart the extension
```
