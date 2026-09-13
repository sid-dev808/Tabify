/* ─── EXPORTERS ───
   Sheet music and TAB leave the app as SVG, PNG or PDF. All three are built
   in the browser with no external library: the SVG is rasterized onto a
   canvas, and the PDF is assembled byte by byte with the image embedded
   losslessly through CompressionStream (which emits exactly the zlib stream
   PDF's /FlateDecode expects). */

const PAGE_W = 612;      // US Letter, points
const PAGE_H = 792;
const MARGIN = 36;
const CONTENT_W = PAGE_W - MARGIN * 2;
const CONTENT_H = PAGE_H - MARGIN * 2;

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

interface Serialized { xml: string; width: number; height: number }

/** Standalone SVG markup with explicit pixel dimensions, so it rasterizes and
    opens correctly outside the app. */
export function serializeSvg(svg: SVGSVGElement): Serialized {
  const viewBox = (svg.getAttribute("viewBox") || "0 0 688 292").split(/[\s,]+/).map(Number);
  const width = viewBox[2] || 688;
  const height = viewBox[3] || 292;

  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  clone.removeAttribute("class");

  return { xml: new XMLSerializer().serializeToString(clone), width, height };
}

export function svgBlob(svg: SVGSVGElement) {
  return new Blob([serializeSvg(svg).xml], { type: "image/svg+xml;charset=utf-8" });
}

/** Draw the SVG onto a canvas at `scale`x for crisp output. */
export async function rasterize(svg: SVGSVGElement, scale = 2): Promise<HTMLCanvasElement> {
  const { xml, width, height } = serializeSvg(svg);
  const url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml;charset=utf-8" }));

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Couldn't render the notation to an image."));
      img.src = url;
    });

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function svgToPngBlob(svg: SVGSVGElement, scale = 2): Promise<Blob> {
  const canvas = await rasterize(svg, scale);
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Couldn't produce a PNG.");
  return blob;
}

/* ─── PDF ─── */

export interface PdfPage {
  /** Packed RGB, 3 bytes per pixel, no alpha. */
  rgb: Uint8Array;
  width: number;
  height: number;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  // "deflate" is the zlib-wrapped variant, which is what /FlateDecode reads.
  const stream = new Blob([bytes as unknown as BlobPart]).stream()
    .pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Assemble a PDF whose pages are each one full-page image. */
export async function buildPdf(pages: PdfPage[]): Promise<Blob> {
  if (pages.length === 0) throw new Error("Nothing to export.");

  const parts: Uint8Array[] = [];
  const encoder = new TextEncoder();
  let cursor = 0;
  const offsets: number[] = [];

  const push = (data: string | Uint8Array) => {
    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    parts.push(bytes);
    cursor += bytes.length;
  };
  const startObject = (n: number) => { offsets[n] = cursor; push(`${n} 0 obj\n`); };

  // Object numbering: 1 catalog, 2 pages, then 3 per page (page, image, content).
  const pageIds = pages.map((_, i) => 3 + i * 3);
  const totalObjects = 2 + pages.length * 3;

  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");

  startObject(1);
  push("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

  startObject(2);
  push(`<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>\nendobj\n`);

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const pageId = pageIds[i];
    const imageId = pageId + 1;
    const contentId = pageId + 2;

    // Fit the image inside the margins, preserving aspect ratio.
    const scale = Math.min(CONTENT_W / page.width, CONTENT_H / page.height);
    const drawW = page.width * scale;
    const drawH = page.height * scale;
    const originX = MARGIN + (CONTENT_W - drawW) / 2;
    const originY = PAGE_H - MARGIN - drawH;

    startObject(pageId);
    push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] `
       + `/Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>\nendobj\n`);

    const compressed = await deflate(page.rgb);
    startObject(imageId);
    push(`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} `
       + `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`);
    push(compressed);
    push("\nendstream\nendobj\n");

    const content = `q\n${drawW.toFixed(2)} 0 0 ${drawH.toFixed(2)} ${originX.toFixed(2)} ${originY.toFixed(2)} cm\n/Im0 Do\nQ\n`;
    startObject(contentId);
    push(`<< /Length ${encoder.encode(content).length} >>\nstream\n${content}endstream\nendobj\n`);
  }

  const xrefOffset = cursor;
  let xref = `xref\n0 ${totalObjects + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= totalObjects; n++) {
    xref += `${String(offsets[n] ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  push(xref);
  push(`trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return new Blob(parts as unknown as BlobPart[], { type: "application/pdf" });
}

/** Canvas region to packed RGB, compositing away any transparency onto white. */
export function canvasRegionToRgb(canvas: HTMLCanvasElement, top: number, height: number): PdfPage {
  const ctx = canvas.getContext("2d")!;
  const clampedTop = Math.max(0, Math.min(canvas.height - 1, Math.round(top)));
  const clampedHeight = Math.max(1, Math.min(canvas.height - clampedTop, Math.round(height)));
  const data = ctx.getImageData(0, clampedTop, canvas.width, clampedHeight).data;

  const rgb = new Uint8Array(canvas.width * clampedHeight * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    const alpha = data[i + 3] / 255;
    rgb[j]     = Math.round(data[i]     * alpha + 255 * (1 - alpha));
    rgb[j + 1] = Math.round(data[i + 1] * alpha + 255 * (1 - alpha));
    rgb[j + 2] = Math.round(data[i + 2] * alpha + 255 * (1 - alpha));
  }
  return { rgb, width: canvas.width, height: clampedHeight };
}

/** Choose page breaks: as much as fits, but never through a staff system. */
export function planPageBreaks(totalHeight: number, pageHeight: number, allowedBreaks: number[]): number[] {
  if (totalHeight <= pageHeight) return [0, totalHeight];
  const breaks = [0];
  const sorted = [...allowedBreaks].filter(b => b > 0 && b < totalHeight).sort((a, b) => a - b);

  let position = 0;
  let guard = 0;
  while (position < totalHeight && guard++ < 500) {
    const limit = position + pageHeight;
    if (limit >= totalHeight) break;
    const candidate = [...sorted].reverse().find(b => b > position && b <= limit);
    // No system boundary fits — fall back to a hard cut so we always terminate.
    const next = candidate ?? limit;
    breaks.push(next);
    position = next;
  }
  breaks.push(totalHeight);
  return breaks;
}

/**
 * Full SVG → PDF path. `allowedBreaksSvgY` are y positions in SVG units where a
 * page break is safe (the gaps between staff systems).
 */
export async function svgToPdfBlob(
  svg: SVGSVGElement,
  allowedBreaksSvgY: number[] = [],
  scale = 2
): Promise<Blob> {
  const canvas = await rasterize(svg, scale);
  const { height: svgHeight } = serializeSvg(svg);
  const pxPerSvgUnit = canvas.height / svgHeight;

  // How many canvas pixels fit on one page, given the width-fit scale factor.
  const pageScale = CONTENT_W / canvas.width;
  const pxPerPage = CONTENT_H / pageScale;

  const cuts = planPageBreaks(
    canvas.height,
    pxPerPage,
    allowedBreaksSvgY.map(y => y * pxPerSvgUnit)
  );

  const pages: PdfPage[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    pages.push(canvasRegionToRgb(canvas, cuts[i], cuts[i + 1] - cuts[i]));
  }
  return buildPdf(pages);
}
