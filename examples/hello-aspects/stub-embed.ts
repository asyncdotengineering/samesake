export function stubEmbed(text: string, dim: number): number[] {
  const out = new Array(dim).fill(0);
  for (let i = 0; i < text.length; i++) {
    out[i % dim] = (out[i % dim]! + text.charCodeAt(i) * 0.001) % 1;
  }
  const norm = Math.sqrt(out.reduce((sum, value) => sum + value * value, 0)) || 1;
  return out.map((value) => value / norm);
}
