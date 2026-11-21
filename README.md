# CS2 Demo Voice

Open `index.html` in a current browser. Drop in a Counter-Strike 2 `.dem` file, select a team or individual players, and copy the command. With the demo loaded in CS2, paste it into the developer console. The page works offline and processes the file on your device.

Extract FACEIT `.dem.zst` archives first. The replay must contain recorded voice chat. Team buttons use the sides near the end of the demo, so a team's selected players stay the same when the replay reaches halftime. Filtering uses player slots. If two players used the same slot, both players' voices can pass the filter.

Use this command in CS2 to hear every recorded voice again.

    tv_listen_voice_indices -1; tv_listen_voice_indices_h -1

## Share or build

You can attach `index.html` to a GitHub release or serve it from the repository root with GitHub Pages. The file is self-contained.

Edit the files in `src/` and run these commands with Node.js 22 or newer. The first regenerates `index.html`. The second tests the parser and voice masks with a generated demo.

    node build.mjs
    node --test test.mjs

The reader uses Source 2 demo framing, the roster and voice network messages, and player metadata. It skips entity and animation fields. Protocol references are available in [SteamDatabase's protobuf mirror](https://github.com/SteamDatabase/Protobufs/tree/master/csgo), [the Snappy format specification](https://github.com/google/snappy/blob/main/format_description.txt), and [DemoFile.Net](https://github.com/saul/demofile-net).
