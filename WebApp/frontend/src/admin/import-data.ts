export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false,
    closed = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
        closed = true;
      } else cell += c;
    } else if (c === '"') {
      if (cell || closed)
        throw new Error("Dấu ngoặc kép không hợp lệ trong CSV.");
      quoted = true;
    } else if (c === "," || c === "\n" || c === "\r") {
      row.push(cell);
      cell = "";
      closed = false;
      if (c !== ",") {
        rows.push(row);
        row = [];
        if (c === "\r" && text[i + 1] === "\n") i++;
      }
    } else {
      if (closed) throw new Error("Ký tự không hợp lệ sau dấu ngoặc kép.");
      cell += c;
    }
  }
  if (quoted) throw new Error("CSV thiếu dấu ngoặc kép đóng.");
  if (cell || row.length || closed) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export function tableObjects(rows: unknown[][]): Record<string, unknown>[] {
  const headers = (rows[0] ?? []).map((v) => String(v ?? "").trim());
  if (
    !headers.length ||
    headers.some((h) => !h) ||
    new Set(headers).size !== headers.length
  )
    throw new Error("Tên cột trống hoặc trùng. Hãy dùng tệp mẫu.");
  return rows.slice(1).map((row) => {
    if (row.length > headers.length)
      throw new Error("Số ô vượt quá số cột trong tiêu đề.");
    return Object.fromEntries(headers.map((h, i) => [h, row[i] ?? ""]));
  });
}
