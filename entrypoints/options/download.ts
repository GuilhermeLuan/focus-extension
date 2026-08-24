/** Download a small local text file without requesting the browser downloads permission. */
export function downloadJsonFile(fileName: string, content: string): void {
  const blob = new Blob([content], { type: "application/json;charset=utf-8" });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = fileName;
  link.style.display = "none";

  try {
    document.body?.appendChild(link);
    link.click();
  } finally {
    link.remove();
    try {
      URL.revokeObjectURL(objectUrl);
    } catch {
      // Revocation is best-effort cleanup and must not hide the download error.
    }
  }
}

export const downloadTextFile = downloadJsonFile;
