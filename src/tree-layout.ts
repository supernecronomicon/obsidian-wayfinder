/** Split dependency layers into visual rows, preserving layer and ticket order.
 * CSS owns card sizes/spacing; edges read the resulting DOM geometry in tree.ts.
 */
export function wrapTicketRows<T>(layers: readonly (readonly T[])[], limit: number): T[][] {
  return layers.flatMap((layer) => {
    if (layer.length === 0) return [];
    const width = Number.isSafeInteger(limit) && limit > 0 ? limit : layer.length;
    const rows: T[][] = [];
    for (let start = 0; start < layer.length; start += width) {
      rows.push(layer.slice(start, start + width));
    }
    return rows;
  });
}
