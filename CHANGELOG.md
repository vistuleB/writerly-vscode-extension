# Changelog

All notable changes to the Writerly VSCode Extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.37] - 2024-01-15

### Improved
- **Enhanced File Path Detection**
  - Improved cursor position detection
  - Better handling of quoted file paths (single, double, and backticks)
  - More accurate path extraction from text
  - Cursor can now be placed anywhere within a file path for detection

- **Reliable File Opening**
  - Primary method now uses `vscode.env.openExternal()`
  - Automatic fallback to system commands if VSCode method fails
  - VSCode in-editor fallback if both system methods fail
  - Improved Windows compatibility with better `start` command handling

- **Code Quality**
  - Simplified path detection logic without complex regex patterns
  - Removed unused methods and streamlined codebase
  - Better error handling and user feedback
  - Excluded reference implementation from TypeScript compilation

- **Documentation**
  - Added test files demonstrating improved functionality
  - Updated README with better examples
  - Better examples showing cursor flexibility

### Technical Details
- Path detection with position-based approach
- Uses segment extraction for better path detection

## [0.0.36] - 2024-01-15

### Added
- **Open File Under Cursor** functionality
  - New command: `writerly.openFileUnderCursor`
  - Keyboard shortcut: `Cmd+Shift+O` (Mac) / `Ctrl+Shift+O` (Windows/Linux)
  - Context menu integration for right-click access
  - Command Palette support: "Open File Under Cursor"

- **Smart Path Resolution**
  - Automatic detection of file paths under cursor
  - Support for quoted strings (single, double, and backticks)
  - Relative path resolution (to document and workspace)
  - Absolute path support
  - Auto-extension detection for extensionless paths

- **Multi-format File Support**
  - Images: `.png`, `.jpg`, `.jpeg`, `.gif`, `.bmp`, `.svg`, `.webp`, `.ico`
  - Documents: `.pdf`, `.txt`, `.md`, `.html`
  - Code files: `.css`, `.js`, `.ts`, `.json`, `.xml`, `.yml`, `.yaml`
  - Opens files with system default applications

- **Hover Previews**
  - File information display on hover
  - File size and modification date
  - Image preview for supported image formats
  - Quick action buttons in hover tooltip

- **Enhanced Developer Experience**
  - New TypeScript modules: `fileOpener.ts`, `hoverProvider.ts`
  - Cross-platform file opening support (macOS, Windows, Linux)
  - Comprehensive error handling and user feedback
  - Example files and documentation

### Changed
- Updated package description to reflect new file navigation features
- Added new categories: "Programming Languages"
- Enhanced README with comprehensive usage documentation
- Version bump from 0.0.35 to 0.0.36

### Dependencies
- Added `@types/cross-spawn` for better TypeScript support
- Existing `cross-spawn` dependency now used for file opening

## [0.0.35] - Previous Release

### Features
- Basic Writerly language support
- Syntax highlighting for `.writerly` and `.wly` files
- Document validation
- Language configuration and grammar support

---

## Usage Examples

### Opening Files
Place cursor on any of these and use `Cmd+Shift+O`:
- `../package.json`
- `"./images/logo.png"`
- `'../docs/readme.md'`

### Hover Information
Hover over file paths to see:
- File size and modification date  
- Image previews (for images)
- Quick open actions

## Future Enhancements

Planned features for upcoming releases:
- Support for more file formats
- Custom file opening applications
- Workspace-specific path configurations
- File search and fuzzy matching
- Integration with version control systems
