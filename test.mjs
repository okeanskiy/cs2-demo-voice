import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const sources = ["parser.js", "voice-command.js"].map(path =>
  readFileSync(new URL("./src/" + path, import.meta.url), "utf8")
);
const { parseDemo, voiceCommand } = vm.runInNewContext(
  sources.join("\n") + "\n({parseDemo, voiceCommand})", { TextDecoder, Uint8Array, DataView, Error, RangeError }
);

function varint(value) {
  const bytes = [];
  do {
    const byte = value % 128;
    value = Math.floor(value / 128);
    bytes.push(byte | (value ? 128 : 0));
  } while (value);
  return Buffer.from(bytes);
}

function number(field, value) {
  return Buffer.concat([varint(field * 8), varint(value)]);
}

function bytes(field, data) {
  const value = Buffer.from(data);
  return Buffer.concat([varint(field * 8 + 2), varint(value.length), value]);
}

function frame(type, data) {
  return Buffer.concat([varint(type), varint(0), varint(data.length), data]);
}

function packet(messages) {
  const payload = [];
  let position = 0;
  function bits(value, width) {
    for (let index = 0; index < width; index++, position++) {
      payload[position >> 3] = (payload[position >> 3] ?? 0) | (((value >>> index) & 1) << (position % 8));
    }
  }

  for (const [type, content] of messages) {
    assert.ok(type >= 16 && type < 4096);
    const wide = type >= 256;
    bits((type & 15) | (wide ? 32 : 16), 6);
    bits(type >> 4, wide ? 8 : 4);
    for (const byte of varint(content.length)) bits(byte, 8);
    for (const byte of content) bits(byte, 8);
  }
  return bytes(3, payload);
}

function snappyLiteral(data) {
  assert.ok(data.length > 0 && data.length <= 256);
  const tag = data.length <= 60 ? [(data.length - 1) * 4] : [240, data.length - 1];
  return Buffer.concat([varint(data.length), Buffer.from(tag), data]);
}

function fakeDemo(includeVoice) {
  const roster = Buffer.concat([
    bytes(1, Buffer.concat([number(1, 0), bytes(3, "Player A"), number(4, 3)])),
    bytes(1, Buffer.concat([number(1, 40), bytes(3, "Player B"), number(4, 2)])),
    bytes(1, Buffer.concat([number(1, 2), bytes(3, "Bot A"), number(4, 3), number(8, 1)]))
  ]);
  const messages = [[375, roster]];
  if (includeVoice) {
    const audio = bytes(1, bytes(2, [7, 8, 9]));
    messages.push([47, Buffer.concat([audio, number(8, 41)])]);
    messages.push([47, Buffer.concat([audio, number(2, 0)])]);
  }
  const payload = packet(messages);
  const header = frame(1, Buffer.concat([bytes(5, "de_test"), bytes(6, "/cs2/game/csgo")]));
  const prefix = [Buffer.from("PBDEMS2\0"), Buffer.alloc(8), header];
  const unused = frame(4, Buffer.alloc(8 * 1024 * 1024 - prefix.reduce((size, part) => size + part.length, 0)));
  const body = frame(7 | 64, snappyLiteral(payload));
  return new Blob([...prefix, unused, body, frame(0, Buffer.alloc(0))]);
}

test("reads a compressed roster after a chunk boundary and maps both voice message layouts", async () => {
  const roster = await parseDemo(fakeDemo(true));
  assert.equal(roster.map, "de_test");
  assert.equal(roster.voicePackets, 2);
  assert.equal(JSON.stringify(roster.players.map(player => [player.slot, player.side, player.spoke])),
    JSON.stringify([[0, 3, true], [40, 2, true]]));
});

test("returns the roster from a demo without recorded voice", async () => {
  const roster = await parseDemo(fakeDemo(false));
  assert.equal(roster.players.length, 2);
  assert.equal(roster.voicePackets, 0);
});

test("rejects invalid demos and gives instructions for FACEIT archives", async () => {
  await assert.rejects(parseDemo(new Blob(["HL2DEMO\0"])), /Choose a Counter-Strike 2/);
  await assert.rejects(parseDemo(new Blob([new Uint8Array([0x28, 0xb5, 0x2f, 0xfd])])), /Extract the .dem/);
});

test("uses signed, independent bitfields for all 64 slots", () => {
  assert.equal(voiceCommand([0, 31, 32, 63, 63]), "tv_listen_voice_indices -2147483647; tv_listen_voice_indices_h -2147483647");
  assert.equal(voiceCommand([1, 4, 5, 6, 8]), "tv_listen_voice_indices 370; tv_listen_voice_indices_h 0");
  assert.throws(() => voiceCommand([64]), /Invalid voice slot/);
});
