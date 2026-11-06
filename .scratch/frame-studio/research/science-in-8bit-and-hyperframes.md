# Science in 8bit and HyperFrames, researched 2026-11-06

## Science in 8bit (sciencein8bit.com, @science_in_8bit)

Primary evidence, gathered from their site and their own MP4s. Reddit and X turned up nothing about them. Instagram came back unreadable. So everything below is from the site, the guide excerpts it publishes, and the files themselves.

### Measured from their files

- All four films checked carry the MP4 comment tag `Made with Remotion 4.0.535`. So the channel's films are React code rendered by Remotion, written with Claude. The Lavf60 muxer tag fits Remotion's bundled ffmpeg.
- Vertical, 540x960 or 720x1280, 30 or 60 fps, 32 to 41 s, H.264 + AAC at 48 kHz.
- Pixel grid measured from run lengths: 3 px at 540 wide (fusion), 4 px at 720 wide (car). Both mean a 180x320 logical canvas scaled up with nearest neighbour.
- Their own page-demo renderer (guide/film.js) is commented "Everything is drawn at a low resolution and scaled up with crisp, square pixels", with a 5x7 bitmap font defined as strings.
- The car film at 60 fps had no duplicate frames in a 6 s sample, so motion is smooth, not on twos: the camera glides at 60 over a 180x320 look.
- The car film measures -17.0 LUFS integrated, LRA 7.8.
- Look: limited palette per film, ordered dithering and halftone dots in skies and glows, layered parallax worlds, big arrows and force diagrams, boxed caption cards in a bitmap font at top, a VCR-style HUD ("PAUSE", "PLAY", "REWIND"), a speedometer readout. No voice over in what I sampled that I could confirm; text cards carry the story and music is the bed.

### The method (their words)

- Five steps: Define, Check, Build, Score, Post. Guide chapters: Setup, Studio ("One folder per video, reopen any of them"), Identity ("Your look, colours, characters, music mood"), Idea ("Two sources per claim, a hook, a plan"), Build ("Camera, depth, characters, text, loops"), Sound ("Original music, landing on every beat"), Check ("Every video measured before you see it"), Post, Costs, Fix-it, One day, Checklists, Glossary.
- A brief per film. Worked example fields: value sentence; facts each marked SOLID or HEDGE with sources; hook described at frame 0; beats with times; sync points by frame ("f270 stamp -> low stamp hit; f740 13th loaf lands on the beat -> three-note motif; last frame f1119 flows into f0"); assumptions.
- Beat sheet for 40 s: Hook 0-2, Setup 2-10, Turn 10-25, Payoff 25-35, Close/loop 35-40. "One idea per beat." A single reveal colour used only at the payoff.
- Hook rules: motion from frame one (the first frame is already mid-action, never a fade from blank), a visual question, specificity, a contradiction, text and image agree (3 to 8 words), an honest promise.
- Measured checks: format, duration, loudness, black frames, silence and dropouts, freeze, opening, sync (SFX vs visual event), unsynced events, loop seam, flashing, sparse/empty stretches, text in safe zones. Also 9:16 safe zones for platform UI.
- Seamless loops: last frame flows into first.
- Cover still per film, previewed in a profile grid.

### Their app, "The Animated Shorts Studio" ($49, one payment, needs a paid Claude plan)

- Desktop app with tabs Studio, Films, Metrics, Identity, Settings.
- A crew of six agents: Director, Fact-checker, Artist, Composer, Editor, QA Inspector. Rendered as a 3D office where a character works at each station. Side panel lists steps with owners, durations and AUTO approvals: Finding the scenario, Scenario picked, Planning the film, Checking the facts, Sources reviewed, Writing the title, Writing the brief, Brief approved, Drawing the scenes, Composing the sound, Rendering the film, Encoding the upload copy, Running the quality gate.
- Top bar meters: tokens, time, films. Composer at the bottom: "Your idea", with Quick test (5 s), Short (15 s), Standard length, and "Build my film". Ideas queue.
- Eight looks: pixel art, flat vector, paper cut-out, chalkboard, soft clay, blueprint, ink and watercolour, neon night.
- Their disclaimer: the channel's films were "made with the studio method, not by the app's one-click build."

### Takeaway

No secret tool. It's Claude writing Remotion code on a 180x320 canvas, disciplined by a brief, a beat sheet, frame-numbered sync points and measured QA. Our engine can do the same drawing. What we lack: a low-res pixel stage, a camera with parallax, a film brief, measured checks, and vertical-short presets.

## HyperFrames (HeyGen, Apache 2.0, 0.9 as of Oct 2026)

- HTML compositions with data-start, data-duration, data-track-index; plain `<video>`, `<img>`, `<audio>`; GSAP timelines registered in window.__timelines; nested compositions by data-composition-src; variables.
- Render: seek each frame in headless Chrome via beginFrame, encode with FFmpeg. Node 22+ and FFmpeg required. Docker for pinned determinism. Formats MP4, MOV ProRes 4444 alpha, WebM alpha, GIF, PNG sequence, HLS.
- Editor (`npx hyperframes preview`): Compositions, Assets, Design, Layers, Timeline panels; canvas drag, resize, rotate, crop; drag and trim clips, split, razor; auto-record manual edits as keyframes; audio mix with automation; Renders panel; lint in the corner; Cmd+K to describe a change; shortcuts J/K/L.
- Desktop Studio app: agent beside a live preview, "Change it by typing, pointing at the picture, drawing or commenting."
- `lint` (static) and `check` (browser pass) before render.
- Catalog of about 450 blocks and components: `add flash-through-white`, `data-chart`, caption sets. Agents pick from it rather than invent.
- Agent skills, AGENTS.md and CLAUDE.md in every new project.
- Whisper transcribe with captions, local Kokoro TTS, background removal, shader transitions, colour grading, media treatments such as CRT and halftone.
- Reported weaknesses, all from secondhand write-ups: token hungry, slower, weak on design; agents over-engineer with Three.js or Lottie until pointed at curated blocks; one developer spent 14 days on URL-to-video and got generic output; not no-code; needs FFmpeg and Node. Source: voyager.so, a competitor, so discount a little.

## Other

- weilanx-claude-videos (Remotion, open source): subtitle-driven timing, cf(n) and cw(n,'word') throw on a missing word; picture lands 6 frames before the voice; procedural SFX and BGM with ducking; style kits; contact-sheet review.
- awesomeclaude.ai: "There is no video model. The quality comes from planning, timing and review." Write style as numbers.

Sources: sciencein8bit.com, sciencein8bit.com/guide/, hyperframes.heygen.com, github.com/heygen-com/hyperframes, voyager.so/blog/hyperframes-vs-remotion, github.com/Azure12355/weilanx-claude-videos, awesomeclaude.ai/claude-motion-graphics.
