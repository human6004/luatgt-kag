export type ImportKind = "signs" | "questions" | "documents" | "units";

export const csvSamples: Record<ImportKind, string> = {
  signs:
    "code,name,group,meaning,source\nP.DEMO,Biển mẫu,Cấm,Nội dung cần kiểm duyệt,Nguồn cần bổ sung\n",
  questions:
    "id,chapter,question,option1,option2,answer,critical,explanation,source\nDEMO-1,Khái niệm và quy tắc,Câu hỏi mẫu,Phương án 1,Phương án 2,1,false,Giải thích mẫu,Nguồn cần bổ sung\n",
  documents: "id,name,type,effective\nDOC-DEMO,Văn bản mẫu,Nghị định,2025-01-01\n",
  units:
    "externalId,doc_id,parent_id,unit_type,so_hieu,text,order\nUNIT-DEMO,DOC-DEMO,,article,Điều 1,Nội dung mẫu,1\n",
};

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
      if (cell || closed) throw new Error("Dấu ngoặc kép không hợp lệ trong CSV.");
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
  if (!headers.length || headers.some((h) => !h) || new Set(headers).size !== headers.length)
    throw new Error("Tên cột trống hoặc trùng. Hãy dùng tệp mẫu.");
  return rows.slice(1).map((row) => {
    if (row.length > headers.length) throw new Error("Số ô vượt quá số cột trong tiêu đề.");
    return Object.fromEntries(headers.map((h, i) => [h, row[i] ?? ""]));
  });
}
