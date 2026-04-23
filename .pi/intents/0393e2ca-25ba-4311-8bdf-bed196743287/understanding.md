Reviewing: Terse extension 4th rework - bug fix complete

Fix verified: `.startsWith(".pi/")` now correctly:
- Blocks files like ".pi-notes.md" in root
- Allows files inside ".pi/intents/"

All 10 success criteria satisfied:
✓ SC#1: Extension structure (4 files)
✓ SC#2: Skill file with compression rules
✓ SC#3: Default activation via before_agent_start
✓ SC#4: Ctrl+T hotkey
✓ SC#5: /terse commands
✓ SC#6: File write interception via tool_call
✓ SC#7: Agent integration (descriptions updated)
✓ SC#8: Status badge via setStatus
✓ SC#9: No regression (17 tests, TypeScript clean)
✓ SC#10: README documentation

Tests: 17 (13 original + 4 before_agent_start tests)
No residue, no skipped tests, no bugs found

Implementation is complete and correct.
