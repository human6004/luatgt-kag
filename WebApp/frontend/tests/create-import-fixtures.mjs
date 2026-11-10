import JSZip from "jszip";
import { writeFile, mkdir } from "node:fs/promises";
await mkdir("tests/fixtures", { recursive: true });
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const zip = new JSZip();
zip.file("images/P.DEMO.png", png);
zip.file("images/P.UNMATCHED.png", png);
await writeFile("tests/fixtures/sign-images.zip", await zip.generateAsync({ type: "nodebuffer" }));
const workbook = new JSZip();
workbook.file(
  "[Content_Types].xml",
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
);
workbook.file(
  "_rels/.rels",
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
);
workbook.file(
  "xl/workbook.xml",
  '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Signs" sheetId="1" r:id="rId1"/></sheets></workbook>',
);
workbook.file(
  "xl/_rels/workbook.xml.rels",
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
);
const data = [
  ["code", "name", "group", "meaning", "source"],
  ["P.DEMO", "Biển Excel cập nhật", "Cấm", "Nội dung kiểm thử", "Nguồn kiểm thử"],
];
workbook.file(
  "xl/worksheets/sheet1.xml",
  `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${data.map((row, i) => `<row r="${i + 1}">${row.map((v, j) => `<c r="${String.fromCharCode(65 + j)}${i + 1}" t="inlineStr"><is><t>${v}</t></is></c>`).join("")}</row>`).join("")}</sheetData></worksheet>`,
);
await writeFile("tests/fixtures/signs.xlsx", await workbook.generateAsync({ type: "nodebuffer" }));
await writeFile(
  "tests/fixtures/questions.json",
  JSON.stringify([
    {
      id: "IMPORT-Q1",
      chapter: "Biển báo",
      question: "Câu hỏi kiểm thử nhập hàng loạt?",
      options: ["Phương án 1", "Phương án 2"],
      answer: 0,
      critical: false,
      explanation: "Giải thích kiểm thử",
      source: "Nguồn kiểm thử",
    },
  ]),
);
await writeFile(
  "tests/fixtures/documents.csv",
  "id,name,type,effective\nIMPORT-DOC1,Văn bản kiểm thử,Luật,2025-01-01\n",
);
console.log("Import fixtures created");
