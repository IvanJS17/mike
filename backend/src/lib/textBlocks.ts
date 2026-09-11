export function extractDelimitedBlock(
  text: string,
  openTag: string,
  closeTag: string,
): string | null {
  const openIndex = text.indexOf(openTag);
  if (openIndex < 0) return null;
  const contentStart = openIndex + openTag.length;
  const closeIndex = text.indexOf(closeTag, contentStart);
  if (closeIndex < 0) return null;
  return text.slice(contentStart, closeIndex).trim();
}
