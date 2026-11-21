function voiceCommand(slots) {
  let low = 0;
  let high = 0;
  for (const slot of slots) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= 64) throw new RangeError("Invalid voice slot.");
    if (slot < 32) low |= 1 << slot;
    else high |= 1 << (slot - 32);
  }
  return "tv_listen_voice_indices " + low + "; tv_listen_voice_indices_h " + high;
}
