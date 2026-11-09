export type PublicationRow = { id: string; version: number };

export function publicationBatchBody(rows: readonly PublicationRow[]) {
  return {
    rows: rows.map(({ id, version }) => ({ id, version })),
    reviewed: true,
    published: true,
  };
}
