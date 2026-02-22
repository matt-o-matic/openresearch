import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFns = vi.hoisted(() => {
  const pdfParse = vi.fn();
  const mammothExtractRawText = vi.fn();
  const xlsxRead = vi.fn();
  const xlsxSheetToJson = vi.fn();

  return {
    pdfParse,
    mammothExtractRawText,
    xlsxRead,
    xlsxSheetToJson,
  };
});

vi.mock("pdf-parse", () => ({
  default: mockFns.pdfParse,
}));

vi.mock("mammoth", () => ({
  default: {
    extractRawText: mockFns.mammothExtractRawText,
  },
  extractRawText: mockFns.mammothExtractRawText,
}));

vi.mock("xlsx", () => ({
  read: mockFns.xlsxRead,
  utils: {
    sheet_to_json: mockFns.xlsxSheetToJson,
  },
}));

import { extractDocumentText } from "./document-extract.js";

describe("document extraction", () => {
  beforeEach(() => {
    mockFns.pdfParse.mockReset();
    mockFns.mammothExtractRawText.mockReset();
    mockFns.xlsxRead.mockReset();
    mockFns.xlsxSheetToJson.mockReset();
  });

  it("extracts text from PDFs", async () => {
    mockFns.pdfParse.mockResolvedValue({ text: "PDF body text" });

    const out = await extractDocumentText({
      body: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]),
      url: "https://example.com/report.pdf",
      contentType: "application/pdf",
    });

    expect(out.ok).toBe(true);
    expect(out.method).toBe("pdf");
    expect(out.text).toBe("PDF body text");
    expect(mockFns.pdfParse).toHaveBeenCalledTimes(1);
    expect(mockFns.pdfParse).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.any(Buffer),
        verbosity: 0,
      })
    );
  });

  it("extracts text from DOCX", async () => {
    mockFns.mammothExtractRawText.mockResolvedValue({ value: "DOCX content" });

    const out = await extractDocumentText({
      body: new Uint8Array([1, 2, 3, 4]),
      url: "https://example.com/file.docx",
      contentType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });

    expect(out.ok).toBe(true);
    expect(out.method).toBe("docx");
    expect(out.text).toBe("DOCX content");
    expect(mockFns.mammothExtractRawText).toHaveBeenCalledTimes(1);
  });

  it("extracts text from XLSX", async () => {
    mockFns.xlsxRead.mockReturnValue({
      SheetNames: ["Summary"],
      Sheets: { Summary: { A1: { v: "Header" } } },
    });
    mockFns.xlsxSheetToJson.mockReturnValue([
      ["Header", "Value"],
      ["alpha", "beta"],
    ]);

    const out = await extractDocumentText({
      body: new Uint8Array([7, 8, 9]),
      url: "https://example.com/data.xlsx",
      contentType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    expect(out.ok).toBe(true);
    expect(out.method).toBe("excel");
    expect(out.text).toContain("## Summary");
    expect(out.text).toContain("Header | Value");
    expect(out.text).toContain("alpha | beta");
    expect(mockFns.xlsxRead).toHaveBeenCalledTimes(1);
  });

  it("returns structured parser failure for binary docs", async () => {
    mockFns.pdfParse.mockRejectedValue(new Error("parse failed"));

    const out = await extractDocumentText({
      body: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]),
      url: "https://example.com/broken.pdf",
      contentType: "application/pdf",
    });

    expect(out.ok).toBe(false);
    expect(out.method).toBe("pdf");
    expect(out.error).toContain("parse failed");
  });

  it("keeps HTML on readability/dom-text path", async () => {
    const html = `
      <html>
        <head><title>Example</title></head>
        <body><article><p>Hello from html content.</p></article></body>
      </html>
    `;
    const out = await extractDocumentText({
      body: new TextEncoder().encode(html),
      url: "https://example.com/page.html",
      contentType: "text/html",
    });

    expect(out.ok).toBe(true);
    expect(["readability", "dom-text"]).toContain(out.method);
    expect(out.text.toLowerCase()).toContain("hello from html content");
  });
});
