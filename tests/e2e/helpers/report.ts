import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

export type PdfOrientation = "landscape" | "portrait";

export const resolvePdfOrientation = (): PdfOrientation => {
  const raw = String(process.env.E2E_REPORT_ORIENTATION ?? "").trim().toLowerCase();
  if (raw === "portrait") return "portrait";
  return "landscape";
};

export const writePdfFromHtml = async (htmlPath: string, pdfPath?: string) => {
  if (!htmlPath || !fs.existsSync(htmlPath)) return;
  const outputPath = pdfPath ?? htmlPath.replace(/\.html$/i, ".pdf");
  const fileUrl = pathToFileURL(path.resolve(htmlPath)).toString();
  const orientation = resolvePdfOrientation();

  const browser = await chromium.launch({
    args: ["--allow-file-access-from-files"]
  });
  const page = await browser.newPage();
  await page.goto(fileUrl, { waitUntil: "networkidle" });
  await page.pdf({
    path: outputPath,
    format: "A4",
    printBackground: true,
    landscape: orientation === "landscape"
  });
  await browser.close();
};
