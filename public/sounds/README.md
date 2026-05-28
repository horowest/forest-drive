# Driving Sound Assets

Place your real audio files here to enable the driving sound system in the game.

Required filenames:
- `engine-loop.mp3` — engine idle/rev loop
- `road-loop.mp3` — subtle road/rumble loop for off-road sliding
- `skid-loop.mp3` — drift/tire screech loop
- `crash.wav` — crash impact sound effect

The game loads these assets from `/sounds/` automatically, so no code changes are needed after adding the files.

Recommended:
- Use short loopable MP3 files for engine, road, and skid.
- Use a punchy WAV for crash.
- Keep sample rates consistent (44.1kHz or 48kHz).
