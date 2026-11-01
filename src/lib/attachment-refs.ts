/** Build once per operation; rewrite each body in a single bounded scan. */
export function createAttachmentRewriter(replacements: ReadonlyMap<string, string>): (body: string) => string {
  type Node = { next: Map<string, Node>; value?: string };
  const root: Node = { next: new Map() };
  for (const [id, value] of replacements) {
    if (!id) continue;
    let node = root;
    // Use UTF-16 code units, matching String#indexOf/slice even for non-BMP IDs.
    for (let i = 0; i < id.length; i++) {
      const character = id[i];
      let child = node.next.get(character);
      if (!child) { child = { next: new Map() }; node.next.set(character, child); }
      node = child;
    }
    node.value = value;
  }
  const prefix = 'attachment:';
  return (body: string): string => {
    const parts: string[] = [];
    let position = 0;
    while (position < body.length) {
      const start = body.indexOf(prefix, position);
      if (start < 0) break;
      let node = root, cursor = start + prefix.length, matchEnd = -1, value: string | undefined;
      // Backup validation caps IDs at 200 code units; the trie stops at the
      // first character that cannot belong to a known ID.
      while (cursor < body.length) {
        const child = node.next.get(body[cursor]);
        if (!child) break;
        node = child; cursor += 1;
        if (node.value !== undefined) { value = node.value; matchEnd = cursor; }
      }
      if (matchEnd >= 0) {
        parts.push(body.slice(position, start), value!);
        position = matchEnd;
      } else {
        parts.push(body.slice(position, start + prefix.length));
        position = start + prefix.length;
      }
    }
    parts.push(body.slice(position));
    return parts.join('');
  };
}
