# Path Disambiguation Manual Fixture

Use this fixture to check closest-ancestor tie-breaking for file-under-cursor
commands.

1. Open `near/chapter/rename-disambiguation.wly`.
2. Put the cursor on `assets/ambiguous-note-target.txt`.
3. Run `Writerly: Rename File Under Cursor`.
4. Enter a new file name.

Expected behavior:
- The command chooses `near/chapter/assets/ambiguous-note-target.txt`.
- VS Code shows a note that the ambiguous path was resolved by closest ancestor
  directory tie-breaking.
- The note lists `far/assets/ambiguous-note-target.txt` as the non-chosen match.

