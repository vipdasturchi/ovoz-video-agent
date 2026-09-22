function writeAsciiString(buffer: Buffer, offset: number, str: string) {
  buffer.write(str, offset, "ascii");
}

export function buildWavBuffer(
  pcmBytes: Buffer,
  sampleRate = 24000,
  channels = 1,
  bitDepth = 16
): Buffer {
  const blockAlign = channels * (bitDepth / 8);
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcmBytes.length;
  const buffer = Buffer.alloc(44 + dataSize);

  writeAsciiString(buffer, 0, "RIFF");
  buffer.writeUInt32LE(36 + dataSize, 4);
  writeAsciiString(buffer, 8, "WAVE");
  writeAsciiString(buffer, 12, "fmt ");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitDepth, 34);
  writeAsciiString(buffer, 36, "data");
  buffer.writeUInt32LE(dataSize, 40);

  pcmBytes.copy(buffer, 44);
  return buffer;
}
