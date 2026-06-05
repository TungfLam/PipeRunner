import path from "path";
import type { PreviewType } from "../types/domain";

const previewByExtension: Record<string, PreviewType> = {
  mp4: "video",
  mov: "video",
  mkv: "video",
  mp3: "audio",
  wav: "audio",
  txt: "text",
  srt: "text",
  log: "text",
  json: "json",
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image"
};

export function previewTypeForPath(filePath: string): PreviewType | undefined {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return previewByExtension[ext];
}
