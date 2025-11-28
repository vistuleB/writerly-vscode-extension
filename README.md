# Writerly VSCode Extension

Syntax highlighting and VSCode language support for Writerly (.wly) files with enhanced file navigation capabilities.

## Features

### 🎨 Language Support
- Syntax highlighting for Writerly (.wly) files
- Language configuration and grammar support
- Document validation and error detection

### 🔗 File Navigation (Improved!)
- **Open File Under Cursor**: Navigate to files referenced in your Writerly documents with improved detection
- **Smart Path Resolution**: Automatically resolves relative and absolute file paths
- **Multi-format Support**: Opens images, documents, and code files with system default applications
- **Hover Previews**: See file information and image previews when hovering over file paths
- **Reliable Opening**: Uses VSCode's native opening method with system fallback
- **Better Path Detection**: Accurate cursor-based detection

## Supported File Types

The extension can open the following file types with your system's default application:

**Images**: `.png`, `.jpg`, `.jpeg`, `.gif`, `.bmp`, `.svg`, `.webp`, `.ico`
**Documents**: `.pdf`, `.txt`, `.md`, `.html`
**Code Files**: `.css`, `.js`, `.ts`, `.json`, `.xml`, `.yml`, `.yaml`

## Usage

### Opening Files Under Cursor

1. **Keyboard Shortcut**: 
   - Mac: `Cmd+Shift+O`
   - Windows/Linux: `Ctrl+Shift+O`

2. **Command Palette**:
   - Press `Cmd+Shift+P` (Mac) or `Ctrl+Shift+P` (Windows/Linux)
   - Search for "Open File Under Cursor"

3. **How it works**:
   - Place your cursor on any file path in your Writerly document
   - Use the keyboard shortcut or command palette
   - The file will open with your system's default application

### File Path Examples

The extension recognizes various file path formats with improved detection:

```writerly
# Direct paths
../logo.png
./images/header.jpg
assets/background.svg

# Quoted paths (improved detection)
"../documents/manual.pdf"
'./styles/main.css'
`./config/settings.json`

# Mixed content (cursor can be anywhere in the path)
Check out the logo at ../logo.png for our branding.
The configuration is stored in "./config/app.json".
Documentation is in '../README.md' and license in `../LICENSE`.
```

**Improved cursor detection**: You can now place your cursor anywhere within a file path (beginning, middle, or end) and it will be detected accurately.

### Hover Previews

Hover over any supported file path to see:
- File name and extension
- Full resolved path
- File size and last modified date
- Image preview (for image files)
- Quick action to open the file

## Path Resolution & Opening

The extension intelligently resolves file paths in the following order:

1. **Absolute paths**: Used directly if they exist
2. **Relative to current document**: Resolved relative to the current `.writerly` file's directory
3. **Relative to workspace root**: Resolved relative to the workspace folder
4. **Auto-extension detection**: If no extension is provided, tries common extensions

### Opening Strategy (Improved)
1. **VSCode native method**: Uses `vscode.env.openExternal()` first
2. **System commands**: Falls back to platform-specific commands (`open`, `start`, `xdg-open`)
3. **VSCode fallback**: If system opening fails, opens the file within VSCode

## Installation

1. Install from the VSCode Marketplace
2. Open any `.writerly` or `.wly` file
3. Start using the file navigation features immediately

## Development

### Building from Source

```bash
# Clone the repository
git clone https://github.com/vistuleB/writerly-vscode-extension.git

# Install dependencies
cd writerly-vscode-extension
npm install

# Compile TypeScript
npm run compile

# Package the extension
npm run vscode:prepublish
```

### Project Structure

```
├── src/
│   ├── extension.ts       # Main extension entry point
│   ├── validator.ts       # Document validation
│   ├── fileOpener.ts      # File opening functionality (improved)
│   └── hoverProvider.ts   # Hover preview provider
├── syntaxes/
│   └── writerly.json      # Language grammar definition
├── examples/
│   └── demo.writerly      # Example file with demos
├── test-improved.writerly # Test file for improved functionality
└── package.json           # Extension manifest
```



## Configuration

The extension works out of the box with no configuration required. File paths are automatically detected and resolved based on your workspace and document structure.
