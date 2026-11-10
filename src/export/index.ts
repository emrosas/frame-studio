// Export: MP4, GIF and contact sheets, encoded in the page that draws the
// frames. Browser code; the engine never imports it, and it never imports the
// engine. See ticket 14 and docs/adr/0001-web-and-electron-targets.md.

export { AAC_PRIMING, encodeAudio, pickAudioCodec, type AudioCodecName, type AudioTrackSource } from './audio';
export { buildReport, checkSize, FrameMeter, type CheckReport, type CheckResult, type CheckStatus } from './check';
export { contactSheetFrames, contactSheetLayout, type ContactSheetLayout } from './contact-sheet';
export { readPixels, type ExportOptions, type ExportProgress, type ExportRange, type FrameCanvas, type FrameSource } from './frames';
export { exportGif, type GifResult } from './gif';
export { emptyStages, encodeVideo, exportMp4, videoConfig, type ExportStages, type Mp4Options, type Mp4Result } from './mp4';
export { RecordWriter, type PacketRecord } from './packets';
export { memorySink, type ByteSink } from './sink';
