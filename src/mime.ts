/** File-kind tables shared by the file review and archive reader. */

export const documentMimeTypes: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  odt: "application/vnd.oasis.opendocument.text",
  rtf: "application/rtf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odp: "application/vnd.oasis.opendocument.presentation",
};

export const imageMimeTypes: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

export const dataAssetExtensions = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "tif", "tiff", "avif", "heic",
  "ttf", "otf", "woff", "woff2", "eot", "mp3", "wav", "ogg", "m4a", "flac", "mp4", "mov", "webm",
]);

export const nativeProgramExtensions = new Set([
  "exe", "dll", "so", "dylib", "bin", "elf", "o", "a", "lib", "sys", "com", "scr", "wasm", "node",
  "msi", "app", "dmg", "deb", "rpm", "apk", "ipa",
]);

export const bytecodeExtensions = new Set(["pyc", "pyo", "class", "dex"]);

export const zipExtensions = new Set(["zip", "jar", "war", "whl", "egg", "crx", "xpi", "nupkg"]);

/** ZIP-based formats that are documents, not archives to unpack as Skill content. */
export const zipDocumentExtensions = new Set(["docx", "xlsx", "pptx", "odt", "ods", "odp"]);
