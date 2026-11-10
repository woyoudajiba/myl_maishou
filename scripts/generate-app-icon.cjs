// Reads the relay credential from the environment; never persists credentials.
const fs = require('node:fs/promises');
const path = require('node:path');
const prompt = `Use case: icon
Asset type: Windows desktop app icon for a Chinese product comparison workstation.
Primary request: a single polished, minimal app icon combining a shopping bag and a magnifying glass, instantly readable at 32 pixels.
Style/medium: crisp flat graphic with restrained depth, professional desktop software.
Composition/framing: centered white shopping bag silhouette, small magnifying glass integrated at lower right; generous 12 percent safe padding; fills one square tile.
Color palette: deep teal #0f766e tile, white symbol, subtle mint accent.
Scene/backdrop: uniform deep teal full bleed square background, no exterior margins.
Text: no text, no letters, no numbers.
Avoid: mockup, multiple icons, tiny detail, watermark, thick exterior shadow.`;
async function main() {
  if (!process.env.GRSAI_API_KEY) throw new Error('GRSAI_API_KEY is unavailable');
  const folder = path.resolve(__dirname, '../desktop/assets');
  await fs.mkdir(folder, { recursive: true });
  let result;
  for (const origin of ['https://grsai.dakka.com.cn', 'https://grsaiapi.com']) {
    try {
      const response = await fetch(`${origin}/v1/api/generate`, { method: 'POST',
        headers: { Authorization: `Bearer ${process.env.GRSAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-image-2.5', prompt, aspectRatio: '1024x1024', replyType: 'json' }),
        signal: AbortSignal.timeout(240000) });
      result = await response.json();
      if (!response.ok || !result.results?.[0]?.url) throw new Error(`relay HTTP ${response.status}; status ${result.status || result.code || 'unknown'}`);
      console.log(`Icon generated with gpt-image-2.5 via ${new URL(origin).hostname}`);
      break;
    } catch (error) { console.log(String(error.message).slice(0, 180)); }
  }
  if (!result?.results?.[0]?.url) throw new Error('Both relay nodes failed');
  const download = await fetch(result.results[0].url, { signal: AbortSignal.timeout(60000) });
  if (!download.ok) throw new Error(`icon download HTTP ${download.status}`);
  const sharp = require('../desktop/node_modules/sharp');
  const png = await sharp(Buffer.from(await download.arrayBuffer())).resize(1024, 1024).png().toBuffer();
  await fs.writeFile(path.join(folder, 'app-icon.png'), png);
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const buffers = await Promise.all(sizes.map(size => sharp(png).resize(size, size).png().toBuffer()));
  const header = Buffer.alloc(6 + sizes.length * 16); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  buffers.forEach((buffer, i) => { const entry = 6 + i * 16; header[entry] = sizes[i] % 256; header[entry + 1] = sizes[i] % 256;
    header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6); header.writeUInt32LE(buffer.length, entry + 8); header.writeUInt32LE(offset, entry + 12); offset += buffer.length; });
  await fs.writeFile(path.join(folder, 'app-icon.ico'), Buffer.concat([header, ...buffers]));
  await fs.writeFile(path.join(folder, 'icon-source.json'), JSON.stringify({ model: 'gpt-image-2.5', size: '1024x1024', prompt }, null, 2));
  console.log('Saved desktop/assets/app-icon.png and app-icon.ico');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
