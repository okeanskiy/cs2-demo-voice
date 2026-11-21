// Source 2 demo framing and the few messages needed to build a voice roster.
const CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const DEMO = { stop: 0, header: 1, stringTables: 6, packet: 7, signon: 8, fullPacket: 13, compressed: 64 };
const NET = { createTable: 44, updateTable: 45, voice: 47, clearTables: 51, eventList: 205, event: 207, endRoster: 375 };
const PACKET_TYPES = new Set([DEMO.header, DEMO.stringTables, DEMO.packet, DEMO.signon, DEMO.fullPacket]);
const UBITVAR_WIDTHS = [0, 4, 8, 28];
const decoder = new TextDecoder();

function invalidDemo() {
  return new Error("The demo is incomplete or contains data this reader cannot decode.");
}

class Bytes {
  constructor(data) {
    this.data = data;
    this.offset = 0;
  }

  byte() {
    if (this.offset >= this.data.length) throw invalidDemo();
    return this.data[this.offset++];
  }

  varint() {
    let value = 0;
    for (let shift = 0; shift <= 28; shift += 7) {
      const byte = this.byte();
      if (shift === 28 && byte > 15) throw invalidDemo();
      value += (byte & 127) * 2 ** shift;
      if (byte < 128) return value;
    }
    throw invalidDemo();
  }

  take(size) {
    if (size > this.data.length - this.offset) throw invalidDemo();
    const start = this.offset;
    this.offset += size;
    return this.data.subarray(start, this.offset);
  }
}

class Bits {
  constructor(data) {
    this.data = data;
    this.offset = 0;
    this.length = data.length * 8;
  }

  read(count) {
    if (this.offset + count > this.length) throw invalidDemo();
    let value = 0;
    for (let shift = 0; count > 0;) {
      const bit = this.offset % 8;
      const width = Math.min(8 - bit, count);
      value |= ((this.data[this.offset >> 3] >> bit) & ((1 << width) - 1)) << shift;
      this.offset += width;
      count -= width;
      shift += width;
    }
    return value >>> 0;
  }

  ubitvar() {
    const first = this.read(6);
    const extra = UBITVAR_WIDTHS[first >> 4];
    return ((first & 15) | (this.read(extra) << 4)) >>> 0;
  }

  varint() {
    let value = 0;
    for (let shift = 0; shift <= 28; shift += 7) {
      const byte = this.read(8);
      if (shift === 28 && byte > 15) throw invalidDemo();
      value += (byte & 127) * 2 ** shift;
      if (byte < 128) return value;
    }
    throw invalidDemo();
  }

  bytes(count) {
    if (count > this.length - this.offset) throw invalidDemo();
    const result = new Uint8Array(Math.ceil(count / 8));
    for (let index = 0; index < result.length; index++) {
      result[index] = this.read(Math.min(count - index * 8, 8));
    }
    return result;
  }

  cstring() {
    const result = [];
    for (let byte = this.read(8); byte !== 0; byte = this.read(8)) {
      if (result.length >= 4096) throw invalidDemo();
      result.push(byte);
    }
    return result;
  }
}

function snappy(data) {
  const input = new Bytes(data);
  const size = input.varint();
  if (size > MAX_FRAME_BYTES) throw invalidDemo();
  const result = new Uint8Array(size);
  let out = 0;

  while (input.offset < data.length) {
    const tag = input.byte();
    const kind = tag & 3;
    if (kind === 0) {
      let length = tag >> 2;
      if (length >= 60) {
        const width = length - 59;
        length = 0;
        for (let i = 0; i < width; i++) length += input.byte() * 2 ** (i * 8);
      }
      length++;
      if (length > size - out) throw invalidDemo();
      result.set(input.take(length), out);
      out += length;
      continue;
    }

    const length = kind === 1 ? 4 + ((tag >> 2) & 7) : 1 + (tag >> 2);
    let distance = 0;
    if (kind === 1) {
      distance = ((tag & 224) << 3) + input.byte();
    } else {
      const width = kind === 2 ? 2 : 4;
      for (let i = 0; i < width; i++) distance += input.byte() * 2 ** (i * 8);
    }
    if (!distance || distance > out || length > size - out) throw invalidDemo();
    for (let i = 0; i < length; i++, out++) result[out] = result[out - distance];
  }

  if (out !== size) throw invalidDemo();
  return result;
}

// Protobuf scalars retain their full width so Steam IDs can be compared exactly.
function* fields(data) {
  if (!data) return;
  const input = new Bytes(data);
  while (input.offset < data.length) {
    const tag = input.varint();
    const field = tag >>> 3;
    if (!field) throw invalidDemo();
    switch (tag & 7) {
      case 0: {
        let value = 0n;
        for (let shift = 0n; ; shift += 7n) {
          const byte = input.byte();
          if (shift === 63n && byte > 1) throw invalidDemo();
          value |= BigInt(byte & 127) << shift;
          if (byte < 128) break;
        }
        yield [field, value];
        break;
      }
      case 1:
        yield [field, input.take(8)];
        break;
      case 2:
        yield [field, input.take(input.varint())];
        break;
      case 5:
        input.take(4);
        break;
      default:
        throw invalidDemo();
    }
  }
}

const mapFields = data => new Map(fields(data));
const text = data => data instanceof Uint8Array ? decoder.decode(data) : "";
const integer = (data, fallback = 0) => typeof data === "bigint" ? Number(BigInt.asIntN(32, data)) : fallback;
const idString = data => data instanceof Uint8Array && data.length === 8
  ? new DataView(data.buffer, data.byteOffset, 8).getBigUint64(0, true).toString()
  : typeof data === "bigint" ? data.toString() : "0";

function eachMessage(data, field) {
  return [...fields(data)].filter(([key]) => key === field).map(([, value]) => value);
}

function playable(side) {
  return side === 2 || side === 3;
}

function voiceSlot(slot) {
  return slot >= 0 && slot < 64;
}

function playerInfo(data, slot) {
  if (!data?.length || !voiceSlot(slot)) return;
  const info = mapFields(data);
  const name = text(info.get(1));
  const steamId = idString(info.get(4) ?? info.get(2));
  if (!name || steamId === "0" || integer(info.get(5)) || integer(info.get(6))) return;
  return { slot, name, steamId, userId: integer(info.get(3), -1) & 65535 };
}

function readTableUpdate(data, count, table, update) {
  if (count < 0 || count > 4096) throw invalidDemo();
  const bits = new Bits(data);
  const history = [];
  let index = -1;
  for (let i = 0; i < count; i++) {
    index += bits.read(1) ? 1 : 2 + bits.varint();
    let key = table.keys.get(index) ?? [];
    if (bits.read(1)) {
      if (bits.read(1)) {
        const position = bits.read(5);
        const length = bits.read(5);
        key = (history[Math.max(0, i - 32) + position] ?? []).slice(0, length).concat(bits.cstring());
      } else {
        key = bits.cstring();
      }
      table.keys.set(index, key);
    }
    history.push(key);

    if (bits.read(1)) {
      const compressed = !table.fixedSize && (table.flags & 1) && bits.read(1);
      const length = table.fixedSize ? table.sizeBits : 8 * (table.varint ? bits.ubitvar() : bits.read(17));
      const bytes = bits.bytes(length);
      update(compressed ? snappy(bytes) : bytes, index);
    }
  }
}

function createRosterReader() {
  let map = "";
  let isCs2 = false;
  let tableCount = 0;
  let userTable;
  let playersAtEnd = [];
  let voicePackets = 0;
  const seenPlayers = new Map();
  const teamsByUserId = new Map();
  const descriptors = new Map();
  const playersBySlot = new Map();
  const voicesBySlot = new Map();

  function rememberPlayer(data, slot) {
    const player = playerInfo(data, slot);
    if (!player) return;
    const last = seenPlayers.get(slot);
    if (!last || last.userId !== player.userId || last.name !== player.name) {
      seenPlayers.set(slot, player);
    }
    const ids = playersBySlot.get(slot) ?? new Set();
    ids.add(player.steamId);
    playersBySlot.set(slot, ids);
  }

  function readTables(data) {
    for (const entry of eachMessage(data, 1)) {
      const table = mapFields(entry);
      if (text(table.get(1)) !== "userinfo") continue;
      const items = eachMessage(entry, 2);
      items.forEach((item, slot) => rememberPlayer(mapFields(item).get(2), slot));
    }
  }

  function readMessage(type, data) {
    switch (type) {
      case NET.createTable: {
        const table = mapFields(data);
        const id = tableCount++;
        if (text(table.get(1)) !== "userinfo") break;
        userTable = {
          id, fixedSize: integer(table.get(3)), sizeBits: integer(table.get(5)),
          flags: integer(table.get(6)), varint: integer(table.get(10)), keys: new Map()
        };
        const bytes = table.get(7) ?? new Uint8Array();
        readTableUpdate(integer(table.get(9)) ? snappy(bytes) : bytes, integer(table.get(2)), userTable, rememberPlayer);
        break;
      }
      case NET.updateTable: {
        if (!userTable) break;
        const table = mapFields(data);
        if (integer(table.get(1)) !== userTable.id) break;
        readTableUpdate(table.get(3) ?? new Uint8Array(), integer(table.get(2)), userTable, rememberPlayer);
        break;
      }
      case NET.clearTables:
        tableCount = 0;
        userTable = undefined;
        break;
      case NET.eventList:
        for (const descriptor of eachMessage(data, 1)) {
          const event = mapFields(descriptor);
          if (text(event.get(2)) !== "player_team") continue;
          const keys = eachMessage(descriptor, 3).map(key => text(mapFields(key).get(2)));
          descriptors.set(integer(event.get(1)), { user: keys.indexOf("userid"), team: keys.indexOf("team") });
        }
        break;
      case NET.event: {
        const event = mapFields(data);
        const names = descriptors.get(integer(event.get(2)));
        if (!names) break;
        const keys = eachMessage(data, 3);
        const id = integer(mapFields(keys[names.user]).get(5), -1) & 65535;
        const team = integer(mapFields(keys[names.team]).get(6));
        if (id !== 65535 && playable(team)) teamsByUserId.set(id, team);
        break;
      }
      case NET.endRoster: {
        const roster = eachMessage(data, 1).map(entry => {
          const player = mapFields(entry);
          return {
            slot: integer(player.get(1), -1), name: text(player.get(3)), side: integer(player.get(4)),
            steamId: idString(player.get(2)), bot: integer(player.get(8))
          };
        }).filter(player => voiceSlot(player.slot) && playable(player.side) && player.name && !player.bot);
        if (roster.length) playersAtEnd = roster;
        break;
      }
      case NET.voice: {
        const voice = mapFields(data);
        if (integer(voice.get(9)) || !mapFields(voice.get(1)).get(2)?.length) break;
        const entity = integer(voice.get(8), -1);
        const slot = entity > 0 ? entity - 1 : integer(voice.get(2), -1);
        if (!voiceSlot(slot)) break;
        voicePackets++;
        voicesBySlot.set(slot, (voicesBySlot.get(slot) ?? 0) + 1);
        break;
      }
    }
  }

  function readPacket(data) {
    const packet = mapFields(data).get(3);
    if (!packet) return;
    const bits = new Bits(packet);
    while (bits.length - bits.offset >= 14) {
      const type = bits.ubitvar();
      const size = bits.varint() * 8;
      if (size > bits.length - bits.offset) throw invalidDemo();
      switch (type) {
        case NET.createTable: case NET.updateTable: case NET.clearTables: case NET.eventList:
        case NET.event: case NET.endRoster: case NET.voice:
          readMessage(type, bits.bytes(size));
          break;
        default:
          bits.offset += size;
      }
    }
  }

  return {
    read(type, data) {
      switch (type) {
        case DEMO.header: {
          const header = mapFields(data);
          map = text(header.get(5));
          isCs2 = /(?:^|[/\\])csgo[/\\]?$/i.test(text(header.get(6))) || text(header.get(14)).toLowerCase() === "cs2";
          if (!isCs2) throw new Error("Choose a Counter-Strike 2 .dem file.");
          break;
        }
        case DEMO.stringTables:
          readTables(data);
          break;
        case DEMO.fullPacket: {
          const packet = mapFields(data);
          readTables(packet.get(1));
          readPacket(packet.get(2));
          break;
        }
        case DEMO.packet: case DEMO.signon:
          readPacket(data);
          break;
      }
    },

    result() {
      if (!isCs2) throw new Error("The file is missing a Counter-Strike 2 demo header.");
      const roster = new Map(playersAtEnd.map(player => [player.slot, player]));
      for (const player of seenPlayers.values()) {
        const side = teamsByUserId.get(player.userId);
        if (!roster.has(player.slot) && (side || voicesBySlot.has(player.slot))) {
          roster.set(player.slot, { ...player, side: side ?? 0 });
        }
      }
      for (const slot of voicesBySlot.keys()) {
        if (!roster.has(slot)) roster.set(slot, { slot, name: "Player " + (slot + 1), side: 0 });
      }

      const players = [...roster.values()].sort((a, b) => a.slot - b.slot).map(player => ({
        slot: player.slot, name: player.name, side: player.side,
        spoke: voicesBySlot.has(player.slot), slotReused: (playersBySlot.get(player.slot)?.size ?? 0) > 1
      }));
      if (!players.length) throw new Error("No player roster or voice chat could be found in this demo.");
      return { map, players, voicePackets };
    }
  };
}

async function parseDemo(file, onProgress = () => {}) {
  const magic = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (magic[0] === 0x28 && magic[1] === 0xb5 && magic[2] === 0x2f && magic[3] === 0xfd) {
    throw new Error("Extract the .dem from the FACEIT .zst archive first, then open the .dem.");
  }
  if (text(magic) !== "PBDEMS2\0" || file.size < 16) {
    throw new Error("Choose a Counter-Strike 2 .dem file.");
  }

  const reader = createRosterReader();
  let offset = 16;
  while (offset < file.size) {
    const chunkStart = offset;
    const chunk = new Uint8Array(await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer());
    const input = new Bytes(chunk);
    while (input.offset < chunk.length) {
      // A maximum of three five-byte varints make up a frame header.
      if (chunk.length - input.offset < 15 && offset + chunk.length < file.size) break;
      const command = input.varint();
      const type = command & ~DEMO.compressed;
      input.varint(); // Demo tick
      const size = input.varint();
      if (type === DEMO.stop) return reader.result();
      const start = offset + input.offset;
      const end = start + size;
      if (end > file.size || size > MAX_FRAME_BYTES) throw invalidDemo();
      if (PACKET_TYPES.has(type)) {
        const data = end <= offset + chunk.length
          ? chunk.subarray(input.offset, input.offset + size)
          : new Uint8Array(await file.slice(start, end).arrayBuffer());
        reader.read(type, command & DEMO.compressed ? snappy(data) : data);
      }

      if (end > offset + chunk.length) {
        offset = end;
        break;
      }
      input.offset += size;
    }
    if (offset === chunkStart) offset += input.offset;
    onProgress(offset / file.size);
  }
  return reader.result();
}
